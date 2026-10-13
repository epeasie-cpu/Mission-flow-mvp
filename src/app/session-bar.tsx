import Link from "next/link";
import { signOutAction, switchRoleAction } from "./(auth)/sign-in/actions";
import { Wordmark } from "./brand";
import { roleLabel } from "./landing";
import { SectionNav } from "./section-nav";
import type { AppSession } from "./session";
import { TimeChips } from "./time-chips";

export function SessionBar({ session }: { session: AppSession | null }) {
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
        <form action={signOutAction}>
          <button type="submit">Sign out</button>
        </form>
      </div>
    </header>
  );
}
