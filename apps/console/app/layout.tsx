import Link from "next/link";
import type { Metadata } from "next";
import type { ReactNode } from "react";
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
            <Link href="/shadow">Shadow</Link>
            <Link href="/metrics">KPIs</Link>
          </nav>
        </header>
        <DemoBanner />
        <main className="wrap">{children}</main>
      </body>
    </html>
  );
}
