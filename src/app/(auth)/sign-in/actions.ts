"use server";

import { getIronSession, type SessionOptions } from "iron-session";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { SESSION_COOKIE, runtimeDb, sessionPassword, signInAsPersona, switchActingRole } from "@/core";

function options(): SessionOptions {
  return {
    cookieName: SESSION_COOKIE,
    password: sessionPassword(),
    cookieOptions: { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/" },
  };
}

export async function signInAction(formData: FormData) {
  const personaId = String(formData.get("personaId") ?? "");
  const passcode = String(formData.get("passcode") ?? "");
  try {
    const { session } = await signInAsPersona(runtimeDb(), personaId, passcode);
    const jar = await getIronSession<{ userId: string; actingRole: string }>(await cookies(), options());
    jar.userId = session.userId;
    jar.actingRole = session.actingRole;
    await jar.save();
  } catch {
    redirect("/sign-in?error=passcode");
  }
  redirect("/sign-in");
}

export async function switchRoleAction(formData: FormData) {
  const role = String(formData.get("role") ?? "");
  const jar = await getIronSession<{ userId?: string; actingRole?: string }>(await cookies(), options());
  if (!jar.userId || !jar.actingRole) redirect("/sign-in");
  try {
    const { session } = await switchActingRole(
      runtimeDb(),
      {
        userId: jar.userId,
        actingRole: jar.actingRole,
        displayName: "",
        email: "",
        globalRoles: [],
        heldRoles: [],
      },
      role,
    );
    jar.actingRole = session.actingRole;
    await jar.save();
  } catch {
    redirect("/sign-in?error=role");
  }
  redirect("/sign-in");
}
