/**
 * M1 exit: the app role cannot UPDATE or DELETE append-only tables, and cannot reset the demo.
 */
import pg from "pg";
import { loadLocalEnv } from "./load-env";

loadLocalEnv();

const appUrl = process.env.DATABASE_URL;
if (!appUrl) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}

const APPEND_ONLY = [
  "audit_event",
  "disposition",
  "ai_artifact",
  "ai_verification",
  "suspense_plan",
  "suspense_resolution",
  "document_version",
  "stored_document",
  "outbound_email",
];

const app = new pg.Client({ connectionString: appUrl });
await app.connect();

let pass = 0;
let fail = 0;
const expectFail = async (name: string, sql: string) => {
  try {
    await app.query(sql);
    fail++;
    console.log("FAIL", name);
  } catch (error) {
    pass++;
    const message = error instanceof Error ? error.message.split("\n")[0] : String(error);
    console.log("PASS", name, "->", message);
  }
};
const expectOk = async (name: string, sql: string) => {
  try {
    await app.query(sql);
    pass++;
    console.log("PASS", name);
  } catch (error) {
    fail++;
    const message = error instanceof Error ? error.message.split("\n")[0] : String(error);
    console.log("FAIL", name, "->", message);
  }
};

await expectOk("app can read audit_event", "select count(*)::int as n from audit_event");
for (const table of APPEND_ONLY) {
  await expectFail(`app cannot UPDATE ${table}`, `update ${table} set id = id where false`);
  await expectFail(`app cannot DELETE ${table}`, `delete from ${table} where false`);
}
await expectFail("app cannot TRUNCATE audit_event", "truncate audit_event");
await expectFail("app cannot call mf_demo_reset()", "select mf_demo_reset()");
await app.end();

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
