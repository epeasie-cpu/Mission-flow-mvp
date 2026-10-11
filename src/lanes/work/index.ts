import { can, reads, syntheticBanner, type Actor, type CoreDb } from "@/core";

export const workLane = {
  id: "work" as const,
  title: "Work path",
  banner: syntheticBanner,
};

export async function loadWorkList(db: CoreDb, actor: Actor) {
  return reads.listVisibleTaskers(db, actor);
}

export async function loadWorkTasker(db: CoreDb, actor: Actor, id: string) {
  const detail = await reads.readTaskerDetail(db, actor, id);
  const mayAccept = detail.tasker.state === "ASSIGNED" && (await can(db, actor, "tasker.accept", { taskerId: id }));
  return { ...detail, mayAccept };
}
