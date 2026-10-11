/**
 * Proves the lane rule fails CI: a temporary lane-to-lane import and a deep core import
 * must each be rejected. The probes are deleted before the script exits.
 */
import { execFileSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const cases = [
  {
    name: "lane-to-lane",
    rel: "src/lanes/work/_boundary_probe.ts",
    body: 'import { oversightLane } from "@/lanes/oversight";\nexport const probe = oversightLane;\n',
    rule: "work-imports-oversight",
  },
  {
    name: "deep-core",
    rel: "src/lanes/oversight/_boundary_probe.ts",
    body: 'import { formatBanner } from "@/core/internal/banner";\nexport const probe = formatBanner("x");\n',
    rule: "lane-deep-core",
  },
];

function report() {
  try {
    const stdout = execFileSync(
      "npx",
      ["depcruise", "src", "--config", ".dependency-cruiser.cjs", "--output-type", "json"],
      { encoding: "utf8" },
    );
    return JSON.parse(stdout);
  } catch (error) {
    const stdout = error && typeof error === "object" && "stdout" in error ? String(error.stdout ?? "") : "";
    if (!stdout.trim()) throw error;
    return JSON.parse(stdout);
  }
}

let failed = 0;
for (const item of cases) {
  const file = join(process.cwd(), item.rel);
  writeFileSync(file, item.body);
  try {
    const result = report();
    const rules = (result.summary?.violations ?? []).map((v) => v.rule?.name);
    if (!rules.includes(item.rule)) {
      failed++;
      console.error(`FAIL ${item.name}: expected rule ${item.rule}, saw ${rules.join(", ") || "(none)"}`);
    } else {
      console.log(`PASS ${item.name} blocked by ${item.rule}`);
    }
  } finally {
    rmSync(file, { force: true });
  }
}

if (failed) process.exit(1);
console.log("lane boundary violations are rejected");
