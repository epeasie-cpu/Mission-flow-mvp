import { describe, expect, it } from "vitest";
import { formatCountdown } from "./format";

describe("formatCountdown", () => {
  it("formats a remaining suspense as T-minus days and hours", () => {
    const now = new Date("2026-10-13T09:00:00.000Z");
    expect(formatCountdown("2026-10-14", now)).toEqual({ text: "T−1D 14H", overdue: false });
  });

  it("formats an overdue suspense with a plus and an overdue flag", () => {
    const now = new Date("2026-10-15T12:00:00.000Z");
    expect(formatCountdown("2026-10-14", now)).toEqual({ text: "T+0D 12H", overdue: true });
  });

  it("leaves a non-date string untouched", () => {
    expect(formatCountdown("open", new Date("2026-10-13T00:00:00.000Z"))).toEqual({
      text: "open",
      overdue: false,
    });
  });
});
