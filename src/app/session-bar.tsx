import Link from "next/link";
import { roleLabel } from "./landing";
import type { AppSession } from "./session";
import { signOutAction, switchRoleAction } from "./(auth)/sign-in/actions";

export function SessionBar({ session }: { session: AppSession | null }) {
  if (!session) {
    return (
      <header className="sessionbar">
        <Link href="/">MissionFlow</Link>
        <Link href="/sign-in">Sign in</Link>
      </header>
    );
  }
  return (
    <header className="sessionbar">
      <Link href="/">MissionFlow</Link>
      <span>
        <strong>{session.session.displayName}</strong>
        <span className="meta"> · {roleLabel(session.session.actingRole)}</span>
      </span>
      <form action={switchRoleAction} className="inline">
        <label>
          Acting role
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
      <nav className="nav">
        <Link href="/work">Work</Link>
        <Link href="/oversight">Oversight</Link>
      </nav>
      <form action={signOutAction}>
        <button type="submit">Sign out</button>
      </form>
    </header>
  );
}
