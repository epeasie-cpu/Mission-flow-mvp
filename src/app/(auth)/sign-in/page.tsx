import Link from "next/link";
import { listPersonas, runtimeDb } from "@/core";
import { landingFor, roleLabel } from "../../landing";
import { readAppSession } from "../../session";
import { Panel } from "../../ui";
import { signInAction, signOutAction } from "./actions";

export const dynamic = "force-dynamic";

export default async function SignInPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const params = await searchParams;
  const acting = await readAppSession();
  let personas: Awaited<ReturnType<typeof listPersonas>> = [];
  let note: string | null = null;
  if (!acting) {
    if (!process.env.DATABASE_URL) {
      note = "The database is not configured. Set DATABASE_URL, migrate, and seed to list personas.";
    } else {
      try {
        personas = await listPersonas(runtimeDb());
      } catch {
        note = "The database is not reachable. Personas appear after migrate and seed.";
      }
    }
  }

  return (
    <main className="narrow">
      <p className="kicker">Access</p>
      <h1>Sign in</h1>
      {acting ? (
        <Panel hud>
          <p>
            Signed in as <strong>{acting.session.displayName}</strong>
            {acting.billetLabel ? ` (${acting.billetLabel})` : ""}. Acting role:{" "}
            <strong>{roleLabel(acting.session.actingRole)}</strong>.
          </p>
          <p className="meta">The passcode form stays hidden while this session is open. Sign out to pick another persona.</p>
          <p className="actions">
            <Link className="btn primary" href={landingFor(acting.session.actingRole)}>
              Continue
            </Link>
          </p>
          <nav className="nav">
            <Link href="/work">Work list</Link>
            <Link href="/oversight">Oversight summary</Link>
          </nav>
          <form action={signOutAction}>
            <button type="submit">Sign out</button>
          </form>
        </Panel>
      ) : (
        <>
          <p className="lede">Pick a fictional persona and enter the shared demo passcode. There are no real accounts.</p>
          {params.error === "passcode" ? <p className="notice">That passcode was not accepted.</p> : null}
          {params.error === "role" ? <p className="notice">That role is not one this persona holds.</p> : null}
          {note ? <p className="notice">{note}</p> : null}
          <Panel hud>
            <form action={signInAction} className="stack">
              <label>
                <span>Persona</span>
                <select name="personaId" required>
                  {personas.map((persona) => (
                    <option key={persona.id} value={persona.id}>
                      {persona.displayName} — {persona.billetLabel}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>Demo passcode</span>
                <input name="passcode" type="password" autoComplete="off" required />
              </label>
              <button className="primary" type="submit">
                Sign in
              </button>
            </form>
          </Panel>
        </>
      )}
    </main>
  );
}
