/**
 * Apply Drizzle migrations as mf_owner, then the guard SQL (triggers, hash chain, grants).
 */
import { readFileSync } from "node:fs";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { loadLocalEnv } from "./load-env";
import { splitSql } from "./split-sql";

loadLocalEnv();

const url = process.env.DATABASE_URL_OWNER;
if (!url) {
  console.error("DATABASE_URL_OWNER is not set");
  process.exit(1);
}

const client = new pg.Client({ connectionString: url });
await client.connect();
await migrate(drizzle(client), { migrationsFolder: "./drizzle" });
for (const statement of splitSql(readFileSync("db/sql/0001_core_guards.sql", "utf8"))) {
  await client.query(statement);
}
await client.end();
console.log("migrations and guards applied");
