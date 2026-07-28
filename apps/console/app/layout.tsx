import type { Metadata } from "next";
import type { ReactNode } from "react";
import { DemoBanner } from "./demo-banner";
import "./globals.css";

export const metadata: Metadata = {
  title: "Stopgap Console",
  description: "Hospital drug-shortage response — durable case console",
};

/**
 * The root layout is STATIC (ticket 03).
 *
 * It holds the document, the stylesheet and the demo banner — nothing that reads a session. The
 * header, the navigation and the active-org badge moved into the four group layouts, one level
 * down, because anything here that touched the session would make EVERY route in the application
 * a per-session render, including the ones that have no business being one.
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
