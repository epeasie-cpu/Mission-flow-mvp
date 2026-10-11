#!/usr/bin/env node
/**
 * Banned-name check (spec §7.1 last item, §7.2 Rules). Fails (exit 1) if any banned
 * real unit/person/base name or non-synthetic email appears in the repo.
 *
 * Sources of patterns:
 *   1. scripts/denylist.public.txt   (committed, generic regexes)
 *   2. .denylist.local               (gitignored; literal names, one per line)
 *   3. MF_DENYLIST env var           (CI secret; literal names separated by newline or |)
 *      MF_BANNED_NAMES is accepted as an alias.
 * Literal names are matched case-insensitively on word boundaries.
 *
 * Usage: node scripts/check-banned-names.mjs [path ...]   (default: repo root)
 * Allow a specific false positive with an inline comment: `mf-banned-ok: <reason>`.
 */
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative, extname } from "node:path";

const ROOT = process.cwd();
const SKIP_DIRS = new Set(["node_modules", ".git", ".next", "dist", "coverage", "meta"]);
const SKIP_FILES = new Set(["scripts/denylist.public.txt", ".denylist.local", "package-lock.json"]);
const TEXT_EXT = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs", ".json", ".sql", ".md", ".txt", ".csv", ".yml", ".yaml", ".env", ".example", ".html", ".css", ""]);

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const patterns = [];
const pub = join(ROOT, "scripts/denylist.public.txt");
if (existsSync(pub))
  for (const l of readFileSync(pub, "utf8").split("\n"))
    if (l.trim() && !l.trim().startsWith("#")) {
      const raw = l.trim();
      const cs = raw.startsWith("cs:");
      patterns.push({ re: new RegExp(cs ? raw.slice(3) : raw, cs ? "" : "i"), label: "public-pattern" });
    }
const literals = [
  ...(existsSync(join(ROOT, ".denylist.local")) ? readFileSync(join(ROOT, ".denylist.local"), "utf8").split("\n") : []),
  ...(process.env.MF_DENYLIST ?? "").split(/\n|\|/),
  ...(process.env.MF_BANNED_NAMES ?? "").split(/\n|\|/),
].map((s) => s.trim()).filter((s) => s && !s.startsWith("#"));
for (const lit of literals) patterns.push({ re: new RegExp(`(?<![A-Za-z0-9])${escape(lit)}(?![A-Za-z0-9])`, "i"), label: "private-name" });

if (literals.length === 0 && process.env.CI)
  console.warn("WARN: no private banned names loaded (set the MF_DENYLIST secret). Only generic patterns checked.");

function* walk(p) {
  const st = statSync(p);
  if (st.isDirectory()) {
    for (const e of readdirSync(p)) if (!SKIP_DIRS.has(e)) yield* walk(join(p, e));
  } else yield p;
}

const targets = process.argv.slice(2).length ? process.argv.slice(2) : [ROOT];
let hits = 0;
for (const t of targets)
  for (const file of walk(t)) {
    const rel = relative(ROOT, file);
    if (SKIP_FILES.has(rel) || !TEXT_EXT.has(extname(file).toLowerCase())) continue;
    if (statSync(file).size > 2_000_000) continue;
    readFileSync(file, "utf8").split("\n").forEach((line, i) => {
      if (line.includes("mf-banned-ok:")) return;
      for (const { re, label } of patterns)
        if (re.test(line)) {
          hits++;
          // Never echo the private literal itself into CI logs.
          console.error(`BANNED (${label}) ${rel}:${i + 1}${label === "public-pattern" ? `  /${re.source}/` : ""}`);
        }
    });
  }
if (hits) {
  console.error(`\n✖ banned-name check failed: ${hits} hit(s). Synthetic data only (spec §7.2).`);
  process.exit(1);
}
console.log(`✔ banned-name check passed (${patterns.length} patterns, ${literals.length} private names).`);
