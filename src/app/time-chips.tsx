"use client";

import { useEffect, useState } from "react";

function formatZulu(now: Date): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "UTC",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).format(now);
  return `${parts}Z`;
}

function formatLocal(now: Date): string {
  return new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
    timeZoneName: "short",
  }).format(now);
}

export function TimeChips() {
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    const tick = () => setNow(new Date());
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, []);
  const stamp = now?.toISOString();
  return (
    <div className="chips" role="group" aria-label="Time">
      <span className="chip">
        <span>Zulu</span>
        <time dateTime={stamp}>{now ? formatZulu(now) : "--:--:--Z"}</time>
      </span>
      <span className="chip">
        <span>Local</span>
        <time dateTime={stamp}>{now ? formatLocal(now) : "--:--:--"}</time>
      </span>
    </div>
  );
}
