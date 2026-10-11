// v0.2 dry run: applies the generated migration + guards to an in-memory Postgres (PGlite)
// and exercises the DB-level rules. Dev-only; no external DB needed.
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { readFileSync, readdirSync } from "node:fs";

const db = new PGlite({ extensions: { pgcrypto } });
for (const f of readdirSync("drizzle").filter((f) => f.endsWith(".sql")).sort())
  for (const stmt of readFileSync(`drizzle/${f}`, "utf8").split("--> statement-breakpoint")) if (stmt.trim()) await db.exec(stmt);
await db.exec(readFileSync("db/sql/0001_core_guards.sql", "utf8"));

let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log("PASS", m); };
const bad = (m) => { fail++; console.log("FAIL", m); };
const expectFail = async (m, q) => { try { await db.exec(q); bad(`${m} (should have errored)`); } catch (e) { ok(`${m} -> ${e.message.split("\n")[0]}`); } };
const expectOk = async (m, q) => { try { await db.exec(q); ok(m); } catch (e) { bad(`${m} -> ${e.message.split("\n")[0]}`); } };
const one = async (q) => (await db.query(q)).rows[0];

const ORG = "'00000000-0000-0000-0000-000000000001'", U = "'00000000-0000-0000-0000-0000000000a1'";
const T1 = "'00000000-0000-0000-0000-0000000000f1'", T2 = "'00000000-0000-0000-0000-0000000000f2'";
const P1 = "'00000000-0000-0000-0000-0000000000b1'", P2 = "'00000000-0000-0000-0000-0000000000b2'";
const S = "[DRAFT – AI-GENERATED ASSISTANCE – REQUIRES AO VERIFICATION]";
const plan = (id, t) => `insert into suspense_plan (id,tasker_id,version,external_suspense,stages,contingency_buffer_days,latest_ao_assignment_date,ao_window_pct,conflict) values (${id},${t},1,'2026-12-01','[]',2,'2026-11-01',0.5882,false)`;
const taskerIns = (id, ref) => `insert into tasker (id,ref,title,category,mission_function,target_org_id,requirement,deliverable_format,external_suspense,originator_id) values (${id},'${ref}','t','awards_package','f',${ORG},'r','1206','2026-12-01',${U})`;
// Released IN_WORK tasker (G9/G17 release fields)
const release = (id, plan, transmit) => `update tasker set state='IN_WORK', submitted_for_release_at=now(), released_at=now(), tasking_authority_id=${U}, current_suspense_plan_id=${plan}, transmit_to_higher_hq=${transmit} where id=${id}`;

await db.exec(`
  insert into org (id,name,short_code,echelon) values (${ORG},'Sample Wing','SMW','wing');
  insert into app_user (id,display_name,email,org_id) values (${U},'Avery Sample','avery@example.test',${ORG});
  ${taskerIns(T1, "MF-2026-0001")}; ${taskerIns(T2, "MF-2026-0002")};
  ${plan(P1, T1)}; ${plan(P2, T2)};
`);
ok("seed rows inserted");

console.log("\n-- v0.1 rules (unchanged) --");
await expectFail("is_synthetic=false rejected", `insert into org (name,short_code,echelon,is_synthetic) values ('x','X','wing',false)`);
await expectFail("non-example.test email rejected", `insert into app_user (display_name,email,org_id) values ('x','x@af.mil',${ORG})`); // mf-banned-ok: negative test
await db.exec(`insert into tasker_assignment (tasker_id,user_id,role,source,assigned_by) values (${T1},${U},'ao_primary','registry_match',${U})`);
await expectFail("second active ao_primary rejected", `insert into tasker_assignment (tasker_id,user_id,role,source,assigned_by) values (${T1},${U},'ao_primary','registry_match',${U})`);
await expectFail("manual assignment w/o rationale rejected", `insert into tasker_assignment (tasker_id,user_id,role,source,assigned_by) values (${T1},${U},'sme_contributor','manual',${U})`);
await expectFail("gate w/o justification rejected", `insert into gate (tasker_id,kind,sequence,office_label,source,justification,due_date) values (${T1},'coordination',1,'Protocol','registry_mandatory','  ','2026-11-20')`);
await expectFail("reassigned w/o redirect rejected", `insert into disposition (tasker_id,type,applied_by,acting_role,rationale,from_state,to_state,closes_tasker) values (${T1},'reassigned',${U},'supervisor','why','IN_WORK','ASSIGNED',false)`);

