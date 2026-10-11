-- MissionFlow shared core — DB-level guards (DRAFT v0.2)
-- v0.2: chain epoch + mf_demo_reset (G10), escalation guards (G3), sign/transmit consistency (G17),
--       AI input grounding (G19), gate round monotonic (G11), CLOSED/escalation backstop (G3/G15).
-- Run AFTER the Drizzle-generated schema migration, as the owner role (mf_owner).
-- Spec §5.3: append-only tables, hash-chained audit log, app role without UPDATE/DELETE.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------------
-- 1. Append-only guard (UPDATE / DELETE / TRUNCATE all raise)
--    Escape hatch for demo reset ONLY: session_user = 'mf_owner' AND
--    SET LOCAL mf.allow_reset = 'on' inside the reset transaction (spec §5.3.5).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION mf_block_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'TRUNCATE'
     AND session_user = 'mf_owner'
     AND coalesce(current_setting('mf.allow_reset', true), 'off') = 'on' THEN
    RETURN NULL;
  END IF;
  RAISE EXCEPTION 'MissionFlow: % on % is not allowed (append-only table)', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'insufficient_privilege';
END $$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'audit_event', 'disposition', 'ai_artifact', 'ai_verification',
    'suspense_plan', 'suspense_resolution', 'document_version'
  ] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I_no_update_delete ON %I', t, t);
    EXECUTE format('CREATE TRIGGER %I_no_update_delete BEFORE UPDATE OR DELETE ON %I
                    FOR EACH ROW EXECUTE FUNCTION mf_block_mutation()', t, t);
    EXECUTE format('DROP TRIGGER IF EXISTS %I_no_truncate ON %I', t, t);
    EXECUTE format('CREATE TRIGGER %I_no_truncate BEFORE TRUNCATE ON %I
                    FOR EACH STATEMENT EXECUTE FUNCTION mf_block_mutation()', t, t);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 2. Audit hash chain. seq is (re)assigned AFTER taking the chain lock so that
--    seq order == chain order even under concurrent inserts.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION mf_audit_canonical(e audit_event) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT jsonb_build_object(
    'seq', e.seq, 'id', e.id, 'occurred_at', to_char(e.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'actor_type', e.actor_type, 'actor_user_id', e.actor_user_id, 'acting_role', e.acting_role,
    'chain_epoch', e.chain_epoch, 'event_type', e.event_type, 'tasker_id', e.tasker_id, 'entity_type', e.entity_type,
    'entity_id', e.entity_id, 'payload', e.payload, 'ai_artifact_id', e.ai_artifact_id,
    'request_id', e.request_id
  )::text
$$;

CREATE OR REPLACE FUNCTION mf_audit_chain() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE last_hash text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('mf_audit_chain'));
  NEW.seq := nextval(pg_get_serial_sequence('audit_event', 'seq'));
  SELECT current_epoch INTO NEW.chain_epoch FROM audit_chain_meta WHERE id = 1;
  NEW.chain_epoch := coalesce(NEW.chain_epoch, 1);
  SELECT hash INTO last_hash FROM audit_event ORDER BY seq DESC LIMIT 1;
  NEW.prev_hash := coalesce(last_hash, repeat('0', 64));
  NEW.hash := encode(digest(NEW.prev_hash || mf_audit_canonical(NEW), 'sha256'), 'hex');
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS audit_event_chain ON audit_event;
CREATE TRIGGER audit_event_chain BEFORE INSERT ON audit_event
  FOR EACH ROW EXECUTE FUNCTION mf_audit_chain();

-- Returns NULL when the chain is intact, else the first broken seq. Used by audit.verifyChain().
CREATE OR REPLACE FUNCTION mf_verify_audit_chain() RETURNS bigint
LANGUAGE plpgsql STABLE AS $$
DECLARE r audit_event; expected_prev text := repeat('0', 64);
BEGIN
  FOR r IN SELECT * FROM audit_event ORDER BY seq LOOP
    IF r.prev_hash <> expected_prev
       OR r.hash <> encode(digest(r.prev_hash || mf_audit_canonical(r), 'sha256'), 'hex') THEN
      RETURN r.seq;
    END IF;
    expected_prev := r.hash;
  END LOOP;
  RETURN NULL;
END $$;

-- ---------------------------------------------------------------------------
-- 3. Chain epoch + demo reset (G10). audit_chain_meta is never truncated.
-- ---------------------------------------------------------------------------
INSERT INTO audit_chain_meta (id, current_epoch) VALUES (1, 1) ON CONFLICT (id) DO NOTHING;

CREATE OR REPLACE FUNCTION mf_demo_reset() RETURNS integer
LANGUAGE plpgsql AS $$
DECLARE tbls text; new_epoch integer;
BEGIN
  IF session_user <> 'mf_owner' THEN
    RAISE EXCEPTION 'MissionFlow: demo reset is owner-only (session_user=%)', session_user
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM set_config('mf.allow_reset', 'on', true);  -- transaction-local
  SELECT string_agg(format('%I', tablename), ', ') INTO tbls
    FROM pg_tables WHERE schemaname = 'public' AND tablename NOT IN ('audit_chain_meta', 'holiday');
  EXECUTE 'TRUNCATE ' || tbls || ' RESTART IDENTITY CASCADE';
  UPDATE audit_chain_meta SET current_epoch = current_epoch + 1, last_reset_at = now() WHERE id = 1 RETURNING current_epoch INTO new_epoch;
  INSERT INTO audit_event (actor_type, event_type, entity_type, payload, request_id, prev_hash, hash)
    VALUES ('system', 'admin.demo_reset', 'system', jsonb_build_object('epoch', new_epoch), gen_random_uuid(), '', '');
  PERFORM set_config('mf.allow_reset', 'off', true);
  RETURN new_epoch;
END $$;

-- ---------------------------------------------------------------------------
-- 4. Escalation overlay guards (G3)
-- ---------------------------------------------------------------------------
-- Raise only on a released, non-terminal tasker (TRIAGE counts only post-dispatch).
CREATE OR REPLACE FUNCTION mf_escalation_insert_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE st tasker_state; rel timestamptz;
BEGIN
  SELECT state, released_at INTO st, rel FROM tasker WHERE id = NEW.tasker_id;
  IF rel IS NULL OR st NOT IN ('ASSIGNED','CLARIFICATION','IN_WORK','IN_COORDINATION','AWAITING_APPROVAL','TRIAGE') THEN
    RAISE EXCEPTION 'MissionFlow: escalation requires a released, non-terminal tasker (state=%)', st
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS escalation_insert_guard ON escalation;
CREATE TRIGGER escalation_insert_guard BEFORE INSERT ON escalation
  FOR EACH ROW EXECUTE FUNCTION mf_escalation_insert_guard();

-- A resolved escalation is frozen; escalations are never deleted.
CREATE OR REPLACE FUNCTION mf_escalation_update_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR OLD.resolved_at IS NOT NULL THEN
    RAISE EXCEPTION 'MissionFlow: escalation % is resolved/immutable (%)', OLD.id, TG_OP USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.tasker_id <> OLD.tasker_id OR NEW.raised_by <> OLD.raised_by OR NEW.reason <> OLD.reason OR NEW.raised_at <> OLD.raised_at THEN
    RAISE EXCEPTION 'MissionFlow: escalation raise fields are immutable' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS escalation_update_guard ON escalation;
CREATE TRIGGER escalation_update_guard BEFORE UPDATE OR DELETE ON escalation
  FOR EACH ROW EXECUTE FUNCTION mf_escalation_update_guard();

-- Backstop: at COMMIT, a CLOSED tasker may not have an open escalation (core auto-closes them
-- in the same transaction and writes escalation.auto_closed).
CREATE OR REPLACE FUNCTION mf_closed_no_open_escalation() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE tid uuid;
BEGIN
  IF TG_TABLE_NAME = 'tasker' THEN tid := NEW.id; ELSE tid := NEW.tasker_id; END IF;
  IF EXISTS (SELECT 1 FROM tasker t JOIN escalation e ON e.tasker_id = t.id
             WHERE t.id = tid AND t.state = 'CLOSED' AND e.resolved_at IS NULL) THEN
    RAISE EXCEPTION 'MissionFlow: tasker % is CLOSED with an open escalation', tid USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS tasker_closed_no_open_escalation ON tasker;
CREATE CONSTRAINT TRIGGER tasker_closed_no_open_escalation AFTER UPDATE OF state ON tasker
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION mf_closed_no_open_escalation();
DROP TRIGGER IF EXISTS escalation_closed_tasker ON escalation;
CREATE CONSTRAINT TRIGGER escalation_closed_tasker AFTER INSERT OR UPDATE ON escalation
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION mf_closed_no_open_escalation();

-- ---------------------------------------------------------------------------
-- 5. Sign → Completed vs Submitted is deterministic (G17)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION mf_disposition_sign_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE transmit boolean;
BEGIN
  IF NEW.type IN ('completed', 'submitted') THEN
    SELECT transmit_to_higher_hq INTO transmit FROM tasker WHERE id = NEW.tasker_id;
    IF transmit IS NULL OR (transmit AND NEW.type <> 'submitted') OR (NOT transmit AND NEW.type <> 'completed') THEN
      RAISE EXCEPTION 'MissionFlow: % does not match tasker.transmit_to_higher_hq=% (G17)', NEW.type, transmit
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS disposition_sign_guard ON disposition;
CREATE TRIGGER disposition_sign_guard BEFORE INSERT ON disposition
  FOR EACH ROW EXECUTE FUNCTION mf_disposition_sign_guard();

-- ---------------------------------------------------------------------------
-- 6. Gate round never decreases (G11)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION mf_gate_round_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.round < OLD.round THEN
    RAISE EXCEPTION 'MissionFlow: gate.round cannot decrease (% → %)', OLD.round, NEW.round USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS gate_round_guard ON gate;
CREATE TRIGGER gate_round_guard BEFORE UPDATE OF round ON gate
  FOR EACH ROW EXECUTE FUNCTION mf_gate_round_guard();

-- ---------------------------------------------------------------------------
-- 7. AI grounding: every input_ref must be a document version of the SAME tasker (G19, §11.3)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION mf_ai_input_refs_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE bad int;
BEGIN
  SELECT count(*) INTO bad
    FROM jsonb_array_elements(NEW.input_refs) r
    LEFT JOIN document_version v ON v.id = (r->>'doc_version_id')::uuid
    LEFT JOIN document d ON d.id = v.document_id
   WHERE d.tasker_id IS DISTINCT FROM NEW.tasker_id;
  IF bad > 0 THEN
    RAISE EXCEPTION 'MissionFlow: ai_artifact input_refs must reference this tasker''s document versions only'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS ai_artifact_input_refs_guard ON ai_artifact;
CREATE TRIGGER ai_artifact_input_refs_guard BEFORE INSERT ON ai_artifact
  FOR EACH ROW EXECUTE FUNCTION mf_ai_input_refs_guard();

-- ---------------------------------------------------------------------------
-- 8. N3 / N6: audit payload shape for elevation and escalation joiners.
--    No new table. The event records the facts; tasker.elevated_nonconcurrence
--    is the field the Approver view reads for attached gates.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION mf_audit_payload_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE n_ids int; n_rounds int;
BEGIN
  IF NEW.event_type = 'tasker.elevated_with_nonconcurrence' THEN
    IF NEW.tasker_id IS NULL
       OR jsonb_typeof(NEW.payload->'gate_ids') <> 'array'
       OR jsonb_typeof(NEW.payload->'gate_rounds') <> 'array'
       OR coalesce(length(trim(NEW.payload->>'rationale')), 0) = 0 THEN
      RAISE EXCEPTION 'MissionFlow: tasker.elevated_with_nonconcurrence needs tasker_id and payload {gate_ids, gate_rounds, rationale}'
        USING ERRCODE = 'check_violation';
    END IF;
    n_ids := jsonb_array_length(NEW.payload->'gate_ids');
    n_rounds := jsonb_array_length(NEW.payload->'gate_rounds');
    IF n_ids < 1 OR n_ids <> n_rounds THEN
      RAISE EXCEPTION 'MissionFlow: elevated gate_ids and gate_rounds must be non-empty and the same length'
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW.event_type = 'escalation.joined' THEN
    IF NEW.tasker_id IS NULL
       OR coalesce(NEW.payload->>'raised_by', '') = ''
       OR coalesce(length(trim(NEW.payload->>'reason')), 0) = 0 THEN
      RAISE EXCEPTION 'MissionFlow: escalation.joined needs tasker_id and payload {raised_by, reason}'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS audit_event_payload_guard ON audit_event;
CREATE TRIGGER audit_event_payload_guard BEFORE INSERT ON audit_event
  FOR EACH ROW EXECUTE FUNCTION mf_audit_payload_guard();

-- ---------------------------------------------------------------------------
-- 9. N7: accepted_at on an AO assignment is set once.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION mf_assignment_accepted_once() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.accepted_at IS NOT NULL AND NEW.accepted_at IS DISTINCT FROM OLD.accepted_at THEN
    RAISE EXCEPTION 'MissionFlow: tasker_assignment.accepted_at is set once (N7)'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tasker_assignment_accepted_once ON tasker_assignment;
CREATE TRIGGER tasker_assignment_accepted_once BEFORE UPDATE OF accepted_at ON tasker_assignment
  FOR EACH ROW EXECUTE FUNCTION mf_assignment_accepted_once();

-- ---------------------------------------------------------------------------
-- 10. N5: a CLOSED tasker cannot still have a pending or open gate.
--     The core auto-closes them (system actor) in the same transaction.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION mf_closed_no_open_gate() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE tid uuid;
BEGIN
  IF TG_TABLE_NAME = 'tasker' THEN tid := NEW.id; ELSE tid := NEW.tasker_id; END IF;
  IF EXISTS (
    SELECT 1 FROM tasker t
    JOIN gate g ON g.tasker_id = t.id
    WHERE t.id = tid AND t.state = 'CLOSED' AND g.status IN ('pending', 'open')
  ) THEN
    RAISE EXCEPTION 'MissionFlow: tasker % is CLOSED with an open gate', tid
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS tasker_closed_no_open_gate ON tasker;
CREATE CONSTRAINT TRIGGER tasker_closed_no_open_gate AFTER UPDATE OF state ON tasker
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION mf_closed_no_open_gate();
DROP TRIGGER IF EXISTS gate_closed_tasker ON gate;
CREATE CONSTRAINT TRIGGER gate_closed_tasker AFTER INSERT OR UPDATE ON gate
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION mf_closed_no_open_gate();

-- ---------------------------------------------------------------------------
-- 11. Roles (local dev). mf_owner runs migrations; mf_app is what Next.js uses.
--    Role creation itself lives in docker/initdb (needs superuser); grants here.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mf_app') THEN
    GRANT USAGE ON SCHEMA public TO mf_app;
    GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO mf_app;
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO mf_app;
    REVOKE UPDATE, DELETE, TRUNCATE ON
      audit_event, disposition, ai_artifact, ai_verification,
      suspense_plan, suspense_resolution, document_version
    FROM mf_app;
    REVOKE DELETE, TRUNCATE ON ALL TABLES IN SCHEMA public FROM mf_app; -- nothing is hard-deleted in MVP
    REVOKE UPDATE ON audit_chain_meta FROM mf_app;                        -- only mf_demo_reset (owner) bumps the epoch
    REVOKE EXECUTE ON FUNCTION mf_demo_reset() FROM PUBLIC;
  END IF;
END $$;
