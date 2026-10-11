import Link from "next/link";
import { actorFromSession, runtimeDb } from "@/core";
import { loadWorkList, workLane } from "@/lanes/work";
import { roleLabel } from "../../landing";
import { requireAppSession } from "../../session";

export const dynamic = "force-dynamic";

export default async function WorkPage() {
  const app = await requireAppSession();
  const rows = await loadWorkList(runtimeDb(), actorFromSession(app.session));
  return (
    <main>
      <h1>{workLane.title}</h1>
      <p className="lede">
        Taskers visible to <strong>{app.session.displayName}</strong> acting as {roleLabel(app.session.actingRole)}.
      </p>
      {rows.length === 0 ? (
        <p className="card">No taskers are visible to this acting role.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>ID</th>
              <th>Title</th>
              <th>State</th>
              <th>Suspense</th>
              <th>AO</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <td>
                  <Link href={`/work/taskers/${row.id}`}>{row.ref}</Link>
                </td>
                <td>{row.title}</td>
                <td>{row.state}</td>
                <td>{row.externalSuspense}</td>
                <td>{row.aoName ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}
