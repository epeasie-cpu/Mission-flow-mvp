import type { ReactNode } from "react";
import { syntheticBanner } from "@/core";
import "./globals.css";

export const metadata = {
  title: "MissionFlow",
  description: "Synthetic demo of an AI-enabled tasking tool.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="banner" role="status">
          {syntheticBanner}
        </div>
        {children}
      </body>
    </html>
  );
}
