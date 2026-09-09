import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "MOS — Manufacturing Order System",
  description: "Manufacturing order system with two-way Onshape sync",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
