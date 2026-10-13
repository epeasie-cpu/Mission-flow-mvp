import Link from "next/link";
import { actorFromSession, listRoutingBatch, listStoredDocuments, NotFound, runtimeDb } from "@/core";
import { loadWorkTasker } from "@/lanes/work";
import { roleLabel } from "../../../../landing";
import { requireAppSession } from "../../../../session";
import { DemoUploadWarning, Panel, StateBadge, SuspenseReadout } from "../../../../ui";
import { acceptTaskerAction, uploadTaskerFileAction } from "../../actions";

export const dynamic = "force-dynamic";

export default async function TaskerPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ notice?: string; count?: string }>;
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
  const conflict = tasker.state === "SUSPENSE_CONFLICT" || Boolean(detail.plan?.conflict);
  const actor = actorFromSession(app.session);
  const [files, batch] = await Promise.all([
    listStoredDocuments(runtimeDb(), actor, tasker.id),
    listRoutingBatch(runtimeDb(), tasker.id),
  ]);
  return (
    <main>
      <p className="crumb">
        <Link href="/work">All taskers</Link>
      </p>
      <div className="tasker-top">
      <Panel hud>
        <div className="title-row">
          <p className="ref">{tasker.ref}</p>
          <StateBadge state={tasker.state} />
          <SuspenseReadout iso={tasker.externalSuspense} conflict={conflict} />
        </div>
        <h1>{tasker.title}</h1>
        {query.notice === "accepted" ? <p className="notice">Accepted. The audit log records tasker.accepted.</p> : null}
        {query.notice === "accept-failed" ? <p className="notice">Accept was not applied for this role or state.</p> : null}
        {query.notice === "routed" ? (
          <p className="notice">
            Routed to {query.count ?? "the matched"} action officers. Chain notices are in the notification center, and simulated email is in the outbox.
          </p>
        ) : null}
        {query.notice === "uploaded" ? <p className="notice">Document stored. The audit log records stored_document.uploaded.</p> : null}
        {query.notice === "upload-failed" ? <p className="notice">That file was not stored. Use an allowed type under 10 MB.</p> : null}
        {detail.mayAccept ? (
          <form action={acceptTaskerAction} className="accept">
            <input type="hidden" name="taskerId" value={tasker.id} />
            <button className="primary" type="submit">
              Accept as action officer
            </button>
          </form>
        ) : null}
        <dl className="fields">
          <div>
            <dt>State</dt>
            <dd>
              <StateBadge state={tasker.state} />
            </dd>
          </div>
          <div>
            <dt>Suspense</dt>
            <dd>
              <SuspenseReadout iso={tasker.externalSuspense} conflict={conflict} />
            </dd>
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
      </Panel>
      <section>
      <h2>Documents</h2>
      <DemoUploadWarning />
      {files.length === 0 ? <p className="meta">No files on this tasker yet.</p> : null}
      <ul className="file-list">
        {files.map((file) => (
          <li key={file.id} className="file-card">
            <p>
              <a href={`/files/${file.id}?download=1`}>{file.fileName}</a>
              <span className="meta">
                {" "}
                · {file.mime} · {file.byteSize.toLocaleString()} bytes · {file.sha256.slice(0, 12)}
              </span>
            </p>
            {file.mime.startsWith("image/") ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={`/files/${file.id}`} alt={file.fileName} />
            ) : null}
            {file.mime === "application/pdf" ? (
              <iframe className="preview-frame" title={file.fileName} src={`/files/${file.id}`} />
            ) : null}
          </li>
        ))}
      </ul>
      <form action={uploadTaskerFileAction} className="stack">
        <input type="hidden" name="taskerId" value={tasker.id} />
        <label>
          <span>Add a file</span>
          <input name="file" type="file" required accept=".pdf,.docx,.xlsx,.pptx,.png,.jpg,.jpeg,.gif,.webp,.txt,application/pdf,text/plain,image/*" />
        </label>
        <button type="submit">Upload</button>
      </form>
      </section>
      </div>
      {batch.length > 1 ? (
        <>
          <h2>Also tasked</h2>
          <ul className="match-list">
            {batch.map((mate) => (
              <li key={mate.id}>
                <Link href={`/work/taskers/${mate.id}`}>{mate.ref}</Link>
                <span className="meta"> · {mate.aoName ?? "Unassigned"}</span>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      <h2>Requirement</h2>
      {tasker.contentRedacted ? (
        <p className="panel">The requirement is withheld for {roleLabel(app.session.actingRole)}.</p>
      ) : (
        <Panel>
          <p className="prose">{tasker.requirement}</p>
        </Panel>
      )}
      <h2>Gates</h2>
      {detail.gates.length === 0 ? (
        <p className="meta">No gates.</p>
      ) : (
        <div className="table-wrap">
          <table className="grid">
            <thead>
              <tr>
                <th scope="col">Office</th>
                <th scope="col">Kind</th>
                <th scope="col">Status</th>
                <th scope="col">Round</th>
                <th scope="col">Due</th>
                <th scope="col">Justification</th>
              </tr>
            </thead>
            <tbody>
              {detail.gates.map((item) => (
                <tr key={item.id}>
                  <td>{item.officeLabel}</td>
                  <td>{item.kind}</td>
                  <td>{item.status}</td>
                  <td className="mono">{item.round}</td>
                  <td className="mono">{item.dueDate}</td>
                  <td>{item.justification}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <h2>Dispositions</h2>
      {detail.dispositions.length === 0 ? (
        <p className="meta">No dispositions yet.</p>
      ) : (
        <div className="table-wrap">
          <table className="grid">
            <thead>
              <tr>
                <th scope="col">Type</th>
                <th scope="col">From</th>
                <th scope="col">To</th>
                <th scope="col">Role</th>
                <th scope="col">Rationale</th>
              </tr>
            </thead>
            <tbody>
              {detail.dispositions.map((item) => (
                <tr key={item.id}>
                  <td>{item.type}</td>
                  <td>
                    <StateBadge state={item.fromState} />
                  </td>
                  <td>
                    <StateBadge state={item.toState} />
                  </td>
                  <td>{roleLabel(item.actingRole)}</td>
                  <td>{item.rationale ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <h2>Suspense plan</h2>
      {detail.plan ? (
        <Panel>
          <dl className="fields">
            <div>
              <dt>Version</dt>
              <dd>{detail.plan.version}</dd>
            </div>
            <div>
              <dt>External suspense</dt>
              <dd>
                <SuspenseReadout iso={detail.plan.externalSuspense} conflict={detail.plan.conflict} />
              </dd>
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
              <dd className={detail.plan.conflict ? "hot" : undefined}>{detail.plan.conflict ? "yes" : "no"}</dd>
            </div>
          </dl>
        </Panel>
      ) : (
        <p className="meta">No suspense plan.</p>
      )}
      <h2>AI draft</h2>
      {detail.drafts.length === 0 ? (
        <div className="ai-box">
          <p className="meta">No AI draft on this tasker. The commercial path stays off; the template is the only drafter.</p>
        </div>
      ) : (
        detail.drafts.map((draft) => (
          <article key={draft.id} className="ai-box">
            <p className="meta">
              {draft.kind} · {draft.provider} · {draft.model}
            </p>
            <pre className="draft">{draft.content}</pre>
            {draft.withheld ? <p className="meta">The draft body is withheld. The stamp stays visible.</p> : null}
          </article>
        ))
      )}
      <h2>Audit trail</h2>
      <div className="table-wrap">
        <table className="grid">
          <thead>
            <tr>
              <th scope="col">Seq</th>
              <th scope="col">Event</th>
              <th scope="col">Actor</th>
              <th scope="col">Role</th>
              <th scope="col">When</th>
            </tr>
          </thead>
          <tbody>
            {detail.audit.map((event) => (
              <tr key={event.seq}>
                <td className="mono">{event.seq}</td>
                <td>{event.eventType}</td>
                <td>{event.actorType}</td>
                <td>{event.actingRole ? roleLabel(event.actingRole) : "—"}</td>
                <td className="mono">{event.occurredAt.toISOString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </main>
  );
}

function Missing() {
  return (
    <main>
      <h1>Not available</h1>
      <p className="lede">This tasker is not visible to the acting role.</p>
      <p className="crumb">
        <Link href="/work">Back to the list</Link>
      </p>
    </main>
  );
}
