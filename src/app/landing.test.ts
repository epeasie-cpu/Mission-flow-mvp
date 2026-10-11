import { describe, expect, it } from "vitest";
import { landingFor } from "./landing";

describe("landing page", () => {
  it("sends execution roles to the work list and portfolio roles to oversight", () => {
    expect(landingFor("originator")).toBe("/work");
    expect(landingFor("ao_primary")).toBe("/work");
    expect(landingFor("ao_alternate")).toBe("/work");
    expect(landingFor("coordinator")).toBe("/work");
    expect(landingFor("enterprise_participant")).toBe("/work");
    expect(landingFor("tasking_authority")).toBe("/oversight");
    expect(landingFor("approver")).toBe("/oversight");
    expect(landingFor("supervisor")).toBe("/oversight");
    expect(landingFor("functional_owner")).toBe("/oversight");
    expect(landingFor("task_controller")).toBe("/oversight");
    expect(landingFor("system_admin")).toBe("/oversight");
  });
});
