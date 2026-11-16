// Service worker: shows Waitless push notifications and opens the ticket on tap.
// Plain JS on purpose: browsers load it directly from /sw.js, outside the bundler.

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  let message = {};
  try {
    message = event.data ? event.data.json() : {};
  } catch {
    // Not JSON: show a generic notification rather than nothing.
  }
  event.waitUntil(
    self.registration.showNotification(message.title || "Waitless", {
      body: message.body || "",
      // Same tag replaces the previous notification for this ticket instead of stacking.
      tag: message.tag,
      renotify: true,
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      vibrate: [200, 100, 200],
      data: { url: message.url || "/" },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = event.notification.data?.url || "/";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((windows) => {
      for (const client of windows) {
        if (new URL(client.url).pathname === url && "focus" in client) {
          return client.focus();
        }
      }
      return self.clients.openWindow(url);
    }),
  );
});