console.log("\n-- G9/G17 release fields --");
await expectFail("release without transmit_to_higher_hq rejected", `update tasker set state='IN_WORK', submitted_for_release_at=now(), released_at=now(), tasking_authority_id=${U}, current_suspense_plan_id=${P1} where id=${T1}`);
await expectFail("non-DRAFT state without submitted_for_release_at rejected", `update tasker set state='PENDING_RELEASE' where id=${T1}`);
await expectOk("release with transmit flag + submitted_for_release_at accepted (T1 transmit=false)", release(T1, P1, false));
await expectOk("release T2 (transmit=true)", release(T2, P2, true));

console.log("\n-- G1 concurred rationale optional / G11 gate rounds --");
await db.exec(`insert into gate (id,tasker_id,kind,sequence,office_label,source,justification,due_date,status,assignee_user_id) values ('00000000-0000-0000-0000-0000000000c1',${T1},'coordination',1,'Protocol','registry_mandatory','equity: protocol','2026-11-20','open',${U})`);
const g = await one(`select round from gate where id='00000000-0000-0000-0000-0000000000c1'`);
g.round === 1 ? ok("gate.round defaults to 1") : bad("gate.round default " + g.round);
await expectOk("concurred without rationale accepted (G1)", `insert into disposition (tasker_id,gate_id,gate_round,type,applied_by,acting_role,from_state,to_state,closes_tasker) values (${T1},'00000000-0000-0000-0000-0000000000c1',1,'concurred',${U},'coordinator','IN_WORK','IN_WORK',false)`);
await expectFail("nonconcurred without rationale rejected (G1)", `insert into disposition (tasker_id,gate_id,gate_round,type,applied_by,acting_role,from_state,to_state,closes_tasker) values (${T1},'00000000-0000-0000-0000-0000000000c1',1,'nonconcurred',${U},'coordinator','IN_COORDINATION','IN_WORK',false)`);
await expectFail("gate decision without gate_round rejected (G11)", `insert into disposition (tasker_id,gate_id,type,applied_by,acting_role,rationale,from_state,to_state,closes_tasker) values (${T1},'00000000-0000-0000-0000-0000000000c1','nonconcurred',${U},'coordinator','x','IN_COORDINATION','IN_WORK',false)`);
await expectOk("reopen gate as round 2 (G11)", `update gate set round=2, status='open' where id='00000000-0000-0000-0000-0000000000c1'`);
await expectFail("gate.round cannot decrease (G11)", `update gate set round=1 where id='00000000-0000-0000-0000-0000000000c1'`);

