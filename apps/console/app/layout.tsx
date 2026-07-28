import type { Metadata } from "next";
import type { ReactNode } from "react";
import { DemoBanner } from "./demo-banner";
import "./globals.css";

export const metadata: Metadata = {
  title: "Stopgap Console",
  description: "Hospital drug-shortage response — durable case console",
};

/**
 * The root layout reads NO SESSION STATE (ticket 03).
 *
 * Precisely that, and not "is static": `DemoBanner` awaits the deployment-wide spend cap, so this
 * layout is still dynamic. What it no longer does is depend on WHO is asking. The header, the
 * navigation and the active-org badge moved into the four group layouts, one level down, because
 * anything here that touched the session would make every route in the application vary per
 * caller — and a cache keyed on the session is a cache that never hits.
 */
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <DemoBanner />
        {children}
      </body>
    </html>
  );
}
