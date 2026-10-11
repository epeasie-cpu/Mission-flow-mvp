import { describe, expect, it } from "vitest";
import {
  AI_SPEND_CAPS,
  defaultTransmitToHigherHq,
  enforceAiSpendCaps,
  fallbackToTemplate,
  resolveAiProvider,
  syntheticBanner,
} from "./index";

const gatewayEnv = {
  MF_AI_COMMERCIAL_ENABLED: "true",
  MF_DEPLOYMENT: "public-demo",
  VERCEL_ENV: "production",
};

describe("shared core public entry", () => {
  it("exposes the synthetic banner", () => {
    expect(syntheticBanner).toBe("SYNTHETIC DEMO DATA – NOT FOR OPERATIONAL USE");
  });

  it("keeps the commercial path off unless every gate is open", () => {
    expect(resolveAiProvider({}).provider).toBe("template");
    expect(resolveAiProvider({ MF_AI_COMMERCIAL_ENABLED: "true" }).provider).toBe("template");
    expect(resolveAiProvider(gatewayEnv).provider).toBe("vercel_ai_gateway");
  });

  it("treats naf and center as the same rank", () => {
    expect(defaultTransmitToHigherHq("center", "wing")).toBe(true);
    expect(defaultTransmitToHigherHq("naf", "center")).toBe(false);
  });

  it("falls back to the template when a spend cap is reached", () => {
    const selected = resolveAiProvider(gatewayEnv);
    const capped = enforceAiSpendCaps(selected, {
      sessionDraftsThisHour: AI_SPEND_CAPS.draftsPerSessionPerHour,
      globalDraftsToday: 0,
    });
    expect(capped.provider).toBe("template");
    expect(capped.provider === "template" && capped.notice).toBeTruthy();
    expect(fallbackToTemplate("gateway error").provider).toBe("template");
  });
});
