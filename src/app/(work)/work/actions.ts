"use server";

import { redirect } from "next/navigation";
import { actorFromSession, runtimeDb, taskers } from "@/core";
import { requireAppSession } from "../../session";

export async function acceptTaskerAction(formData: FormData) {
  const id = String(formData.get("taskerId") ?? "");
  const app = await requireAppSession();
  try {
    await taskers.accept(runtimeDb(), actorFromSession(app.session), id);
  } catch (error) {
    if (isRedirect(error)) throw error;
    redirect(`/work/taskers/${id}?notice=accept-failed`);
  }
  redirect(`/work/taskers/${id}?notice=accepted`);
}

function isRedirect(error: unknown): boolean {
  return typeof error === "object" && error !== null && "digest" in error && String((error as { digest?: string }).digest).startsWith("NEXT_REDIRECT");
}
