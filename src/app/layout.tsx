import type { ReactNode } from "react";
import { Chakra_Petch, IBM_Plex_Sans, JetBrains_Mono } from "next/font/google";
import { runtimeDb, unreadNotificationCount } from "@/core";
import { DISCLAIMER_FOOTER, HAZARD_BANNER } from "./copy";
import "./globals.css";
import { readAppSession } from "./session";
import { SessionBar } from "./session-bar";

const display = Chakra_Petch({
  subsets: ["latin"],
  weight: ["600", "700"],
  variable: "--font-display",
  display: "swap",
});

const sans = IBM_Plex_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-sans",
  display: "swap",
});

const mono = JetBrains_Mono({
  subsets: ["latin"],
  weight: ["400", "600"],
  variable: "--font-mono",
  display: "swap",
});

export const metadata = {
  title: "MissionFlow",
  description: "Synthetic demo of an AI-enabled tasking tool.",
};

export const dynamic = "force-dynamic";

export default async function RootLayout({ children }: { children: ReactNode }) {
  const session = await readAppSession();
  let unread = 0;
  if (session) {
    try {
      unread = await unreadNotificationCount(runtimeDb(), session.session.userId);
    } catch {
      unread = 0;
    }
  }
  return (
    <html lang="en" className={`${display.variable} ${sans.variable} ${mono.variable}`}>
      <body>
        <div className="banner" role="status">
          <p>{HAZARD_BANNER}</p>
        </div>
        <SessionBar session={session} unread={unread} />
        {children}
        <footer className="site-footer">{DISCLAIMER_FOOTER}</footer>
      </body>
    </html>
  );
}
