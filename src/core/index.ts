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
