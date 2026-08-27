"use strict";

// The build id provides a clean release boundary. Runtime requests also use a
// network-first strategy, so a forgotten bump cannot strand online clients on
// an old shell; the cached release remains the complete offline fallback.
const BUILD_ID = "2026-08-28.63";
const CACHE_PREFIX = "reentry-deck-shell-";
const CACHE_NAME = `${CACHE_PREFIX}${BUILD_ID}`;
const NETWORK_TIMEOUT_MS = 4_000;

const SHELL_PATHS = Object.freeze([
  "./",
  "./index.html",
  "./app.webmanifest",
  "./assets/icon.svg",
  "./src/styles.css",
  "./src/main.js",
  "./src/ui/app.js",
  "./src/core/capture.js",
  "./src/core/backup-file.js",
  "./src/core/download.js",
  "./src/core/model.js",
  "./src/core/import-preview.js",
  "./src/core/insights.js",
  "./src/core/store.js",
  "./src/core/reentry.js",
  "./src/core/search.js",
  "./src/core/share.js",
  "./src/core/session.js",
  "./src/core/timeline.js",
  "./src/core/time.js"
]);

const scopeURL = new URL(self.registration.scope);
const documentURL = new URL("index.html", scopeURL).href;
const shellURLs = new Set(
  SHELL_PATHS.map((path) => new URL(path, scopeURL).href)
);

function cleanURL(value) {
  const url = new URL(value);
  url.hash = "";
  url.search = "";
  return url.href;
}

function isUsableResponse(response) {
  return response.status === 200 && response.type !== "error";
}

async function fetchWithTimeout(request) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), NETWORK_TIMEOUT_MS);
  try {
    return await fetch(request, { signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

async function precacheShell() {
  const requests = [...shellURLs].map(
    (url) =>
      new Request(url, {
        cache: "reload",
        credentials: "same-origin"
      })
  );

  // Cache.addAll performs the request batch atomically: an incomplete
  // deployment or a failed cache write cannot leave a half-built shell.
  const cache = await caches.open(CACHE_NAME);
  await cache.addAll(requests);
}

self.addEventListener("install", (event) => {
  event.waitUntil(precacheShell());
  // Deliberately do not call skipWaiting(): open tabs keep using their complete
  // current release until the normal service-worker lifecycle can switch safely.
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const cacheNames = await caches.keys();
      await Promise.all(
        cacheNames
          .filter(
            (cacheName) =>
              cacheName.startsWith(CACHE_PREFIX) && cacheName !== CACHE_NAME
          )
          .map((cacheName) => caches.delete(cacheName))
      );

      await self.clients.claim();
    })()
  );
});

async function serveNavigation(request) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const response = await fetchWithTimeout(request);
    if (isUsableResponse(response)) {
      try {
        await cache.put(documentURL, response.clone());
      } catch {
        // A successful network response must not fail because an optional
        // runtime cache refresh exceeded storage capacity.
      }
    } else {
      const cachedDocument = await cache.match(documentURL);
      if (cachedDocument) return cachedDocument;
    }
    return response;
  } catch {
    const cachedDocument = await cache.match(documentURL);
    if (cachedDocument) return cachedDocument;
    return new Response("离线状态下无法载入复航台，请联网后重试。", {
      status: 503,
      statusText: "Service Unavailable",
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-store"
      }
    });
  }
}

async function serveShellAsset(request, canonicalURL) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const response = await fetchWithTimeout(request);
    if (isUsableResponse(response)) {
      try {
        await cache.put(canonicalURL, response.clone());
      } catch {
        // Keep serving the network response when cache refresh is unavailable.
      }
    } else {
      const cachedResponse = await cache.match(canonicalURL);
      if (cachedResponse) return cachedResponse;
    }
    return response;
  } catch {
    const cachedResponse = await cache.match(canonicalURL);
    if (cachedResponse) return cachedResponse;
    return new Response("Offline asset unavailable", {
      status: 503,
      headers: { "Content-Type": "text/plain; charset=utf-8" }
    });
  }
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") {
    return;
  }

  const requestURL = new URL(request.url);
  if (requestURL.origin !== scopeURL.origin) {
    return;
  }

  if (request.mode === "navigate") {
    event.respondWith(serveNavigation(request));
    return;
  }

  const canonicalURL = cleanURL(requestURL);
  const scopePath = scopeURL.pathname.endsWith("/") ? scopeURL.pathname : `${scopeURL.pathname}/`;
  const isRuntimeAsset = requestURL.pathname.startsWith(`${scopePath}src/`)
    || requestURL.pathname.startsWith(`${scopePath}assets/`)
    || requestURL.pathname === `${scopePath}app.webmanifest`;
  if (shellURLs.has(canonicalURL) || isRuntimeAsset) {
    event.respondWith(serveShellAsset(request, canonicalURL));
  }
});
