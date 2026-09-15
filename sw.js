// RanniStats service worker
// Purpose: (1) make the site installable as a home-screen app, and
// (2) let the app shell open even with no signal, showing whatever data
// was cached at the last successful load. Never caches ESPN API calls --
// those should always hit the network so scores/rosters/news stay live.

// Bumped when the shell changes shape enough that an installed copy should not
// keep serving the old one: v2 inlines the 32 team crests into index.html.
const CACHE_NAME = "rannistats-shell-v2";
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
        names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n))
      )
    )
  );
  self.clients.claim();
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

  // Cache-first for static shell assets (icons, manifest).
  event.respondWith(
    caches.match(req).then((cached) => cached || fetch(req))
  );
});
