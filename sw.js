"use strict";

// The build id provides a clean release boundary. Runtime requests also use a
// network-first strategy, so a forgotten bump cannot strand online clients on
// an old shell; the cached release remains the complete offline fallback.
const BUILD_ID = "2026-08-28.166";
const CACHE_PREFIX = "reentry-deck-shell-";
const CACHE_NAME = `${CACHE_PREFIX}${BUILD_ID}`;
const NETWORK_TIMEOUT_MS = 4_000;
const RUNTIME_CACHE_TIMEOUT_MS = 750;

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
  "./src/core/startup.js",
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
  const requestSignal = request.signal;
  const forwardRequestAbort = () => controller.abort(requestSignal.reason);
  if (requestSignal?.aborted) forwardRequestAbort();
  else requestSignal?.addEventListener("abort", forwardRequestAbort, { once: true });
  const timeoutId = setTimeout(() => controller.abort(), NETWORK_TIMEOUT_MS);
  try {
    return await fetch(request, { signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
    requestSignal?.removeEventListener("abort", forwardRequestAbort);
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

async function openRuntimeCache() {
  let timeoutId;
  try {
    return await Promise.race([
      caches.open(CACHE_NAME),
      new Promise((resolve) => {
        timeoutId = setTimeout(() => resolve(null), RUNTIME_CACHE_TIMEOUT_MS);
      })
    ]);
  } catch {
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function matchRuntimeCache(cache, request) {
  if (!cache) return null;
  try {
    return await cache.match(request) ?? null;
  } catch {
    return null;
  }
}

async function refreshRuntimeCache(cachePromise, request, response) {
  const cache = await cachePromise;
  if (!cache) return;
  try {
    await cache.put(request, response);
  } catch {
    // A successful network response must not fail because an optional runtime
    // cache refresh exceeded capacity or lost permission.
  }
}

function deferRuntimeRefresh(defer, cachePromise, request, response) {
  try {
    defer(refreshRuntimeCache(cachePromise, request, response.clone()));
  } catch {
    // Response cloning is part of the optional cache refresh. A valid network
    // response remains usable even if the host refuses to clone its body.
  }
}

self.addEventListener("install", (event) => {
  event.waitUntil(precacheShell());
  // Deliberately do not call skipWaiting(): open tabs keep using their complete
  // current release until the normal service-worker lifecycle can switch safely.
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      try {
        const cacheNames = await caches.keys();
        await Promise.all(
          cacheNames
            .filter(
              (cacheName) =>
                cacheName.startsWith(CACHE_PREFIX) && cacheName !== CACHE_NAME
            )
            .map(async (cacheName) => {
              try {
                await caches.delete(cacheName);
              } catch {
                // Cleanup is optional after the new shell installed atomically.
              }
            })
        );
      } catch {
        // A temporary CacheStorage denial must not prevent the installed worker
        // from activating and serving network responses.
      }

      await self.clients.claim();
    })()
  );
});

async function serveNavigation(request, defer) {
  const cachePromise = openRuntimeCache();
  try {
    const response = await fetchWithTimeout(request);
    if (isUsableResponse(response)) {
      deferRuntimeRefresh(defer, cachePromise, documentURL, response);
    } else {
      const cache = await cachePromise;
      const cachedDocument = await matchRuntimeCache(cache, documentURL);
      if (cachedDocument) return cachedDocument;
    }
    return response;
  } catch (error) {
    if (request.signal?.aborted) throw error;
    const cache = await cachePromise;
    const cachedDocument = await matchRuntimeCache(cache, documentURL);
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

async function serveShellAsset(request, canonicalURL, defer) {
  const cachePromise = openRuntimeCache();
  try {
    const response = await fetchWithTimeout(request);
    if (isUsableResponse(response)) {
      deferRuntimeRefresh(defer, cachePromise, canonicalURL, response);
    } else {
      const cache = await cachePromise;
      const cachedResponse = await matchRuntimeCache(cache, canonicalURL);
      if (cachedResponse) return cachedResponse;
    }
    return response;
  } catch (error) {
    if (request.signal?.aborted) throw error;
    const cache = await cachePromise;
    const cachedResponse = await matchRuntimeCache(cache, canonicalURL);
    if (cachedResponse) return cachedResponse;
    return new Response("Offline asset unavailable", {
      status: 503,
      headers: { "Content-Type": "text/plain; charset=utf-8" }
    });
  }
}

function respondWithLifetime(event, serve) {
  const backgroundTasks = [];
  let finishResponse;
  const responseFinished = new Promise((resolve) => {
    finishResponse = resolve;
  });
  event.waitUntil((async () => {
    await responseFinished;
    await Promise.all(backgroundTasks);
  })());
  const responsePromise = serve((promise) => backgroundTasks.push(promise));
  event.respondWith(responsePromise.finally(finishResponse));
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
    respondWithLifetime(event, (defer) => serveNavigation(request, defer));
    return;
  }

  const canonicalURL = cleanURL(requestURL);
  const scopePath = scopeURL.pathname.endsWith("/") ? scopeURL.pathname : `${scopeURL.pathname}/`;
  const isRuntimeAsset = requestURL.pathname.startsWith(`${scopePath}src/`)
    || requestURL.pathname.startsWith(`${scopePath}assets/`)
    || requestURL.pathname === `${scopePath}app.webmanifest`;
  if (shellURLs.has(canonicalURL) || isRuntimeAsset) {
    respondWithLifetime(event, (defer) => serveShellAsset(request, canonicalURL, defer));
  }
});