console.log("\n-- N3 elevation field + event / N4 reassignment / N5 gate decisions --");
const gateBefore = await one(`select status, round from gate where id='00000000-0000-0000-0000-0000000000c1'`);
await expectFail("N3 elevation field without rationale rejected", `update tasker set elevated_nonconcurrence='{"gate_ids":["00000000-0000-0000-0000-0000000000c1"],"gate_rounds":[2]}'::jsonb where id=${T1}`);
await expectOk("N3 elevation field records the attached gates", `update tasker set elevated_nonconcurrence='{"gate_ids":["00000000-0000-0000-0000-0000000000c1"],"gate_rounds":[2],"rationale":"protocol nonconcurred"}'::jsonb where id=${T1}`);
await expectFail("N3 elevation event without gates rejected", `insert into audit_event (actor_type,actor_user_id,event_type,tasker_id,entity_type,payload,request_id,prev_hash,hash) values ('user',${U},'tasker.elevated_with_nonconcurrence',${T1},'tasker','{}'::jsonb,gen_random_uuid(),'','')`);
await expectOk("N3 elevation event stores gate ids, rounds, and rationale", `insert into audit_event (actor_type,actor_user_id,event_type,tasker_id,entity_type,payload,request_id,prev_hash,hash) values ('user',${U},'tasker.elevated_with_nonconcurrence',${T1},'tasker','{"gate_ids":["00000000-0000-0000-0000-0000000000c1"],"gate_rounds":[2],"rationale":"protocol nonconcurred"}'::jsonb,gen_random_uuid(),'','')`);
await expectOk("N4 reassigned from IN_COORDINATION returns to ASSIGNED", `insert into disposition (tasker_id,type,applied_by,acting_role,rationale,redirect_to_user_id,from_state,to_state,closes_tasker) values (${T1},'reassigned',${U},'supervisor','new owner',${U},'IN_COORDINATION','ASSIGNED',false)`);
await expectOk("N4 reassigned from AWAITING_APPROVAL returns to ASSIGNED", `insert into disposition (tasker_id,type,applied_by,acting_role,rationale,redirect_to_user_id,from_state,to_state,closes_tasker) values (${T1},'reassigned',${U},'tasking_authority','wrong owner',${U},'AWAITING_APPROVAL','ASSIGNED',false)`);
await expectFail("N4 reassigned from DRAFT rejected", `insert into disposition (tasker_id,type,applied_by,acting_role,rationale,redirect_to_user_id,from_state,to_state,closes_tasker) values (${T1},'reassigned',${U},'supervisor','no',${U},'DRAFT','ASSIGNED',false)`);
const gateAfter = await one(`select status, round from gate where id='00000000-0000-0000-0000-0000000000c1'`);
gateBefore.status === gateAfter.status && gateBefore.round === gateAfter.round ? ok("N4 reassignment leaves the gate and its round unchanged") : bad(`gate changed ${gateBefore.status}/${gateBefore.round} -> ${gateAfter.status}/${gateAfter.round}`);
await expectOk("N5 concur in AWAITING_APPROVAL does not move the tasker", `insert into disposition (tasker_id,gate_id,gate_round,type,applied_by,acting_role,from_state,to_state,closes_tasker) values (${T1},'00000000-0000-0000-0000-0000000000c1',2,'concurred',${U},'coordinator','AWAITING_APPROVAL','AWAITING_APPROVAL',false)`);
await expectOk("N5 nonconcur in AWAITING_APPROVAL is recorded without moving the tasker", `insert into disposition (tasker_id,gate_id,gate_round,type,applied_by,acting_role,rationale,from_state,to_state,closes_tasker) values (${T1},'00000000-0000-0000-0000-0000000000c1',2,'nonconcurred',${U},'coordinator','still no','AWAITING_APPROVAL','AWAITING_APPROVAL',false)`);
await expectFail("N5 nonconcur in IN_COORDINATION must move to IN_WORK", `insert into disposition (tasker_id,gate_id,gate_round,type,applied_by,acting_role,rationale,from_state,to_state,closes_tasker) values (${T1},'00000000-0000-0000-0000-0000000000c1',2,'nonconcurred',${U},'coordinator','no','IN_COORDINATION','IN_COORDINATION',false)`);
await expectOk("N5 nonconcur in IN_COORDINATION moves to IN_WORK", `insert into disposition (tasker_id,gate_id,gate_round,type,applied_by,acting_role,rationale,from_state,to_state,closes_tasker) values (${T1},'00000000-0000-0000-0000-0000000000c1',2,'nonconcurred',${U},'coordinator','no','IN_COORDINATION','IN_WORK',false)`);
await expectFail("N5 nonconcur cannot jump ASSIGNED to IN_WORK", `insert into disposition (tasker_id,gate_id,gate_round,type,applied_by,acting_role,rationale,from_state,to_state,closes_tasker) values (${T1},'00000000-0000-0000-0000-0000000000c1',2,'nonconcurred',${U},'coordinator','no','ASSIGNED','IN_WORK',false)`);

