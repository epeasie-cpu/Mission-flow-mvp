# MissionFlow

Synthetic demo of an AI-enabled tasking tool. Work goes straight to the action officer. Suspenses are planned backward from the external due date. Leadership sees the same record.

This repository is the shared core: the database, the rules around it, and a thin Next.js shell. Both lanes will sit on top of it. The repo is unlicensed (all rights reserved).

Data in this project is fictional. People use names like Avery Sample, units are made up, and email addresses end in `@example.test`. Do not add a real unit, a real person, or a government address. `npm run check:banned` enforces that.

Hosting for a later deploy is a separate Vercel team for this project only. Nothing is deployed from this repository yet. Local development uses Postgres 16.

The commercial drafting path is off. `MF_AI_COMMERCIAL_ENABLED` defaults to false, and even when it is set the gateway runs only on the public-demo production deploy, for an approved model, with a limit of 10 drafts an hour per session and 200 a day. Everywhere else, including local development, the template runs.

## Local setup

```bash
npm install
cp .env.example .env.local
docker compose up -d db
npm run db:migrate
npm run verify:all
npm run dev
```

- `docker compose up -d db` starts Postgres 16 on port 5433 and, on first boot, creates the `mf_owner` and `mf_app` roles.
- `npm run db:migrate` applies the Drizzle migration as `mf_owner`, then the guard SQL (append-only triggers, the audit hash chain, and grants).
- `npm run verify:all` typechecks, runs the config checks under three time zones, runs the in-memory database checks, and runs the banned-name check. It does not need Docker.
- `npm run verify:pg` checks that `mf_app` cannot update or delete append-only tables. Run it after `db:migrate`.
- `npm run dev` serves the shell at http://localhost:3000. Every page shows the synthetic-data banner.

`npm run lint` includes the lane rule: a work-path file cannot import the oversight path, and neither lane can reach past `src/core/index.ts`.

## Seed and sign-in

```bash
npm run seed
npm run seed -- --reset
```

`npm run seed` loads the fictional awards pilot: sample units, personas at `@example.test`, one live registry entry for an awards worksheet, and taskers built through the same commands the app uses. If that sample org is already present, the command leaves the database alone. `npm run seed -- --reset` runs the owner-only demo reset (`DATABASE_URL_OWNER`, role `mf_owner`) and loads the pilot again. Federal holidays are not wiped.

Open http://localhost:3000/sign-in, pick a persona, and enter `DEMO_PASSCODE` from `.env.local`. The session cookie stores who you are and which role you are acting as. A wrong passcode is refused. A role the persona does not hold cannot be selected.

## CI

GitHub Actions runs typecheck, lint (including the lane rule), unit tests, the verify scripts, and the banned-name check. It also migrates a Postgres 16 service and runs the app-role check.

The private denylist is the optional secret `MF_DENYLIST` (newline- or `|`-separated). CI still passes when that secret is absent; only the committed generic patterns run. A local list can live in gitignored `.denylist.local`.

## Layout

`src/core` is the shared core. `src/lanes/work` and `src/lanes/oversight` may import only `@/core`. `src/db/schema.ts` is the Drizzle schema. Triggers that Drizzle cannot express are in `db/sql/0001_core_guards.sql`. See `docs/ARCHITECTURE.md`.
