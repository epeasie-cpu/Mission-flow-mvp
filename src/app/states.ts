export type StateTone =
  | "assigned"
  | "work"
  | "coordination"
  | "approval"
  | "conflict"
  | "triage"
  | "closed"
  | "neutral"
  | "gold";

const STATES: Record<string, { label: string; tone: StateTone }> = {
  ASSIGNED: { label: "Assigned", tone: "assigned" },
  IN_WORK: { label: "In work", tone: "work" },
  IN_COORDINATION: { label: "Coordination", tone: "coordination" },
  AWAITING_APPROVAL: { label: "Approval", tone: "approval" },
  SUSPENSE_CONFLICT: { label: "Conflict", tone: "conflict" },
  TRIAGE: { label: "Triage", tone: "triage" },
  CLOSED: { label: "Closed", tone: "closed" },
  DRAFT: { label: "Draft", tone: "neutral" },
  PENDING_RELEASE: { label: "Pending", tone: "neutral" },
  CLARIFICATION: { label: "Clarification", tone: "neutral" },
};

export function presentState(state: string): { label: string; tone: StateTone } {
  return STATES[state] ?? { label: state.replaceAll("_", " "), tone: "neutral" };
}
