/** Who is performing a command. The acting role is copied onto every audit row. */

export type Actor =
  | { type: "user"; userId: string; actingRole: string }
  | { type: "system" }
  | { type: "ai"; requestedBy?: string };

export type Session = {
  userId: string;
  displayName: string;
  email: string;
  actingRole: string;
  globalRoles: string[];
  heldRoles: string[];
};

export const systemActor: Actor = { type: "system" };

export function actorRole(actor: Actor): string {
  if (actor.type === "user") return actor.actingRole;
  return actor.type;
}
