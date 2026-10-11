import { reads, syntheticBanner, type Actor, type CoreDb } from "@/core";

export const oversightLane = {
  id: "oversight" as const,
  title: "Oversight path",
  banner: syntheticBanner,
};

export async function loadOversightSummary(db: CoreDb, actor: Actor) {
  return reads.summarizeVisible(db, actor);
}