console.log("\n-- G15 single CLOSED state --");
await expectFail("disposition reassigned marked closing rejected", `insert into disposition (tasker_id,type,applied_by,acting_role,rationale,redirect_to_user_id,from_state,to_state,closes_tasker) values (${T1},'reassigned',${U},'supervisor','x',${U},'IN_WORK','CLOSED',true)`);
await expectFail("disposition returned_for_rework marked closing rejected", `insert into disposition (tasker_id,type,applied_by,acting_role,rationale,from_state,to_state,closes_tasker) values (${T1},'returned_for_rework',${U},'approver','x','AWAITING_APPROVAL','CLOSED',true)`);
await expectFail("closes_tasker=true but to_state<>CLOSED rejected", `insert into disposition (tasker_id,type,applied_by,acting_role,rationale,from_state,to_state,closes_tasker) values (${T1},'cancelled_obe',${U},'tasking_authority','OBE','IN_WORK','IN_WORK',true)`);
await expectFail("tasker CLOSED without closed_disposition_type rejected", `update tasker set state='CLOSED', closed_at=now() where id=${T1}`);
await expectFail("tasker closed_disposition_type=reassigned rejected", `update tasker set closed_disposition_type='reassigned' where id=${T1}`);
await expectFail("N2 tasker closed_disposition_type=concurred rejected", `update tasker set closed_disposition_type='concurred' where id=${T1}`);
await expectFail("N2 disposition concurred marked closing rejected", `insert into disposition (tasker_id,gate_id,gate_round,type,applied_by,acting_role,from_state,to_state,closes_tasker) values (${T1},'00000000-0000-0000-0000-0000000000c1',2,'concurred',${U},'coordinator','IN_WORK','CLOSED',true)`);
await expectFail("N2 disposition nonconcurred marked closing rejected", `insert into disposition (tasker_id,gate_id,gate_round,type,applied_by,acting_role,rationale,from_state,to_state,closes_tasker) values (${T1},'00000000-0000-0000-0000-0000000000c1',2,'nonconcurred',${U},'coordinator','no','IN_COORDINATION','CLOSED',true)`);

console.log("\n-- G17 sign → Completed vs Submitted --");
await expectFail("T1 (transmit=false) Submitted rejected", `insert into disposition (tasker_id,type,applied_by,acting_role,from_state,to_state,closes_tasker) values (${T1},'submitted',${U},'approver','AWAITING_APPROVAL','CLOSED',true)`);
await expectFail("T2 (transmit=true) Completed rejected", `insert into disposition (tasker_id,type,applied_by,acting_role,from_state,to_state,closes_tasker) values (${T2},'completed',${U},'approver','AWAITING_APPROVAL','CLOSED',true)`);

