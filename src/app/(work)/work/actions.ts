"use server";

import { redirect } from "next/navigation";
import { actorFromSession, Forbidden, runtimeDb, taskers, uploadStoredDocument, ValidationError } from "@/core";
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

export async function uploadTaskerFileAction(formData: FormData) {
  const id = String(formData.get("taskerId") ?? "");
  const file = formData.get("file");
  const app = await requireAppSession();
  if (!(file instanceof File) || file.size === 0) redirect(`/work/taskers/${id}?notice=upload-failed`);
  try {
    await uploadStoredDocument(runtimeDb(), actorFromSession(app.session), id, {
      fileName: file.name,
      mime: file.type,
      content: Buffer.from(await file.arrayBuffer()),
    });
  } catch (error) {
    if (isRedirect(error)) throw error;
    if (error instanceof ValidationError || error instanceof Forbidden) redirect(`/work/taskers/${id}?notice=upload-failed`);
    throw error;
  }
  redirect(`/work/taskers/${id}?notice=uploaded`);
}

function isRedirect(error: unknown): boolean {
  return typeof error === "object" && error !== null && "digest" in error && String((error as { digest?: string }).digest).startsWith("NEXT_REDIRECT");
}
