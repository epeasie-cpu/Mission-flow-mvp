/**
 * Create the local mf_owner / mf_app roles. Docker does this from docker/initdb on first boot.
 * CI and a bare Postgres need this step, using DATABASE_URL_SUPER.
 */
import pg from "pg";
import { loadLocalEnv } from "./load-env";

loadLocalEnv();

const superUrl = process.env.DATABASE_URL_SUPER;
if (!superUrl) {
  console.log("DATABASE_URL_SUPER is unset; assuming docker init already created mf_owner and mf_app.");
  process.exit(0);
}

const admin = new pg.Client({ connectionString: superUrl });
await admin.connect();

async function ensureRole(name: string, password: string) {
  const existing = await admin.query("select 1 from pg_roles where rolname = $1", [name]);
  if (existing.rowCount === 0) {
    await admin.query(`CREATE ROLE ${name} LOGIN PASSWORD '${password}'`);
  }
}

await ensureRole("mf_owner", "mf_owner");
await ensureRole("mf_app", "mf_app");

const dbName = new URL(superUrl).pathname.replace(/^\//, "") || "missionflow";
if (!/^[a-z_][a-z0-9_]*$/i.test(dbName)) throw new Error(`unexpected database name: ${dbName}`);
await admin.query(`ALTER DATABASE ${dbName} OWNER TO mf_owner`);
await admin.query("GRANT ALL ON SCHEMA public TO mf_owner");
await admin.query("ALTER SCHEMA public OWNER TO mf_owner");
await admin.end();
console.log(`roles ready on ${dbName}`);
