import { getIronSession, type SessionOptions } from "iron-session";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { SESSION_COOKIE, loadPersona, runtimeDb, sessionPassword, type Session } from "@/core";

export type AppSession = {
  session: Session;
  billetLabel: string;
};

export function sessionOptions(): SessionOptions {
  return {
    cookieName: SESSION_COOKIE,
    password: sessionPassword(),
    cookieOptions: { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/" },
  };
}

export async function readAppSession(): Promise<AppSession | null> {
  if (!process.env.DATABASE_URL || !process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32) return null;
  try {
    const jar = await getIronSession<{ userId?: string; actingRole?: string }>(await cookies(), sessionOptions());
    if (!jar.userId || !jar.actingRole) return null;
    const loaded = await loadPersona(runtimeDb(), jar.userId, jar.actingRole);
    if (!loaded) return null;
    return { session: loaded.session, billetLabel: loaded.billetLabel };
  } catch {
    return null;
  }
}

export async function requireAppSession(): Promise<AppSession> {
  const current = await readAppSession();
  if (!current) redirect("/sign-in");
  return current;
}
