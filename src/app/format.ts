const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/** Display-only countdown. Due instant is the end of the suspense calendar day, UTC. */
export function formatCountdown(isoDate: string, now: Date): { text: string; overdue: boolean } {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!match) return { text: isoDate, overdue: false };
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const due = Date.UTC(year, month - 1, day, 23, 59, 59);
  const delta = due - now.getTime();
  const overdue = delta < 0;
  const abs = Math.abs(delta);
  const days = Math.floor(abs / DAY);
  const hours = Math.floor((abs % DAY) / HOUR);
  const sign = overdue ? "+" : "−";
  return { text: `T${sign}${days}D ${String(hours).padStart(2, "0")}H`, overdue };
}