console.log("\n-- G3 escalation overlay --");
await expectFail("escalation on unreleased (DRAFT) tasker rejected", `${taskerIns("'00000000-0000-0000-0000-0000000000f3'", "MF-2026-0003")}; insert into escalation (tasker_id,raised_by,raised_by_role,reason) values ('00000000-0000-0000-0000-0000000000f3',${U},'action_officer','x')`);
await expectOk("escalation raised on released IN_WORK tasker", `insert into escalation (id,tasker_id,raised_by,raised_by_role,reason) values ('00000000-0000-0000-0000-0000000000e1',${T1},${U},'action_officer','resource conflict')`);
const st = await one(`select state from tasker where id=${T1}`);
st.state === "IN_WORK" ? ok("tasker state unchanged by escalation (overlay)") : bad("state changed: " + st.state);
await expectFail("second open escalation on same tasker rejected", `insert into escalation (tasker_id,raised_by,raised_by_role,reason) values (${T1},${U},'supervisor','another')`);
await expectFail("N6 joiner event without reason rejected", `insert into audit_event (actor_type,actor_user_id,event_type,tasker_id,entity_type,payload,request_id,prev_hash,hash) values ('user',${U},'escalation.joined',${T1},'escalation','{"raised_by":"00000000-0000-0000-0000-0000000000a1"}'::jsonb,gen_random_uuid(),'','')`);
await expectOk("N6 second raiser is recorded as escalation.joined", `insert into audit_event (actor_type,actor_user_id,event_type,tasker_id,entity_type,payload,request_id,prev_hash,hash) values ('user',${U},'escalation.joined',${T1},'escalation','{"raised_by":"00000000-0000-0000-0000-0000000000a1","reason":"same conflict"}'::jsonb,gen_random_uuid(),'','')`);
await expectOk("escalation raised in CLARIFICATION (G3)", `update tasker set state='CLARIFICATION' where id=${T2}; insert into escalation (tasker_id,raised_by,raised_by_role,reason) values (${T2},${U},'action_officer','blocked on originator')`);
await expectFail("closing a tasker with an open escalation rejected at COMMIT", `begin;
  insert into disposition (id,tasker_id,type,applied_by,acting_role,rationale,from_state,to_state,closes_tasker) values ('00000000-0000-0000-0000-0000000000d1',${T1},'cancelled_obe',${U},'tasking_authority','OBE','IN_WORK','CLOSED',true);
  update tasker set state='CLOSED', closed_at=now(), closed_disposition_type='cancelled_obe', final_disposition_id='00000000-0000-0000-0000-0000000000d1' where id=${T1};
  commit;`);
await db.exec("rollback").catch(() => {});
await expectFail("N5 closing with an open gate rejected at COMMIT", `begin;
  update escalation set resolved_at=now(), auto_closed=true, resolution='auto-closed: tasker closed' where id='00000000-0000-0000-0000-0000000000e1';
  insert into disposition (id,tasker_id,type,applied_by,acting_role,rationale,from_state,to_state,closes_tasker) values ('00000000-0000-0000-0000-0000000000d3',${T1},'cancelled_obe',${U},'tasking_authority','OBE','IN_WORK','CLOSED',true);
  update tasker set state='CLOSED', closed_at=now(), closed_disposition_type='cancelled_obe', final_disposition_id='00000000-0000-0000-0000-0000000000d3' where id=${T1};
  commit;`);
await db.exec("rollback").catch(() => {});
await expectOk("auto-close escalation and open gates, then close tasker (G3/G15/N5)", `begin;
  update escalation set resolved_at=now(), auto_closed=true, resolution='auto-closed: tasker closed' where id='00000000-0000-0000-0000-0000000000e1';
  update gate set status='auto_closed' where tasker_id=${T1} and status in ('pending','open');
  insert into disposition (id,tasker_id,type,applied_by,acting_role,rationale,from_state,to_state,closes_tasker) values ('00000000-0000-0000-0000-0000000000d2',${T1},'cancelled_obe',${U},'tasking_authority','OBE','IN_WORK','CLOSED',true);
  update tasker set state='CLOSED', closed_at=now(), closed_disposition_type='cancelled_obe', final_disposition_id='00000000-0000-0000-0000-0000000000d2' where id=${T1};
  commit;`);
await expectFail("resolved escalation is immutable", `update escalation set resolution='edited' where id='00000000-0000-0000-0000-0000000000e1'`);
await expectFail("escalation delete blocked", `delete from escalation where id='00000000-0000-0000-0000-0000000000e1'`);
await expectFail("escalation resolve without resolver or auto_closed rejected", `update escalation set resolved_at=now(), resolution='done' where tasker_id=${T2}`);
await expectOk("escalation resolved by a human (Supervisor/TA)", `update escalation set resolved_at=now(), resolved_by=${U}, resolution='priority rebalanced' where tasker_id=${T2}`);

console.log("\n-- append-only tables --");
await expectFail("UPDATE disposition blocked", `update disposition set rationale='x'`);
await expectFail("DELETE disposition blocked", `delete from disposition`);

