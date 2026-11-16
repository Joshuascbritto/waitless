import type { MetadataRoute } from "next";

/**
 * Minimal PWA manifest. Needed on iPhone: Web Push only works there after the
 * site is added to the home screen (iOS 16.4+), which requires a manifest.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Waitless",
    short_name: "Waitless",
    description: "Join the line from your phone and get notified when it's your turn.",
    start_url: "/",
    display: "standalone",
    background_color: "#ffffff",
    theme_color: "#171717",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
