// v0.2 config dry run (G15, G17, G18, G19). Run under several process TZs: results must not change.
import {
  validateConfig, ConfigError, businessToday, isSuspenseConflict, resolveAiProvider, signDisposition,
  closingDispositions, isClosingDisposition, pilot, suspense,
  defaultTransmitToHigherHq, enforceAiSpendCaps, fallbackToTemplate, ECHELON_RANK, AI_SPEND_CAPS,
  TEMPLATE_MODEL_ID,
} from "../src/config/missionflow.config";

let pass = 0, fail = 0;
const t = (name: string, cond: boolean, extra = "") => { cond ? pass++ : fail++; console.log(cond ? "PASS" : "FAIL", name, extra); };
const throws = (fn: () => void) => { try { fn(); return false; } catch (e) { return e instanceof ConfigError; } };

console.log(`(process TZ=${process.env.TZ ?? "unset"}, resolved ${Intl.DateTimeFormat().resolvedOptions().timeZone})`);
// Approved defaults
t("pilot = awards_package only (RFI next)", pilot.enabledCategories.join() === "awards_package" && pilot.nextCategory === "rfi");
t("closing set = completed, submitted, no_equity_validated, cancelled_obe", [...closingDispositions].sort().join() === "cancelled_obe,completed,no_equity_validated,submitted");
t("AO window <35% warns only (threshold 0.35)", suspense.aoWindowWarnBelowPct === 0.35);
t("concurred is not closing", !isClosingDisposition("concurred"));
// G15 validator
t("validateConfig accepts the approved closing set", !throws(() => validateConfig()));
t("validateConfig refuses reassigned as closing", throws(() => validateConfig([...closingDispositions, "reassigned"])));
t("validateConfig refuses returned_for_rework as closing", throws(() => validateConfig([...closingDispositions, "returned_for_rework"])));
t("N1 removing a closing type without a non-closing target is refused", throws(() => validateConfig(["completed", "submitted", "no_equity_validated"])));
t("N2 validateConfig refuses concurred as closing", throws(() => validateConfig([...closingDispositions, "concurred"])));
t("N2 validateConfig refuses nonconcurred as closing", throws(() => validateConfig([...closingDispositions, "nonconcurred"])));
t("N9 center originator outranks a wing approver", defaultTransmitToHigherHq("center", "wing") === true);
t("N9 naf equals center, so transmit defaults false", defaultTransmitToHigherHq("naf", "center") === false && ECHELON_RANK.naf === ECHELON_RANK.center);
t(
  "N9 rank order haf > majcom > center = naf > wing > group > squadron > flight",
  ECHELON_RANK.haf > ECHELON_RANK.majcom &&
    ECHELON_RANK.majcom > ECHELON_RANK.center &&
    ECHELON_RANK.center === ECHELON_RANK.naf &&
    ECHELON_RANK.naf > ECHELON_RANK.wing &&
    ECHELON_RANK.wing > ECHELON_RANK.group &&
    ECHELON_RANK.group > ECHELON_RANK.squadron &&
    ECHELON_RANK.squadron > ECHELON_RANK.flight,
);
// G17
t("sign: transmit=true → submitted", signDisposition(true) === "submitted");
t("sign: transmit=false → completed", signDisposition(false) === "completed");
// G18 — 23:30 America/Chicago on 2026-10-09 is 04:30 UTC on 2026-10-10
const now = new Date("2026-10-10T04:30:00Z");
t("businessToday at 23:30 CDT = 2026-10-09 (not the UTC date)", businessToday(now) === "2026-10-09", businessToday(now));
t("latest AO date = D is NOT a conflict", !isSuspenseConflict("2026-10-09", now));
t("latest AO date = D-1 IS a conflict", isSuspenseConflict("2026-10-08", now));
// G19 (approved): gateway only in the production public-demo deployment
const base = { MF_AI_COMMERCIAL_ENABLED: "true", MF_DEPLOYMENT: "public-demo", VERCEL_ENV: "production" };
const r1 = resolveAiProvider(base);
t("public-demo + production + flag → vercel_ai_gateway openai/gpt-5.4-nano", r1.provider === "vercel_ai_gateway" && r1.model === "openai/gpt-5.4-nano", JSON.stringify(r1));
t("fallback = anthropic/claude-haiku-4.5", r1.provider === "vercel_ai_gateway" && r1.fallbacks.join() === "anthropic/claude-haiku-4.5");
t("kill switch: flag off or unset → template", resolveAiProvider({ ...base, MF_AI_COMMERCIAL_ENABLED: "false" }).provider === "template" && resolveAiProvider({ ...base, MF_AI_COMMERCIAL_ENABLED: undefined }).provider === "template");
t("local (no MF_DEPLOYMENT) → template", resolveAiProvider({ MF_AI_COMMERCIAL_ENABLED: "true" }).provider === "template");
t("public-demo PREVIEW env → template", resolveAiProvider({ ...base, VERCEL_ENV: "preview" }).provider === "template");
t("other deployment name → template", resolveAiProvider({ ...base, MF_DEPLOYMENT: "staging" }).provider === "template");
t("unapproved model via env → template", resolveAiProvider({ ...base, MF_AI_GATEWAY_MODEL: "openai/gpt-5.4-mini" }).provider === "template");
t("env may switch to the other approved model", (resolveAiProvider({ ...base, MF_AI_GATEWAY_MODEL: "anthropic/claude-haiku-4.5" }) as { model: string }).model === "anthropic/claude-haiku-4.5");
const underCap = enforceAiSpendCaps(r1, {
  sessionDraftsThisHour: AI_SPEND_CAPS.draftsPerSessionPerHour - 1,
  globalDraftsToday: AI_SPEND_CAPS.draftsPerDay - 1,
});
t("N11 under both spend caps the gateway still runs", underCap.provider === "vercel_ai_gateway");
const sessionCapped = enforceAiSpendCaps(r1, { sessionDraftsThisHour: AI_SPEND_CAPS.draftsPerSessionPerHour, globalDraftsToday: 0 });
t("N11 10 drafts/hour falls back to the template with a notice", sessionCapped.provider === "template" && "notice" in sessionCapped && Boolean(sessionCapped.notice));
const dayCapped = enforceAiSpendCaps(r1, { sessionDraftsThisHour: 0, globalDraftsToday: AI_SPEND_CAPS.draftsPerDay });
t("N11 200 drafts/day falls back to the template with a notice", dayCapped.provider === "template" && "notice" in dayCapped && Boolean(dayCapped.notice));
const gatewayError = fallbackToTemplate("gateway error");
t("N11 a gateway error yields a template artifact", gatewayError.provider === "template" && gatewayError.model === TEMPLATE_MODEL_ID);

console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
