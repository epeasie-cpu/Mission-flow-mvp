import Link from "next/link";
import { actorFromSession, runtimeDb } from "@/core";
import { loadOversightSummary, oversightLane } from "@/lanes/oversight";
import { roleLabel } from "../../landing";
import { requireAppSession } from "../../session";

export const dynamic = "force-dynamic";

export default async function OversightPage() {
  const app = await requireAppSession();
  const summary = await loadOversightSummary(runtimeDb(), actorFromSession(app.session));
  const admin = app.session.actingRole === "system_admin";
  return (
    <main>
      <h1>{oversightLane.title}</h1>
      <p className="lede">
        Counts for taskers <strong>{app.session.displayName}</strong> can see while acting as {roleLabel(app.session.actingRole)}.
      </p>
      {admin ? <p className="card">This role does not read tasker content, so the counts stay at zero.</p> : null}
      <p className="meta">
        Counts follow the acting role. An action officer does not see a conflict or a triage item they are not assigned to. A tasking authority does.
      </p>
      <div className="stats">
        <p className="card">
          <strong>{summary.total}</strong>
          <span> visible</span>
        </p>
        <p className="card">
          <strong>{summary.conflicts}</strong>
          <span> conflicts</span>
        </p>
        <p className="card">
          <strong>{summary.triage}</strong>
          <span> in triage</span>
        </p>
      </div>
      <table>
        <thead>
          <tr>
            <th>State</th>
            <th>Count</th>
          </tr>
        </thead>
        <tbody>
          {summary.byState.map((row) => (
            <tr key={row.state}>
              <td>{row.state}</td>
              <td>{row.count}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p>
        <Link href="/work">Open the work list</Link>
      </p>
    </main>
  );
}
