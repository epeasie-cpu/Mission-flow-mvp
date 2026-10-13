"use server";

import { redirect } from "next/navigation";
import { actorFromSession, createPerson, Forbidden, runtimeDb, updatePerson, ValidationError, type PersonInput } from "@/core";
import { requireAppSession } from "../session";

function personFromForm(formData: FormData): PersonInput {
  const availability = String(formData.get("availability") ?? "available");
  const allowed = ["available", "tdy", "deployed", "leave", "reassigned"] as const;
  return {
    displayName: String(formData.get("displayName") ?? ""),
    email: String(formData.get("email") ?? ""),
    orgId: String(formData.get("orgId") ?? ""),
    rank: String(formData.get("rank") ?? ""),
    billetLabel: String(formData.get("billetLabel") ?? ""),
    afsc: String(formData.get("afsc") ?? ""),
    primaryDuty: String(formData.get("primaryDuty") ?? ""),
    functions: String(formData.get("functions") ?? "").split(","),
    supervisorUserId: String(formData.get("supervisorUserId") ?? "") || null,
    leadershipTitle: String(formData.get("leadershipTitle") ?? "") || null,
    duties: String(formData.get("duties") ?? "").split(","),
    availability: allowed.includes(availability as (typeof allowed)[number]) ? (availability as (typeof allowed)[number]) : "available",
  };
}

function fail(path: string, error: unknown): never {
  const message = error instanceof ValidationError || error instanceof Forbidden ? error.message : "The directory change was not saved.";
  redirect(`${path}?error=${encodeURIComponent(message)}`);
}

export async function createPersonAction(formData: FormData) {
  const app = await requireAppSession();
  try {
    const created = await createPerson(runtimeDb(), actorFromSession(app.session), personFromForm(formData));
    redirect(`/directory/${created.id}?notice=created`);
  } catch (error) {
    if (isRedirect(error)) throw error;
    fail("/directory/new", error);
  }
}

export async function updatePersonAction(formData: FormData) {
  const app = await requireAppSession();
  const userId = String(formData.get("userId") ?? "");
  try {
    await updatePerson(runtimeDb(), actorFromSession(app.session), userId, personFromForm(formData));
    redirect(`/directory/${userId}?notice=updated`);
  } catch (error) {
    if (isRedirect(error)) throw error;
    fail(`/directory/${userId}`, error);
  }
}

function isRedirect(error: unknown): boolean {
  return typeof error === "object" && error !== null && "digest" in error && String((error as { digest?: string }).digest).startsWith("NEXT_REDIRECT");
}
