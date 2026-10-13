import Link from "next/link";
import { listNotifications, runtimeDb } from "@/core";
import { requireAppSession } from "../session";
import { Panel } from "../ui";
import { markAllReadAction, markReadAction } from "./actions";

export const dynamic = "force-dynamic";

export default async function NotificationsPage() {
  const app = await requireAppSession();
  const rows = await listNotifications(runtimeDb(), app.session.userId);
  const unread = rows.filter((row) => !row.readAt).length;
  return (
    <main>
      <Panel hud>
        <p className="kicker">In-app</p>
        <h1>Notifications</h1>
        <p className="lede">
          {unread === 0 ? "Nothing unread." : `${unread} unread.`} Tasking notices stay in this demo database.
        </p>
        {unread > 0 ? (
          <form action={markAllReadAction}>
            <button type="submit">Mark all read</button>
          </form>
        ) : null}
      </Panel>
      {rows.length === 0 ? (
        <p className="panel">No notifications yet.</p>
      ) : (
        <ul className="match-list">
          {rows.map((row) => (
            <li key={row.id} className={row.readAt ? undefined : "note-unread"}>
              <p>{row.body}</p>
              <p className="meta">
                {row.kind === "chain" ? "Chain" : "Assigned"} · {row.createdAt.toISOString()}
                {row.taskerId ? (
                  <>
                    {" "}
                    · <Link href={`/work/taskers/${row.taskerId}`}>Open tasker</Link>
                  </>
                ) : null}
              </p>
              {row.readAt ? null : (
                <form action={markReadAction}>
                  <input type="hidden" name="id" value={row.id} />
                  <button type="submit">Mark read</button>
                </form>
              )}
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
