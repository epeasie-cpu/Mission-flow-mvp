import type { ReactNode } from "react";
import { syntheticBanner } from "@/core";
import "./globals.css";
import { readAppSession } from "./session";
import { SessionBar } from "./session-bar";

export const metadata = {
  title: "MissionFlow",
  description: "Synthetic demo of an AI-enabled tasking tool.",
};

export const dynamic = "force-dynamic";

export default async function RootLayout({ children }: { children: ReactNode }) {
  const session = await readAppSession();
  return (
    <html lang="en">
      <body>
        <div className="banner" role="status">
          {syntheticBanner}
        </div>
        <SessionBar session={session} />
        {children}
      </body>
    </html>
  );
}
