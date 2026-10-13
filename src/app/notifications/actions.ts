"use server";

import { redirect } from "next/navigation";
import { actorFromSession, markAllNotificationsRead, markNotificationRead, runtimeDb } from "@/core";
import { requireAppSession } from "../session";

export async function markReadAction(formData: FormData) {
  const app = await requireAppSession();
  const id = String(formData.get("id") ?? "");
  try {
    await markNotificationRead(runtimeDb(), actorFromSession(app.session), id);
  } catch {
    redirect("/notifications");
  }
  redirect("/notifications");
}

export async function markAllReadAction() {
  const app = await requireAppSession();
  await markAllNotificationsRead(runtimeDb(), actorFromSession(app.session));
  redirect("/notifications");
}
