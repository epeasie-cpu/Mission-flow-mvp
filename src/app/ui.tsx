import type { ReactNode } from "react";
import { formatCountdown } from "./format";
import { presentState, type StateTone } from "./states";

export function StateBadge({ state }: { state: string }) {
  const { label, tone } = presentState(state);
  return (
    <span className={`badge tone-${tone}`}>
      <span className="pip" aria-hidden="true" />
      {label}
    </span>
  );
}

export function SuspenseReadout({ iso, conflict = false }: { iso: string; conflict?: boolean }) {
  const mark = formatCountdown(iso, new Date());
  const hot = conflict || mark.overdue;
  const flag = mark.overdue ? "Overdue" : conflict ? "Conflict" : null;
  return (
    <span className={hot ? "countdown is-hot" : "countdown"}>
      <span className="countdown-mark">{mark.text}</span>
      {flag ? <span className="countdown-flag">{flag}</span> : null}
      <span className="countdown-date">{iso}</span>
    </span>
  );
}

export function Panel({ children, hud = false, className = "" }: { children: ReactNode; hud?: boolean; className?: string }) {
  const names = ["panel", hud ? "hud" : "", className].filter(Boolean).join(" ");
  return (
    <section className={names}>
      {hud ? (
        <>
          <span className="bracket tl" aria-hidden="true" />
          <span className="bracket tr" aria-hidden="true" />
          <span className="bracket bl" aria-hidden="true" />
          <span className="bracket br" aria-hidden="true" />
        </>
      ) : null}
      {children}
    </section>
  );
}

export function StatTile({ value, label, tone }: { value: number; label: string; tone: StateTone }) {
  return (
    <p className={`stat tone-${tone}`}>
      <strong>{value}</strong>
      <span className="stat-label">
        <span className="pip" aria-hidden="true" />
        {label}
      </span>
    </p>
  );
}
