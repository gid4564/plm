import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "PLM — Product Lifecycle Management",
  description: "Demo PLM system: attribute governance, product structure, and release management driven from Onshape",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
