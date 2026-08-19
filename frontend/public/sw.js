// Phase 16 — PWA service worker.
// Strategy:
//   - App shell + built assets: cache-first (hashed filenames are immutable).
//   - /api GET requests: network-first, falling back to the cached copy when
//     offline so already-loaded data stays readable.
//   - Navigations: network-first, falling back to the cached index.html so the
//     SPA boots with zero connectivity.
// Mutations (POST/PATCH/DELETE) are never handled here — the Field screen
// queues them in IndexedDB and replays through /sync/ops.

const VERSION = "facilix-v3";
const SHELL_CACHE = `${VERSION}-shell`;
const API_CACHE = `${VERSION}-api`;

const SHELL_URLS = ["/", "/index.html", "/manifest.webmanifest", "/icon.svg", "/icon-512.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then(async (cache) => {
        // Cache each URL individually so one missing file (e.g. icon-512.png
        // on an older deployment) doesn't block the entire precache.
        for (const url of SHELL_URLS) {
          try { await cache.add(url); } catch { /* skip missing */ }
        }
        // The initial page load fetches the hashed JS/CSS before this SW takes
        // control, so pull their URLs out of the built index.html and precache
        // them now — otherwise a hard-offline reload serves HTML but no app.
        const index = await cache.match("/index.html");
        const html = index ? await index.text() : await (await fetch("/index.html")).text();
        const assets = [...html.matchAll(/assets\/[^"']+\.(js|css)/g)].map((m) => "/" + m[0]);
        await Promise.all(
          [...new Set(assets)].map((url) => cache.add(url).catch(() => {}))
        );
      })
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Same-origin API reads only — let mutations through to the network.
  if (url.pathname.startsWith("/api/") && request.method === "GET") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(API_CACHE).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() =>
          caches.match(request, { ignoreVary: true }).then(
            (cached) =>
              cached ??
              new Response(JSON.stringify({ error: "Offline — no cached copy" }), {
                status: 503,
                headers: { "Content-Type": "application/json" },
              })
          )
        )
    );
    return;
  }

  // App shell / static assets.
  if (request.mode === "navigate" || url.pathname === "/" || SHELL_URLS.includes(url.pathname) || /\.(js|css|svg|png|ico|woff2?)$/.test(url.pathname)) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(SHELL_CACHE).then((cache) => cache.put(request, copy));
          return response;
        })
        .catch(async () => {
          // ignoreVary: the built assets come back with Vary: Origin, but the
          // precache was made without an Origin header — matching must not
          // depend on it or crossorigin module fetches miss offline.
          const cached = await caches.match(request, { ignoreVary: true });
          if (cached) return cached;
          const shell = await caches.match("/index.html", { ignoreVary: true });
          if (shell) return shell;
          return new Response("Offline", { status: 503 });
        })
    );
    return;
  }
});

// Background sync (Item 3). The Field screen registers "flush-queue" whenever
// offline ops are queued; the browser fires this event once connectivity
// returns. The SW can't read localStorage for the session token or touch the
// IndexedDB queue by itself, so it wakes any open client and lets the page run
// the same flushQueue path as the online flow. No client open → the sync is
// reported as failed and the browser retries with backoff.
self.addEventListener("sync", (event) => {
  if (event.tag !== "flush-queue") return;
  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((clients) => {
        if (!clients.length) return false;
        clients.forEach((client) => client.postMessage({ type: "flush-queue" }));
        return true;
      })
  );
});

// Phase 16 — skip-waiting: when the "Update" button in UpdatePrompt.tsx posts
// this message, the waiting SW activates immediately and the page reloads.
self.addEventListener("message", (event) => {
  if (event.data?.type === "skip-waiting") {
    self.skipWaiting();
  }
});
