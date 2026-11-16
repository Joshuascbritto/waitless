import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "Waitless",
  description: "Virtual queue for small businesses.",
  icons: { icon: "/icon-192.png", apple: "/apple-touch-icon.png" },
  // Lets iPhone users add it to the home screen as an app (required for Web Push on iOS).
  appleWebApp: { capable: true, title: "Waitless", statusBarStyle: "default" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#171717",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-dvh bg-white text-neutral-900 antialiased">{children}</body>
    </html>
  );
}
