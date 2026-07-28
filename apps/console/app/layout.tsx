import Link from "next/link";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import { ActiveOrgBadge } from "./active-org-badge";
import { DemoBanner } from "./demo-banner";
import "./globals.css";

export const metadata: Metadata = {
  title: "Stopgap Console",
  description: "Hospital drug-shortage response — durable case console",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="topbar">
          <span className="brand">◐ Stopgap</span>
          <span className="tag">drug-shortage response console</span>
          <nav className="nav">
            <Link href="/">Cases</Link>
            <Link href="/protocols">Protocols</Link>
            <Link href="/brief">Brief</Link>
            <Link href="/shadow">Shadow</Link>
            <Link href="/metrics">KPIs</Link>
            <Link href="/audit">Audit</Link>
            <Link href="/admin/users">Admin</Link>
            <Link href="/admin/api-keys">API keys</Link>
            {/*
              The admin active-org switch (PHASE6 §6.5). Linked unconditionally, like the other
              admin links above: the page itself refuses a non-admin, and `setActiveOrgAction`
              refuses one again server-side, so a link is not a grant. Rendering the nav
              conditionally would also make this layout a dynamic (per-session) component for
              every route in the app.
            */}
            <Link href="/admin/organizations">Organizations</Link>
          </nav>
          {/*
            Rendered LAST in the header so it sits at the end of the bar, and rendered at all only
            when an admin is acting inside a tenant that is not their own (PHASE6 §6.5). See
            `active-org-badge.tsx`: the switch is otherwise completely invisible, and an admin who
            forgot they made it approves clinical protocols into the wrong hospital.
          */}
          <ActiveOrgBadge />
        </header>
        <DemoBanner />
        <main className="wrap">{children}</main>
      </body>
    </html>
  );
}
