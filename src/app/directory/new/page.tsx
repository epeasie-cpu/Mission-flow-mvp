import Link from "next/link";
import { listDirectory, listOrgUnits, runtimeDb } from "@/core";
import { requireAppSession } from "../../session";
import { Panel } from "../../ui";
import { PersonForm } from "../person-form";

export const dynamic = "force-dynamic";

export default async function NewPersonPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const app = await requireAppSession();
  const query = await searchParams;
  if (app.session.actingRole !== "system_admin") {
    return (
      <main>
        <h1>Directory</h1>
        <p className="notice">Only the system administrator can add people.</p>
      </main>
    );
  }
  const [units, people] = await Promise.all([listOrgUnits(runtimeDb()), listDirectory(runtimeDb())]);
  return (
    <main className="narrow">
      <p className="crumb">
        <Link href="/directory">Directory</Link>
      </p>
      <Panel hud>
        <p className="kicker">Personnel</p>
        <h1>Add person</h1>
        <p className="lede">Use a fictional name and an @example.test email. The audit log records the insert.</p>
        {query.error ? <p className="notice">{query.error}</p> : null}
        <PersonForm
          mode="create"
          orgs={units.map((unit) => ({ id: unit.id, name: unit.name }))}
          people={people.map((person) => ({ id: person.id, displayName: person.displayName, rank: person.rank }))}
        />
      </Panel>
    </main>
  );
}
