# Architecture

MissionFlow keeps one system of record for a tasker's life, from draft through close. Two lanes sit on that record and do not talk to each other.

The **work lane** is the action officer's path: drafting, questions, and coordination requests. The **oversight lane** is the leadership path: suspense, gates, approval, and the dashboard. A lane imports the core through `src/core/index.ts` and nothing else in `src/core`. It never imports the other lane. They will meet only by calling core commands and by reading core events. A dependency rule in CI rejects a cross-lane import and a deep import into the core.

The database is Postgres 16. The schema is Drizzle (`src/db/schema.ts`) plus a SQL file for triggers. Append-only tables (the audit log, dispositions, suspense snapshots, document versions, and AI artifacts) reject updates and deletes. The app role can insert and read the audit log, and it cannot reset the demo. The owner role runs migrations and is the only role that can reset demo data, which bumps a chain epoch and writes a new first audit row.

Closing a tasker is a configuration list: completed, submitted, no-equity validated, and cancelled. The config check refuses to close by reassignment, return for rework, concur, or nonconcur, and it refuses to drop a closing type that has no other target state. One `CLOSED` state stores which disposition closed it.

An escalation does not change the tasker's state. At most one is open. A second person joins it through an audit event instead of opening another row. Forwarding a nonconcurrence to the approver records the attached gates on the tasker and in an audit event. Reassignment is allowed from coordination and from approval; the tasker goes back to assigned, and the gates stay. A coordinator can decide an open gate in any open state. A nonconcur sends the tasker back to work only from coordination. Open gates are cleared when the tasker closes.

Each action-officer assignment stores its own acceptance time. The tasker's acceptance time is the current officer's, and it is replaced when someone else takes the task.

Dates use a configured business time zone (default America/Chicago), never the host's zone. Echelon rank is a map in config: `naf` ranks with `center`, not above or below it. Transmission to a higher headquarters defaults to true only when the originator's echelon strictly outranks the approver's.

Drafting goes through one adapter. The template is the default. A commercial model is selected only when the flag is on, the deployment is the public demo, the host environment is production, and the model is on the allowlist. A spend cap or a gateway error falls back to the template and says so. The flag is the kill switch and stays off in this repo. The core stamps every draft and never calls a model unless a test supplies a fake client.

Commands live in the core. Each one checks permission, checks the transition, then writes the tasker change, an audit row, and an outbox row in one transaction. A forced failure rolls all three back. A denial is recorded in its own transaction so the denial survives. The outbox delivers each event to a subscriber once. The audit hash chain can be verified, and a tampered row is reported. Demo reset bumps the chain epoch.

Sign-in is a persona plus one shared passcode. The cookie holds the person and the role they are acting as. Permission is a function of that role, grants, and assignments on the tasker. Someone with no entitlement gets the same not-found result as a missing tasker. The system administrator does not read tasker content.

Lifecycle commands cover release, acceptance, reassignment (including from coordination and approval, gates kept), a nonconcur that either returns the tasker to work or records a notice, and auto-close of open gates and escalations when the tasker closes. Registry matching, suspense plans, gates, SME notes, and documents are the same command style. The awards seed builds its scenarios by calling those commands, not by inserting finished taskers.
