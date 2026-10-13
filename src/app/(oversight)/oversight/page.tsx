import Link from "next/link";
import { actorFromSession, runtimeDb } from "@/core";
import { loadOversightSummary, oversightLane } from "@/lanes/oversight";
import { roleLabel } from "../../landing";
import { requireAppSession } from "../../session";
import { presentState } from "../../states";
import { Panel, StatTile } from "../../ui";

export const dynamic = "force-dynamic";

export default async function OversightPage() {
  const app = await requireAppSession();
  const summary = await loadOversightSummary(runtimeDb(), actorFromSession(app.session));
  const admin = app.session.actingRole === "system_admin";
  return (
    <main>
      <Panel hud>
        <p className="kicker">Oversight summary</p>
        <h1>{oversightLane.title}</h1>
        <p className="lede">
          Counts for taskers <strong>{app.session.displayName}</strong> can see while acting as {roleLabel(app.session.actingRole)}.
        </p>
        {admin ? <p className="notice">This role does not read tasker content, so the counts stay at zero.</p> : null}
        <p className="meta">
          Counts follow the acting role. An action officer does not see a conflict or a triage item they are not assigned to. A tasking authority does.
        </p>
      </Panel>
      <div className="stat-strip">
        <StatTile value={summary.total} label="Visible" tone="gold" />
        <StatTile value={summary.conflicts} label="Conflicts" tone="conflict" />
        <StatTile value={summary.triage} label="Triage" tone="triage" />
        {summary.byState.map((row) => {
          const presented = presentState(row.state);
          return <StatTile key={row.state} value={row.count} label={presented.label} tone={presented.tone} />;
        })}
      </div>
      <p>
        <Link href="/work">Open the work list</Link>
      </p>
    </main>
  );
}