console.log("\n-- AI artifact (stamp + G19 provenance) --");
await db.exec(`insert into document (id,tasker_id,enclave,title) values ('00000000-0000-0000-0000-00000000d0c1',${T2},'original','Original');
  insert into document_version (id,document_id,version_no,body_md,sha256,author_type,author_user_id) values ('00000000-0000-0000-0000-00000000d0c2','00000000-0000-0000-0000-00000000d0c1',1,'lorem','h','human',${U});`);
const art = (o = {}) => {
  const v = { tasker: T2, stamp: null, content: `${S}\\nbody\\n${S}`, provider: "template", model: "missionflow-template-v1", deployment: "local", label: null, refs: "[]", ...o };
  return `insert into ai_artifact (tasker_id,kind,${v.stamp ? "stamp," : ""}content,provider,model,deployment,demo_label,prompt_template_id,prompt_version,input_refs,output_sha256,requested_by) values (${v.tasker},'first_draft',${v.stamp ? `'${v.stamp}',` : ""}E'${v.content}','${v.provider}','${v.model}','${v.deployment}',${v.label ? `'${v.label}'` : "null"},'p','1','${v.refs}','h',${U})`;
};
await expectFail("wrong stamp rejected", art({ stamp: "DRAFT", content: "DRAFT x DRAFT" }));
await expectFail("missing footer stamp rejected", art({ content: `${S}\\nbody` }));
await expectOk("template artifact with header+footer stamp accepted", art());
await expectFail("unknown provider rejected", art({ provider: "commercial" }));
await expectFail("gateway artifact without 'not accredited' label rejected", art({ provider: "vercel_ai_gateway", model: "openai/gpt-5.4-nano", deployment: "public-demo" }));
await expectFail("gateway artifact outside public-demo rejected (G19 approval)", art({ provider: "vercel_ai_gateway", model: "openai/gpt-5.4-nano", deployment: "local", label: "Demo, not accredited — synthetic data only" }));
await expectOk("gateway artifact in public-demo with label + model accepted", art({ provider: "vercel_ai_gateway", model: "openai/gpt-5.4-nano", deployment: "public-demo", label: "Demo, not accredited — synthetic data only" }));
await expectFail("empty model rejected", art({ model: " " }));
await expectOk("input_refs from the same tasker accepted", art({ refs: '[{"doc_version_id":"00000000-0000-0000-0000-00000000d0c2","sha256":"h"}]' }));
await expectFail("input_refs from ANOTHER tasker rejected (grounding)", art({ tasker: T1, refs: '[{"doc_version_id":"00000000-0000-0000-0000-00000000d0c2","sha256":"h"}]' }));
const artifactCols = await db.query(`select column_name from information_schema.columns where table_name='ai_artifact' and column_name in ('verification_status','verified_by','verified_at','verification_note')`);
artifactCols.rows.length === 0 ? ok("N8 ai_artifact has no verification columns") : bad("N8 verification columns still on ai_artifact");
const verificationCols = (await db.query(`select column_name from information_schema.columns where table_name='ai_verification'`)).rows.map((r) => r.column_name);
["decision", "verified_by", "note", "ai_artifact_id"].every((c) => verificationCols.includes(c))
  ? ok("N8 verification columns live on ai_verification")
  : bad("N8 ai_verification columns: " + verificationCols.join(","));

