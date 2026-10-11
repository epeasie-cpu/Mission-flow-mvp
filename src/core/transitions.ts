import type { TaskerState } from "../config/missionflow.config";
import { InvalidTransition } from "./errors";

export type TransitionAction =
  | "submit_for_release"
  | "flag_conflict"
  | "clear_conflict"
  | "enter_triage"
  | "release"
  | "adjudicate_prerelease"
  | "accept"
  | "request_clarification"
  | "answer_clarification"
  | "claim_no_equity"
  | "open_coordination"
  | "route_to_approval"
  | "elevate"
  | "reassign"
  | "return_for_rework"
  | "nonconcur_move"
  | "sign"
  | "cancel"
  | "no_equity_validated"
  | "equity_confirmed";

type Edge = { from: readonly TaskerState[]; action: TransitionAction; to: TaskerState };

const EDGES: readonly Edge[] = [
  { from: ["DRAFT"], action: "submit_for_release", to: "PENDING_RELEASE" },
  { from: ["PENDING_RELEASE"], action: "flag_conflict", to: "SUSPENSE_CONFLICT" },
  { from: ["PENDING_RELEASE"], action: "enter_triage", to: "TRIAGE" },
  { from: ["PENDING_RELEASE"], action: "release", to: "ASSIGNED" },
  { from: ["SUSPENSE_CONFLICT"], action: "clear_conflict", to: "PENDING_RELEASE" },
  { from: ["TRIAGE"], action: "adjudicate_prerelease", to: "PENDING_RELEASE" },
  { from: ["TRIAGE"], action: "reassign", to: "ASSIGNED" },
  { from: ["TRIAGE"], action: "equity_confirmed", to: "ASSIGNED" },
  { from: ["TRIAGE"], action: "no_equity_validated", to: "CLOSED" },
  { from: ["ASSIGNED"], action: "accept", to: "IN_WORK" },
  { from: ["ASSIGNED"], action: "request_clarification", to: "CLARIFICATION" },
  { from: ["ASSIGNED"], action: "claim_no_equity", to: "TRIAGE" },
  { from: ["ASSIGNED"], action: "reassign", to: "ASSIGNED" },
  { from: ["CLARIFICATION"], action: "answer_clarification", to: "ASSIGNED" },
  { from: ["CLARIFICATION"], action: "reassign", to: "ASSIGNED" },
  { from: ["IN_WORK"], action: "open_coordination", to: "IN_COORDINATION" },
  { from: ["IN_WORK"], action: "route_to_approval", to: "AWAITING_APPROVAL" },
  { from: ["IN_WORK"], action: "elevate", to: "AWAITING_APPROVAL" },
  { from: ["IN_WORK"], action: "claim_no_equity", to: "TRIAGE" },
  { from: ["IN_WORK"], action: "reassign", to: "ASSIGNED" },
  { from: ["IN_COORDINATION"], action: "nonconcur_move", to: "IN_WORK" },
  { from: ["IN_COORDINATION"], action: "route_to_approval", to: "AWAITING_APPROVAL" },
  { from: ["IN_COORDINATION"], action: "return_for_rework", to: "IN_WORK" },
  { from: ["IN_COORDINATION"], action: "reassign", to: "ASSIGNED" },
  { from: ["AWAITING_APPROVAL"], action: "sign", to: "CLOSED" },
  { from: ["AWAITING_APPROVAL"], action: "return_for_rework", to: "IN_WORK" },
  { from: ["AWAITING_APPROVAL"], action: "reassign", to: "ASSIGNED" },
];

const NON_TERMINAL: readonly TaskerState[] = [
  "DRAFT",
  "PENDING_RELEASE",
  "SUSPENSE_CONFLICT",
  "TRIAGE",
  "ASSIGNED",
  "CLARIFICATION",
  "IN_WORK",
  "IN_COORDINATION",
  "AWAITING_APPROVAL",
];

export function transitionTo(from: TaskerState, action: TransitionAction): TaskerState {
  if (from === "CLOSED") throw new InvalidTransition(`CLOSED has no further transition (${action})`);
  if (action === "cancel") {
    if (!NON_TERMINAL.includes(from)) throw new InvalidTransition("cancel");
    return "CLOSED";
  }
  const edge = EDGES.find((item) => item.action === action && item.from.includes(from));
  if (!edge) throw new InvalidTransition(`${action} is not allowed from ${from}`);
  return edge.to;
}

export function actionsFrom(state: TaskerState): TransitionAction[] {
  if (state === "CLOSED") return [];
  const actions = EDGES.filter((edge) => edge.from.includes(state)).map((edge) => edge.action);
  actions.push("cancel");
  return actions;
}

export function isNonTerminal(state: TaskerState): boolean {
  return NON_TERMINAL.includes(state);
}
