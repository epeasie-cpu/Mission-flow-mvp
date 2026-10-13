import { listOutboundMail, runtimeDb } from "@/core";
import { requireAppSession } from "../session";
import { Panel } from "../ui";

export const dynamic = "force-dynamic";

export default async function OutboxPage() {
  await requireAppSession();
  const rows = await listOutboundMail(runtimeDb());
  return (
    <main>
      <Panel hud>
        <p className="kicker">Demo mail</p>
        <h1>Outbox</h1>
        <p className="lede">
          Each notification writes one simulated email. Nothing leaves this demo. Addresses stay on @example.test.
        </p>
      </Panel>
      {rows.length === 0 ? (
        <p className="panel">The outbox is empty.</p>
      ) : (
        <div className="table-wrap">
          <table className="grid">
            <thead>
              <tr>
                <th scope="col">When</th>
                <th scope="col">To</th>
                <th scope="col">Subject</th>
                <th scope="col">Body</th>
                <th scope="col">Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td className="mono">{row.createdAt.toISOString()}</td>
                  <td>
                    {row.recipientName ?? "—"}
                    <span className="meta">
                      <br />
                      {row.toEmail}
                    </span>
                  </td>
                  <td>{row.subject}</td>
                  <td>{row.body}</td>
                  <td>Simulated — not sent</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
