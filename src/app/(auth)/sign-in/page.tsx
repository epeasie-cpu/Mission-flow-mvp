import { getIronSession } from "iron-session";
import { cookies } from "next/headers";
import Link from "next/link";
import { SESSION_COOKIE, listPersonas, runtimeDb, sessionPassword } from "@/core";
import { signInAction, switchRoleAction } from "./actions";

export const dynamic = "force-dynamic";

export default async function SignInPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const params = await searchParams;
  let personas: Awaited<ReturnType<typeof listPersonas>> = [];
  let note: string | null = null;
  let acting: { userId: string; actingRole: string } | null = null;
  if (!process.env.DATABASE_URL) {
    note = "The database is not configured. Set DATABASE_URL, migrate, and seed to list personas.";
  } else {
    try {
      personas = await listPersonas(runtimeDb());
      if (process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32) {
        const jar = await getIronSession<{ userId?: string; actingRole?: string }>(await cookies(), {
          cookieName: SESSION_COOKIE,
          password: sessionPassword(),
        });
        if (jar.userId && jar.actingRole) acting = { userId: jar.userId, actingRole: jar.actingRole };
      }
    } catch {
      note = "The database is not reachable. Personas appear after migrate and seed.";
    }
  }
  const current = personas.find((persona) => persona.id === acting?.userId);

  return (
    <main>
      <h1>Sign in</h1>
      <p className="lede">Pick a fictional persona and enter the shared demo passcode. There are no real accounts.</p>
      <p>
        <Link href="/">Back</Link>
      </p>
      {params.error === "passcode" ? <p className="card">That passcode was not accepted.</p> : null}
      {params.error === "role" ? <p className="card">That role is not one this persona holds.</p> : null}
      {note ? <p className="card">{note}</p> : null}
      {current && acting ? (
        <section className="card">
          <p>
            Signed in as <strong>{current.displayName}</strong> ({current.billetLabel}). Acting role:{" "}
            <strong>{acting.actingRole}</strong>.
          </p>
          <form action={switchRoleAction} className="stack">
            <label>
              Switch acting role
              <select name="role" defaultValue={acting.actingRole}>
                {current.heldRoles.map((role) => (
                  <option key={role} value={role}>
                    {role}
                  </option>
                ))}
              </select>
            </label>
            <button type="submit">Switch</button>
          </form>
        </section>
      ) : null}
      <form action={signInAction} className="stack card">
        <label>
          Persona
          <select name="personaId" required>
            {personas.map((persona) => (
              <option key={persona.id} value={persona.id}>
                {persona.displayName} — {persona.billetLabel}
              </option>
            ))}
          </select>
        </label>
        <label>
          Demo passcode
          <input name="passcode" type="password" autoComplete="off" required />
        </label>
        <button type="submit">Sign in</button>
      </form>
    </main>
  );
}