console.log("\n-- N7 per-AO accepted_at / N9 naf --");
await expectOk("N9 naf echelon is accepted", `insert into org (name,short_code,echelon) values ('Example Numbered Force','EXNF','naf')`);
await expectOk("N7 AO A accepted_at set once", `update tasker_assignment set accepted_at='2026-10-01T15:00:00Z' where tasker_id=${T1} and role='ao_primary' and active`);
await expectFail("N7 AO A accepted_at cannot change", `update tasker_assignment set accepted_at='2026-10-02T15:00:00Z' where tasker_id=${T1} and role='ao_primary' and active`);
await expectOk("N7 end AO A without clearing accepted_at", `update tasker_assignment set active=false, ended_at=now(), ended_reason='reassigned' where tasker_id=${T1} and role='ao_primary' and active`);
await db.exec(`insert into app_user (id,display_name,email,org_id) values ('00000000-0000-0000-0000-0000000000a2','Blair Placeholder','blair@example.test',${ORG})`);
await expectOk("N7 AO B assignment records its own accepted_at", `insert into tasker_assignment (tasker_id,user_id,role,source,rationale,assigned_by,accepted_at) values (${T1},'00000000-0000-0000-0000-0000000000a2','ao_primary','reassignment','coverage',${U},'2026-10-03T16:00:00Z')`);
await expectOk("N7 tasker.accepted_at follows the current AO", `update tasker set accepted_at='2026-10-03T16:00:00Z' where id=${T1}`);
const accepts = await one(`select (select count(*) from tasker_assignment where tasker_id=${T1} and role='ao_primary' and accepted_at is not null)::int as n, (select accepted_at = '2026-10-03T16:00:00Z' from tasker where id=${T1}) as current`);
accepts.n === 2 && accepts.current === true ? ok("N7 both AO rows keep accepted_at and tasker.accepted_at is B") : bad(JSON.stringify(accepts));

console.log("\n-- audit chain + G10 epoch / demo reset --");
for (let i = 0; i < 3; i++) await db.exec(`insert into audit_event (actor_type,actor_user_id,event_type,entity_type,request_id,prev_hash,hash) values ('user',${U},'tasker.created','tasker',gen_random_uuid(),'','')`);
let r = await one(`select mf_verify_audit_chain() as broken, (select min(chain_epoch) from audit_event) as e`);
r.broken === null ? ok("audit chain verifies") : bad("chain broken at " + r.broken);
r.e === 1 ? ok("events stamped chain_epoch=1") : bad("epoch " + r.e);
await expectFail("UPDATE audit_event blocked", `update audit_event set event_type='x'`);
await expectFail("TRUNCATE audit_event blocked", `truncate audit_event`);
await expectFail("demo reset as non-owner rejected", `select mf_demo_reset()`);
// In the real stack mf_owner owns every table (it runs migrations); mirror that here.
await db.exec(`create role mf_owner; grant usage, create on schema public to mf_owner; grant execute on function mf_demo_reset() to mf_owner;
  do $$ declare t text; begin for t in select tablename from pg_tables where schemaname='public' loop execute format('alter table %I owner to mf_owner', t); end loop; end $$;`);
await db.exec(`set session authorization mf_owner`);
r = await one(`select mf_demo_reset() as epoch`);
await db.exec(`reset session authorization`);
r.epoch === 2 ? ok("owner demo reset → chain epoch 2") : bad("epoch after reset " + r.epoch);
r = await one(`select (select count(*) from tasker)::int as t, (select count(*) from audit_event)::int as a, (select event_type from audit_event) as ev, (select chain_epoch from audit_event) as e, mf_verify_audit_chain() as broken`);
r.t === 0 && r.a === 1 && r.ev === "admin.demo_reset" && r.e === 2 && r.broken === null ? ok("reset emptied data, wrote genesis admin.demo_reset (epoch 2), chain verifies") : bad(JSON.stringify(r));
await db.exec(`insert into org (id,name,short_code,echelon) values (${ORG},'Sample Wing','SMW','wing'); insert into app_user (id,display_name,email,org_id) values (${U},'Avery Sample','avery@example.test',${ORG});`);
for (let i = 0; i < 2; i++) await db.exec(`insert into audit_event (actor_type,actor_user_id,event_type,entity_type,request_id,prev_hash,hash) values ('user',${U},'tasker.created','tasker',gen_random_uuid(),'','')`);
await db.exec(`alter table audit_event disable trigger user; update audit_event set payload='{"x":1}' where seq=(select seq from audit_event order by seq offset 1 limit 1); alter table audit_event enable trigger user;`);
r = await one(`select mf_verify_audit_chain() as broken`);
r.broken !== null ? ok(`tamper detected at seq ${r.broken}`) : bad("tamper not detected");

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
