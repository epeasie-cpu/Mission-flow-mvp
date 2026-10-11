/** Grant roles that watch the portfolio land on the oversight summary. Execution roles land on the work list. */
const OVERSIGHT_ROLES = new Set([
  "tasking_authority",
  "approver",
  "supervisor",
  "functional_owner",
  "task_controller",
  "system_admin",
]);

export function landingFor(actingRole: string): "/work" | "/oversight" {
  return OVERSIGHT_ROLES.has(actingRole) ? "/oversight" : "/work";
}

export function roleLabel(role: string): string {
  return role.replaceAll("_", " ");
}
