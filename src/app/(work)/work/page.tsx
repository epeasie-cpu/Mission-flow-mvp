import Link from "next/link";
import { actorFromSession, runtimeDb } from "@/core";
import { loadWorkList, workLane } from "@/lanes/work";
import { roleLabel } from "../../landing";
import { requireAppSession } from "../../session";
import { Panel, StateBadge, SuspenseReadout } from "../../ui";

export const dynamic = "force-dynamic";

export default async function WorkPage() {
  const app = await requireAppSession();
  const rows = await loadWorkList(runtimeDb(), actorFromSession(app.session));
  return (
    <main>
      <Panel hud>
        <p className="kicker">Tasker list</p>
        <h1>{workLane.title}</h1>
        <p className="lede">
          Taskers visible to <strong>{app.session.displayName}</strong> acting as {roleLabel(app.session.actingRole)}.
        </p>
      </Panel>
      {rows.length === 0 ? (
        <p className="panel">No taskers are visible to this acting role.</p>
      ) : (
        <div className="table-wrap">
          <table className="grid">
            <thead>
              <tr>
                <th scope="col">ID</th>
                <th scope="col">Title</th>
                <th scope="col">State</th>
                <th scope="col">Suspense</th>
                <th scope="col">AO</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td className="mono">
                    <Link href={`/work/taskers/${row.id}`}>{row.ref}</Link>
                  </td>
                  <td>{row.title}</td>
                  <td>
                    <StateBadge state={row.state} />
                  </td>
                  <td>
                    <SuspenseReadout iso={row.externalSuspense} conflict={row.state === "SUSPENSE_CONFLICT"} />
                  </td>
                  <td>{row.aoName ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
