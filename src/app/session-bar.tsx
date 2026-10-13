import Link from "next/link";
import { signOutAction, switchRoleAction } from "./(auth)/sign-in/actions";
import { Wordmark } from "./brand";
import { roleLabel } from "./landing";
import { SectionNav } from "./section-nav";
import type { AppSession } from "./session";
import { TimeChips } from "./time-chips";

function Bell({ unread }: { unread: number }) {
  const label = unread === 1 ? "Notifications, 1 unread" : `Notifications, ${unread} unread`;
  return (
    <Link href="/notifications" className="bell" aria-label={label}>
      <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
        <path
          d="M8 1.2a4.2 4.2 0 0 0-4.2 4.2v2.1L2.4 9.6v1.2h11.2V9.6L12.2 7.5V5.4A4.2 4.2 0 0 0 8 1.2zm0 13a1.7 1.7 0 0 0 1.6-1.1H6.4A1.7 1.7 0 0 0 8 14.2z"
          fill="currentColor"
        />
      </svg>
      {unread > 0 ? <span className="bell-count">{unread > 99 ? "99+" : unread}</span> : null}
    </Link>
  );
}

export function SessionBar({ session, unread = 0 }: { session: AppSession | null; unread?: number }) {
  if (!session) {
    return (
      <header className="sessionbar">
        <Wordmark />
        <TimeChips />
        <div className="session-end">
          <Link href="/sign-in" className="btn primary">
            Sign in
          </Link>
        </div>
      </header>
    );
  }
  return (
    <header className="sessionbar">
      <Wordmark />
      <TimeChips />
      <div className="session-end">
        <span className="who">
          <strong>{session.session.displayName}</strong>
          <span className="role">{roleLabel(session.session.actingRole)}</span>
        </span>
        <form action={switchRoleAction} className="inline">
          <label>
            <span>Acting role</span>
            <select name="role" defaultValue={session.session.actingRole}>
              {session.session.heldRoles.map((role) => (
                <option key={role} value={role}>
                  {roleLabel(role)}
                </option>
              ))}
            </select>
          </label>
          <button type="submit">Switch</button>
        </form>
        <SectionNav />
        <Bell unread={unread} />
        <form action={signOutAction}>
          <button type="submit">Sign out</button>
        </form>
      </div>
    </header>
  );
}
