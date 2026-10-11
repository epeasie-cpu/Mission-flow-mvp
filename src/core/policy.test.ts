import { describe, expect, it } from "vitest";
import { MATRIX, MATRIX_COLUMNS, MATRIX_ROLES, matrixDecision, type PolicyCtx } from "./policy";

const pairs: Record<string, { pass: PolicyCtx; fail: PolicyCtx }> = {
  "enterprise_participant.view": { pass: { assignedToResource: true }, fail: {} },
  "enterprise_participant.draft": { pass: { ownSmeInput: true }, fail: {} },
  "enterprise_participant.dashboard": { pass: { ownQueue: true }, fail: {} },
  "originator.disposition": {
    pass: { dispositionType: "cancelled_obe", beforeRelease: true },
    fail: { dispositionType: "cancelled_obe" },
  },
  "originator.dashboard": { pass: { ownQueue: true }, fail: {} },
  "tasking_authority.disposition": { pass: { dispositionType: "reassigned" }, fail: { dispositionType: "completed" } },
  "accountable_product_owner.assign": { pass: { requestReassignment: true }, fail: {} },
  "accountable_product_owner.draft": { pass: { reviewComment: true }, fail: {} },
  "accountable_product_owner.disposition": { pass: { dispositionType: "returned_for_rework" }, fail: { dispositionType: "reassigned" } },
  "ao_primary.assign": { pass: { requestSmeOrCoordinator: true }, fail: {} },
  "ao_primary.coordinate": { pass: { manageGates: true }, fail: {} },
  "ao_primary.dashboard": { pass: { ownQueue: true }, fail: {} },
  "ao_alternate.assign": { pass: { actingAlternate: true }, fail: {} },
  "ao_alternate.draft": { pass: { actingAlternate: true }, fail: {} },
  "ao_alternate.coordinate": { pass: { actingAlternate: true }, fail: {} },
  "ao_alternate.dashboard": { pass: { actingAlternate: true }, fail: {} },
  "coordinator.draft": { pass: { coordinationEnclave: true }, fail: {} },
  "coordinator.disposition": {
    pass: { ownGate: true, dispositionType: "nonconcurred" },
    fail: { ownGate: true, dispositionType: "reassigned" },
  },
  "sme_contributor.view": { pass: { ownSmeInput: true }, fail: {} },
  "sme_contributor.draft": { pass: { ownSmeInput: true }, fail: {} },
  "approver.draft": { pass: { finalEnclave: true }, fail: {} },
  "approver.coordinate": { pass: { concurrenceGate: true }, fail: {} },
  "approver.disposition": { pass: { dispositionType: "submitted" }, fail: { dispositionType: "reassigned" } },
  "supervisor.disposition": { pass: { dispositionType: "reassigned" }, fail: { dispositionType: "completed" } },
  "functional_owner.disposition": { pass: { dispositionType: "no_equity_validated" }, fail: { dispositionType: "completed" } },
  "task_controller.assign": { pass: { triageRouting: true }, fail: {} },
  "awareness.dashboard": { pass: { ownQueue: true }, fail: {} },
  "system_admin.view": { pass: {}, fail: { taskerContent: true } },
  "system_admin.assign": { pass: { roleGrantAdmin: true }, fail: {} },
  "system_admin.dashboard": { pass: { systemHealth: true }, fail: {} },
  "system_admin.registry": { pass: { technicalOps: true }, fail: {} },
  "ai.view": { pass: { inTaskerInputs: true }, fail: {} },
  "ai.draft": { pass: { stampedArtifact: true }, fail: {} },
};

describe("permission matrix", () => {
  it("decides every cell, with both outcomes when the cell is conditional", () => {
    for (const role of MATRIX_ROLES) {
      for (const column of MATRIX_COLUMNS) {
        const kind = MATRIX[role][column];
        if (kind === "yes") expect(matrixDecision(role, column, {}), `${role}.${column}`).toBe(true);
        else if (kind === "no") expect(matrixDecision(role, column, {}), `${role}.${column}`).toBe(false);
        else {
          const pair = pairs[`${role}.${column}`];
          expect(pair, `${role}.${column} needs a pass and a fail`).toBeTruthy();
          expect(matrixDecision(role, column, pair!.pass), `${role}.${column} pass`).toBe(true);
          expect(matrixDecision(role, column, pair!.fail), `${role}.${column} fail`).toBe(false);
        }
      }
    }
  });

  it("lets a supervisor return work only as internal QC", () => {
    expect(matrixDecision("supervisor", "disposition", { dispositionType: "returned_for_rework", internalQc: true })).toBe(true);
    expect(matrixDecision("supervisor", "disposition", { dispositionType: "returned_for_rework" })).toBe(false);
  });
});
