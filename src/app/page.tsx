import Link from "next/link";

export default function HomePage() {
  return (
    <main>
      <h1>MissionFlow</h1>
      <p className="lede">
        Shared core for a synthetic tasking demo. Personas, the audit trail, and both lanes
        are built on this database. Nothing here is operational.
      </p>
      <nav className="nav">
        <Link href="/work">Work path</Link>
        <Link href="/oversight">Oversight path</Link>
        <Link href="/sign-in">Sign in</Link>
      </nav>
      <section className="card">
        <p>
          Local setup uses Postgres 16. The commercial drafting path stays off unless every
          deployment gate is open, and even then a session is limited to 10 drafts an hour
          and the demo to 200 a day. The template runs otherwise.
        </p>
      </section>
    </main>
  );
}
