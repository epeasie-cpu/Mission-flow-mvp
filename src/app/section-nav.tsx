"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/work", label: "Work" },
  { href: "/oversight", label: "Oversight" },
  { href: "/directory", label: "Directory" },
  { href: "/outbox", label: "Outbox" },
] as const;

export function SectionNav() {
  const path = usePathname();
  return (
    <nav className="nav" aria-label="Sections">
      {LINKS.map((link) => {
        const current = path === link.href || path.startsWith(`${link.href}/`);
        return (
          <Link key={link.href} href={link.href} aria-current={current ? "page" : undefined}>
            {link.label}
          </Link>
        );
      })}
    </nav>
  );
}
