import Link from "next/link";
import { landingFor, roleLabel } from "./landing";
import { readAppSession } from "./session";
import { Panel } from "./ui";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const session = await readAppSession();
  return (
    <main>
      <p className="kicker">Synthetic tasking demo</p>
      <h1>MissionFlow</h1>
      {session ? (
        <Panel hud>
          <p className="kicker">Acting role</p>
          <h2 className="role-name">{roleLabel(session.session.actingRole)}</h2>
          <p>
            Signed in as <strong>{session.session.displayName}</strong>
            {session.billetLabel ? ` (${session.billetLabel})` : ""}. Continue to the path this role opens.
          </p>
          <p className="actions">
            <Link className="btn primary" href={landingFor(session.session.actingRole)}>
              Continue
            </Link>
          </p>
        </Panel>
      ) : null}
      <p className="lede">
        Shared core for a synthetic tasking demo. Sign in as a persona to open the work list
        or the oversight summary. Nothing here is operational.
      </p>
      <nav className="nav">
        <Link href="/work">Work path</Link>
        <Link href="/oversight">Oversight path</Link>
        <Link href="/sign-in">Sign in</Link>
      </nav>
      <Panel>
        <p>
          Local setup uses Postgres 16. The commercial drafting path stays off unless every
          deployment gate is open, and even then a session is limited to 10 drafts an hour
          and the demo to 200 a day. The template runs otherwise.
        </p>
      </Panel>
    </main>
  );
}
