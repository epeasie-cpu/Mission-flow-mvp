import { spawnSync } from "node:child_process";
import pg from "pg";
import { seedDemo } from "../src/core/seed";
import { runtimeDb } from "../src/core/runtime";
import { loadLocalEnv } from "./load-env";

loadLocalEnv();

const banned = spawnSync(process.execPath, ["scripts/check-banned-names.mjs"], { stdio: "inherit" });
if (banned.status !== 0) process.exit(banned.status ?? 1);

const reset = process.argv.includes("--reset");

async function execReset(): Promise<void> {
  const url = process.env.DATABASE_URL_OWNER ?? process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL_OWNER is not set");
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query("select mf_demo_reset()");
  } finally {
    await client.end();
  }
}

const result = await seedDemo(runtimeDb(), { reset, execReset: reset ? execReset : undefined });
console.log(result.alreadySeeded ? "Seed already present." : `Seeded ${result.taskers.length} taskers.`);
for (const row of result.taskers) console.log(`  ${row.ref}  ${row.state}  ${row.title}`);
