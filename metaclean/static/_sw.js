// UnMeta service worker: keeps a copy of the app in this browser so it opens and works with no connection.
// It caches only UnMeta's own files (the page, its code, styles, fonts and icons). It never sees, stores or
// sends a photo or video: those are read by the page and its worker, and never pass through fetch.
// Template: the server fills in VERSION and ASSETS (see server.py: service_worker).
"use strict";
const VERSION = "__VERSION__";
const ASSETS = __ASSETS__;
const CACHE = `unmeta-${VERSION}`;

self.addEventListener("install", event => {
  event.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", event => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if ((key.startsWith("unmeta-") || key.startsWith("metaclean-")) && key !== CACHE) await caches.delete(key);
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", event => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== "GET") return;
  if (url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;

  // The page: fresh from the network when online (so updates arrive), the saved copy when offline.
  if (req.mode === "navigate") {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(req, { cache: "no-store" });
        // every page visited is saved too, so guides and landing pages open offline as well
        if (fresh.ok) (await caches.open(CACHE)).put(url.pathname, fresh.clone());
        if (!fresh.ok) return (await caches.match(url.pathname)) || (await caches.match("/")) || fresh;  // server trouble
        return fresh;
      } catch {
        return (await caches.match(url.pathname)) || (await caches.match("/")) || Response.error();
      }
    })());
    return;
  }

  // Code, styles, fonts and icons: file names carry a content hash, so the saved copy is always right.
  event.respondWith((async () => (await caches.match(req)) || fetch(req))());
});
