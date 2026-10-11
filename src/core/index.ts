import { auth } from "../config/missionflow.config";
import { formatBanner } from "./internal/banner";

/** Shown on every page. Synthetic data only. */
export const syntheticBanner = formatBanner(auth.syntheticBanner);

export {
  AI_DRAFT_STAMP,
  AI_SPEND_CAPS,
  AUDIT_EVENTS,
  ECHELON_RANK,
  closingDispositions,
  defaultTransmitToHigherHq,
  enforceAiSpendCaps,
  fallbackToTemplate,
  pilot,
  resolveAiProvider,
  signDisposition,
  validateConfig,
} from "../config/missionflow.config";

export { Conflict, Forbidden, InvalidTransition, NotFound, ValidationError } from "./errors";
export { SESSION_COOKIE, actorFromSession, listPersonas, loadPersona, readSessionFromSeal, sessionPassword, signInAsPersona, signOut, switchActingRole } from "./auth";
export type { Actor, Session } from "./actor";
export type { CoreDb } from "./db";
export * as reads from "./reads";
export { auditForTasker, clearSubscribers, dispatchOutbox, subscribe, verifyChain } from "./audit";
export { MATRIX, MATRIX_COLUMNS, MATRIX_ROLES, can, matrixDecision } from "./policy";
export { businessDayStartUtc, computeSuspensePlan, subtractBusinessDays } from "./suspense";
export { matchTasker } from "./match";
export { seedDemo, FEDERAL_HOLIDAYS, SEED_NOW } from "./seed";
export { runtimeDb } from "./runtime";
export * as registry from "./registry";
export * as taskers from "./lifecycle";
export * as gates from "./gates";
export * as sme from "./sme";
export * as docs from "./docs";
export * as ai from "./ai";
