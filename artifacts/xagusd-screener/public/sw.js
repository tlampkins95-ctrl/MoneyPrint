// MONEY.PRINT service worker — handles Web Push delivery and notification
// click-through. Kept tiny on purpose: no offline caching, no background
// sync, just push. The screener is online-only by design (live prices), so
// stale cached HTML would be misleading.

self.addEventListener("install", (event) => {
  // Activate immediately on first install so push works without a manual reload.
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  // Take control of any already-open tabs so they can post subscriptions
  // through this SW without needing a refresh.
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  // Server payload contract — kept stable so the API can evolve without
  // breaking older clients. Missing fields fall back to safe defaults.
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: "MONEY.PRINT", body: event.data ? event.data.text() : "" };
  }

  const title = data.title || "MONEY.PRINT";
  const options = {
    body: data.body || "",
    icon: data.icon || "logo.png",
    badge: data.badge || "logo.png",
    tag: data.tag, // collapses repeat notifications for the same symbol/tf
    renotify: Boolean(data.tag), // re-alert even when tag matches a prior
    data: { url: data.url || "/" },
    requireInteraction: data.requireInteraction === true,
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || "/";

  event.waitUntil(
    (async () => {
      // Re-use an existing tab/window if one is already open, otherwise spawn one.
      const all = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      const absoluteTarget = new URL(target, self.registration.scope).href;
      for (const client of all) {
        if ("focus" in client) {
          await client.navigate(absoluteTarget).catch(() => undefined);
          return client.focus();
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow(absoluteTarget);
      }
      return undefined;
    })(),
  );
});
