// RanniStats service worker
// Purpose: (1) make the site installable as a home-screen app, and
// (2) let the app shell open even with no signal, showing whatever data
// was cached at the last successful load. Never caches ESPN API calls --
// those should always hit the network so scores/rosters/news stay live.

// Bumped when the shell changes shape enough that an installed copy should not
// keep serving the old one: v2 inlined the 32 team crests into index.html,
// v3 added push notification handling.
const CACHE_NAME = "rannistats-shell-v3";
const APP_SHELL = [
  "./",
  "./index.html",
  "./manifest.json",
  "./icon-192.png",
  "./icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(
        names.filter((n) => n !== CACHE_NAME && n !== "rannistats-push-config")
             .map((n) => caches.delete(n))
      )
    )
  );
  self.clients.claim();
});

/* ---- push notifications -------------------------------------------------
 * The Worker (push-worker/ in the repo) sends a JSON payload of
 * {title, body, tag, url}. Everything here has to be defensive: a push can
 * arrive years after this code shipped, from a server that has been changed
 * since, and a service worker that throws inside a push handler shows the
 * browser's own "This site has been updated in the background" notice
 * instead, which looks broken. */
self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    try { data = { title: "RanniStats", body: event.data.text() }; } catch (e2) { data = {}; }
  }
  const title = data.title || "RanniStats";
  const options = {
    body: data.body || "",
    icon: "./icon-192.png",
    badge: "./icon-192.png",
    // Same tag replaces an earlier notification rather than stacking. Scoring
    // plays all share one tag per game on purpose, so a shootout doesn't bury
    // the lock screen.
    tag: data.tag || "rannistats",
    renotify: true,
    data: { url: data.url || "./index.html" },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || "./index.html";
  event.waitUntil((async () => {
    const url = new URL(target, self.location.href).href;
    // Prefer focusing a window that's already open over opening a second copy.
    const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const client of clients) {
      if (client.url.split("#")[0] === url.split("#")[0] && "focus" in client) {
        if ("navigate" in client && client.url !== url) { try { await client.navigate(url); } catch (e) {} }
        return client.focus();
      }
    }
    if (self.clients.openWindow) return self.clients.openWindow(url);
  })());
});

/* A subscription can be rotated by the browser at any time. When that happens
 * the old endpoint stops working, so re-register the new one immediately —
 * otherwise notifications quietly stop and nothing says why. */
self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil((async () => {
    try {
      // Written by the page when it subscribes: the api url plus the
      // current teams and toggles, which a service worker cannot read
      // from localStorage.
      const cached = await caches.open("rannistats-push-config");
      const cfgRes = await cached.match("./push-config.json");
      const cfg = cfgRes ? await cfgRes.json() : null;
      if (!cfg || !cfg.api) return;
      const sub = event.newSubscription || await self.registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: event.oldSubscription && event.oldSubscription.options
          ? event.oldSubscription.options.applicationServerKey : undefined,
      });
      if (event.oldSubscription) {
        await fetch(cfg.api + "/unsubscribe", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ endpoint: event.oldSubscription.endpoint }),
        }).catch(() => {});
      }
      await fetch(cfg.api + "/subscribe", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subscription: sub, teams: cfg.teams || [], triggers: cfg.triggers || {} }),
      });
    } catch (e) {
      // Nothing useful to do here; the app re-syncs on next open.
    }
  })());
});

self.addEventListener("fetch", (event) => {
  const req = event.request;

  // Only handle same-origin GET requests for the app shell. Everything
  // else (ESPN's API, fonts, any cross-origin call) passes straight
  // through untouched -- we never want to serve stale live data.
  if (req.method !== "GET" || new URL(req.url).origin !== self.location.origin) {
    return;
  }

  // Network-first for the page itself, so a redeploy is picked up
  // immediately when online; falls back to the cached shell when offline.
  if (req.mode === "navigate" || req.url.endsWith("index.html") || req.url.endsWith("/")) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
          return res;
        })
        .catch(() => caches.match(req).then((res) => res || caches.match("./index.html")))
    );
    return;
  }

  // push-config.json points at the notification server. It has to be
  // network-first: if the address changes, a cached copy would send every
  // subscription to a server that no longer exists.
  if (req.url.endsWith("push-config.json")) {
    event.respondWith(fetch(req).catch(() => caches.match(req)));
    return;
  }

  // Cache-first for static shell assets (icons, manifest).
  event.respondWith(
    caches.match(req).then((cached) => cached || fetch(req))
  );
});
