"use server";

import { actorFromSession, can, Forbidden, issueRoutedTasking, matchActionOfficers, runtimeDb, ValidationError } from "@/core";
import { requireAppSession } from "../../../../session";

type Criteria = {
  orgIds: string[];
  afscs: string[];
  duty: string;
  additionalDuty: string;
  userIds: string[];
};

export async function previewRoutingAction(criteria: Criteria) {
  const app = await requireAppSession();
  const actor = actorFromSession(app.session);
  const allowed = await can(runtimeDb(), actor, "tasker.create");
  if (!allowed) return { matches: [], error: "This acting role cannot route a tasker." };
  const matches = await matchActionOfficers(runtimeDb(), criteria);
  return {
    error: null as string | null,
    matches: matches.map((match) => ({
      id: match.id,
      displayName: match.displayName,
      rank: match.rank,
      orgName: match.orgName,
      afsc: match.afsc,
      duties: match.duties,
      billetLabel: match.billetLabel,
    })),
  };
}

export async function createRoutedTaskerAction(formData: FormData): Promise<{ taskerId?: string; count?: number; error?: string }> {
  const app = await requireAppSession();
  const priority = String(formData.get("priority") ?? "routine");
  if (priority !== "routine" && priority !== "priority") return { error: "Priority must be routine or priority." };
  const files = formData
    .getAll("file")
    .filter((item): item is File => item instanceof File && item.size > 0);
  try {
    const issued = await issueRoutedTasking(runtimeDb(), actorFromSession(app.session), {
      title: String(formData.get("title") ?? ""),
      description: String(formData.get("description") ?? ""),
      externalSuspense: String(formData.get("suspense") ?? ""),
      priority,
      category: "awards_package",
      criteria: {
        orgIds: formData.getAll("orgId").map(String).filter(Boolean),
        afscs: String(formData.get("afscs") ?? "")
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean),
        duty: String(formData.get("duty") ?? ""),
        additionalDuty: String(formData.get("additionalDuty") ?? ""),
        userIds: formData.getAll("userId").map(String).filter(Boolean),
      },
      files: await Promise.all(
        files.map(async (file) => ({
          fileName: file.name,
          mime: file.type,
          content: Buffer.from(await file.arrayBuffer()),
        })),
      ),
    });
    const featured = issued.taskers.find((row) => row.assigneeName === "Blake Pell") ?? issued.taskers[0];
    return { taskerId: featured?.id, count: issued.taskers.length };
  } catch (error) {
    if (error instanceof ValidationError || error instanceof Forbidden) return { error: error.message };
    throw error;
  }
}
