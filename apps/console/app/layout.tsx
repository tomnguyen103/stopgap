import type { Metadata } from "next";
import type { ReactNode } from "react";
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
        </header>
        <main className="wrap">{children}</main>
      </body>
    </html>
  );
}
