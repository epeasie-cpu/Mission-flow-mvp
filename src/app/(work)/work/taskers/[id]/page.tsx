import Link from "next/link";
import { actorFromSession, NotFound, runtimeDb } from "@/core";
import { loadWorkTasker } from "@/lanes/work";
import { roleLabel } from "../../../../landing";
import { requireAppSession } from "../../../../session";
import { acceptTaskerAction } from "../../actions";

export const dynamic = "force-dynamic";

export default async function TaskerPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ notice?: string }>;
}) {
  const { id } = await params;
  const query = await searchParams;
  const app = await requireAppSession();
  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    return <Missing />;
  }
  let detail: Awaited<ReturnType<typeof loadWorkTasker>>;
  try {
    detail = await loadWorkTasker(runtimeDb(), actorFromSession(app.session), id);
  } catch (error) {
    if (error instanceof NotFound) return <Missing />;
    throw error;
  }
  const { tasker } = detail;
  return (
    <main>
      <p>
        <Link href="/work">All taskers</Link>
      </p>
      <h1>{tasker.ref}</h1>
      <p className="lede">{tasker.title}</p>
      {query.notice === "accepted" ? <p className="card">Accepted. The audit log records tasker.accepted.</p> : null}
      {query.notice === "accept-failed" ? <p className="card">Accept was not applied for this role or state.</p> : null}
      <dl className="fields">
        <div>
          <dt>State</dt>
          <dd>{tasker.state}</dd>
        </div>
        <div>
          <dt>Suspense</dt>
          <dd>{tasker.externalSuspense}</dd>
        </div>
        <div>
          <dt>Action officer</dt>
          <dd>{detail.aoName ?? "—"}</dd>
        </div>
        <div>
          <dt>Originator</dt>
          <dd>{detail.originatorName ?? "—"}</dd>
        </div>
        <div>
          <dt>Category</dt>
          <dd>{tasker.category}</dd>
        </div>
        <div>
          <dt>Mission function</dt>
          <dd>{tasker.missionFunction}</dd>
        </div>
        <div>
          <dt>Portfolio</dt>
          <dd>{tasker.portfolio ?? "—"}</dd>
        </div>
        <div>
          <dt>Priority</dt>
          <dd>{tasker.priority}</dd>
        </div>
        <div>
          <dt>Transmit to higher HQ</dt>
          <dd>{tasker.transmitToHigherHq == null ? "—" : tasker.transmitToHigherHq ? "yes" : "no"}</dd>
        </div>
        <div>
          <dt>Rework</dt>
          <dd>{tasker.reworkCount}</dd>
        </div>
        {tasker.closedDispositionType ? (
          <div>
            <dt>Closed by</dt>
            <dd>{tasker.closedDispositionType}</dd>
          </div>
        ) : null}
      </dl>
      <h2>Requirement</h2>
      {tasker.contentRedacted ? (
        <p className="card">The requirement is withheld for {roleLabel(app.session.actingRole)}.</p>
      ) : (
        <p>{tasker.requirement}</p>
      )}
      {detail.mayAccept ? (
        <form action={acceptTaskerAction} className="stack">
          <input type="hidden" name="taskerId" value={tasker.id} />
          <button type="submit">Accept as action officer</button>
        </form>
      ) : null}
      <h2>Gates</h2>
      {detail.gates.length === 0 ? (
        <p className="meta">No gates.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Office</th>
              <th>Kind</th>
              <th>Status</th>
              <th>Round</th>
              <th>Due</th>
              <th>Justification</th>
            </tr>
          </thead>
          <tbody>
            {detail.gates.map((item) => (
              <tr key={item.id}>
                <td>{item.officeLabel}</td>
                <td>{item.kind}</td>
                <td>{item.status}</td>
                <td>{item.round}</td>
                <td>{item.dueDate}</td>
                <td>{item.justification}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <h2>Dispositions</h2>
      {detail.dispositions.length === 0 ? (
        <p className="meta">No dispositions yet.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Type</th>
              <th>From</th>
              <th>To</th>
              <th>Role</th>
              <th>Rationale</th>
            </tr>
          </thead>
          <tbody>
            {detail.dispositions.map((item) => (
              <tr key={item.id}>
                <td>{item.type}</td>
                <td>{item.fromState}</td>
                <td>{item.toState}</td>
                <td>{roleLabel(item.actingRole)}</td>
                <td>{item.rationale ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <h2>Suspense plan</h2>
      {detail.plan ? (
        <dl className="fields">
          <div>
            <dt>Version</dt>
            <dd>{detail.plan.version}</dd>
          </div>
          <div>
            <dt>External suspense</dt>
            <dd>{detail.plan.externalSuspense}</dd>
          </div>
          <div>
            <dt>Latest AO date</dt>
            <dd>{detail.plan.latestAoAssignmentDate}</dd>
          </div>
          <div>
            <dt>AO window</dt>
            <dd>{detail.plan.aoWindowPct}</dd>
          </div>
          <div>
            <dt>Buffer days</dt>
            <dd>{detail.plan.contingencyBufferDays}</dd>
          </div>
          <div>
            <dt>Conflict</dt>
            <dd>{detail.plan.conflict ? "yes" : "no"}</dd>
          </div>
        </dl>
      ) : (
        <p className="meta">No suspense plan.</p>
      )}
      <h2>AI draft</h2>
      {detail.drafts.length === 0 ? (
        <p className="meta">No AI draft on this tasker. The commercial path stays off; the template is the only drafter.</p>
      ) : (
        detail.drafts.map((draft) => (
          <article key={draft.id} className="card">
            <p className="meta">
              {draft.kind} · {draft.provider} · {draft.model}
            </p>
            <pre className="draft">{draft.content}</pre>
            {draft.withheld ? <p className="meta">The draft body is withheld. The stamp stays visible.</p> : null}
          </article>
        ))
      )}
      <h2>Audit trail</h2>
      <table>
        <thead>
          <tr>
            <th>Seq</th>
            <th>Event</th>
            <th>Actor</th>
            <th>Role</th>
            <th>When</th>
          </tr>
        </thead>
        <tbody>
          {detail.audit.map((event) => (
            <tr key={event.seq}>
              <td>{event.seq}</td>
              <td>{event.eventType}</td>
              <td>{event.actorType}</td>
              <td>{event.actingRole ? roleLabel(event.actingRole) : "—"}</td>
              <td>{event.occurredAt.toISOString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}

function Missing() {
  return (
    <main>
      <h1>Not available</h1>
      <p className="lede">This tasker is not visible to the acting role.</p>
      <p>
        <Link href="/work">Back to the list</Link>
      </p>
    </main>
  );
}
