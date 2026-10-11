"use server";

import { getIronSession } from "iron-session";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { loadPersona, runtimeDb, signInAsPersona, signOut, switchActingRole } from "@/core";
import { landingFor } from "../../landing";
import { sessionOptions } from "../../session";

export async function signInAction(formData: FormData) {
  const personaId = String(formData.get("personaId") ?? "");
  const passcode = String(formData.get("passcode") ?? "");
  let next = "/sign-in?error=passcode";
  try {
    const { session } = await signInAsPersona(runtimeDb(), personaId, passcode);
    const jar = await getIronSession<{ userId: string; actingRole: string }>(await cookies(), sessionOptions());
    jar.userId = session.userId;
    jar.actingRole = session.actingRole;
    await jar.save();
    next = landingFor(session.actingRole);
  } catch (error) {
    if (isRedirect(error)) throw error;
  }
  redirect(next);
}

export async function switchRoleAction(formData: FormData) {
  const role = String(formData.get("role") ?? "");
  const jar = await getIronSession<{ userId?: string; actingRole?: string }>(await cookies(), sessionOptions());
  if (!jar.userId || !jar.actingRole) redirect("/sign-in");
  let next = "/sign-in?error=role";
  try {
    const loaded = await loadPersona(runtimeDb(), jar.userId, jar.actingRole);
    if (!loaded) redirect("/sign-in");
    const { session } = await switchActingRole(runtimeDb(), loaded.session, role);
    jar.actingRole = session.actingRole;
    await jar.save();
    next = landingFor(session.actingRole);
  } catch (error) {
    if (isRedirect(error)) throw error;
  }
  redirect(next);
}

export async function signOutAction() {
  const jar = await getIronSession<{ userId?: string; actingRole?: string }>(await cookies(), sessionOptions());
  if (jar.userId) {
    try {
      const loaded = await loadPersona(runtimeDb(), jar.userId, jar.actingRole);
      if (loaded) await signOut(runtimeDb(), loaded.session);
    } catch {
      // The cookie still has to go, even if the audit write fails.
    }
  }
  jar.destroy();
  redirect("/sign-in");
}

function isRedirect(error: unknown): boolean {
  return typeof error === "object" && error !== null && "digest" in error && String((error as { digest?: string }).digest).startsWith("NEXT_REDIRECT");
}
