import Link from "next/link";

/** Single-stroke angular M waveform. The stroke ends on a gold baseline and terminal dot. */
export function Mark() {
  return (
    <svg className="mark" viewBox="0 0 40 16" aria-hidden="true" focusable="false">
      <path
        d="M1 13.5 L8 2.5 L15 13.5 L22 2.5 L29 13.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="miter"
        strokeLinecap="square"
      />
      <path d="M29 13.5 H36.2" fill="none" stroke="var(--gold)" strokeWidth="1.6" strokeLinecap="square" />
      <circle cx="37.6" cy="13.5" r="1.35" fill="var(--gold)" />
    </svg>
  );
}

export function Wordmark() {
  return (
    <Link href="/" className="wordmark">
      <Mark />
      <span className="wordmark-text">
        MISSION<span className="flow">FLOW</span>
      </span>
    </Link>
  );
}
