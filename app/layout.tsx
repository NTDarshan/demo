import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Kosha",
  description: "Fee collection and reconciliation",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en-IN">
      <body>{children}</body>
    </html>
  );
}
