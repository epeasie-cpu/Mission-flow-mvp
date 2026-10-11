import { readdirSync, readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { drizzle } from "drizzle-orm/pglite";
import * as schema from "../db/schema";
import type { CoreDb } from "../core/db";

export type Harness = { client: PGlite; db: CoreDb };

export async function createHarness(): Promise<Harness> {
  const client = new PGlite({ extensions: { pgcrypto } });
  for (const file of readdirSync("drizzle").filter((name) => name.endsWith(".sql")).sort()) {
    for (const statement of readFileSync(`drizzle/${file}`, "utf8").split("--> statement-breakpoint")) {
      if (statement.trim()) await client.exec(statement);
    }
  }
  await client.exec(readFileSync("db/sql/0001_core_guards.sql", "utf8"));
  await client.exec(`
    create role mf_owner;
    grant usage, create on schema public to mf_owner;
    grant execute on function mf_demo_reset() to mf_owner;
    do $$ declare t text; begin
      for t in select tablename from pg_tables where schemaname = 'public' loop
        execute format('alter table %I owner to mf_owner', t);
      end loop;
    end $$;
  `);
  const db = drizzle(client, { schema }) as unknown as CoreDb;
  return { client, db };
}

export async function resetDemo(client: PGlite): Promise<void> {
  await client.exec("set session authorization mf_owner");
  try {
    await client.exec("select mf_demo_reset()");
  } finally {
    await client.exec("reset session authorization");
  }
}
