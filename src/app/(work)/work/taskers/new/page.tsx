import Link from "next/link";
import { listDirectory, listDutyNames, listOrgUnits, runtimeDb } from "@/core";
import { requireAppSession } from "../../../../session";
import { Panel } from "../../../../ui";
import { CreateTaskerForm } from "./create-form";

export const dynamic = "force-dynamic";

const UNIT_ECHELONS = new Set(["wing", "group", "squadron"]);

export default async function NewTaskerPage() {
  const app = await requireAppSession();
  const canCreate = app.session.actingRole === "originator" || app.session.actingRole === "tasking_authority";
  const [units, people, duties] = await Promise.all([
    listOrgUnits(runtimeDb()),
    listDirectory(runtimeDb()),
    listDutyNames(runtimeDb()),
  ]);
  const orgs = units
    .filter((unit) => UNIT_ECHELONS.has(unit.echelon))
    .sort((a, b) => a.name.localeCompare(b.name));
  return (
    <main>
      <p className="crumb">
        <Link href="/work">All taskers</Link>
      </p>
      <Panel hud>
        <p className="kicker">Tasking authority</p>
        <h1>Create tasker</h1>
        <p className="lede">
          Set the suspense and the routing criteria. The preview lists the action officers who will be assigned before you submit.
        </p>
      </Panel>
      {canCreate ? (
        <CreateTaskerForm
          orgs={orgs.map((unit) => ({ id: unit.id, name: unit.name, echelon: unit.echelon }))}
          people={people.map((person) => ({
            id: person.id,
            displayName: person.displayName,
            rank: person.rank,
            orgName: person.orgName,
          }))}
          duties={duties}
        />
      ) : (
        <p className="notice">Switch to tasking authority or originator to create a tasker.</p>
      )}
    </main>
  );
}
