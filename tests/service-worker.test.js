import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { beforeEach, describe, test } from "node:test";
import vm from "node:vm";

const workerSource = await readFile(resolve(import.meta.dirname, "../sw.js"), "utf8");
const scope = "http://127.0.0.1:4173/";

function cacheKey(value) {
  return typeof value === "string" ? value : value.url;
}

function createHarness() {
  const handlers = new Map();
  const stores = new Map();
  let claimed = false;
  let failRuntimeOpen = false;
  let failRuntimeMatch = false;
  let failRuntimePut = false;
  let stallRuntimeOpen = false;
  let failCacheKeys = false;
  const failedCacheDeletes = new Set();
  const timers = new Map();
  let timerSequence = 0;
  let fetchImplementation = async (request) => new Response(`online:${new URL(request.url).pathname}`, { status: 200 });

  class MockCache {
    entries = new Map();

    async addAll(requests) {
      const staged = await Promise.all(requests.map(async (request) => {
        const response = await fetchImplementation(request);
        if (!response.ok || response.type === "error") throw new Error(`cache batch rejected ${request.url}`);
        return [cacheKey(request), response.clone()];
      }));
      for (const [key, response] of staged) this.entries.set(key, response);
    }

    async put(request, response) {
      if (failRuntimePut) throw new Error("cache quota");
      this.entries.set(cacheKey(request), response.clone());
    }

    async match(request) {
      if (failRuntimeMatch) throw new Error("cache read denied");
      return this.entries.get(cacheKey(request))?.clone();
    }
  }

  const cacheStorage = {
    async open(name) {
      if (stallRuntimeOpen) return new Promise(() => {});
      if (failRuntimeOpen) throw new Error("cache storage denied");
      if (!stores.has(name)) stores.set(name, new MockCache());
      return stores.get(name);
    },
    async keys() {
      if (failCacheKeys) throw new Error("cache listing denied");
      return [...stores.keys()];
    },
    async delete(name) {
      if (failedCacheDeletes.has(name)) throw new Error("cache deletion denied");
      return stores.delete(name);
    }
  };

  const self = {
    registration: { scope },
    clients: { async claim() { claimed = true; } },
    addEventListener(type, handler) {
      handlers.set(type, handler);
    }
  };

  vm.runInNewContext(workerSource, {
    URL,
    Request,
    Response,
    Set,
    Promise,
    AbortController,
    DOMException,
    caches: cacheStorage,
    fetch: (request, options) => fetchImplementation(request, options),
    setTimeout(callback) {
      const id = ++timerSequence;
      timers.set(id, callback);
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    self
  });

  return {
    handlers,
    stores,
    cacheStorage,
    get claimed() { return claimed; },
    setFetch(next) { fetchImplementation = next; },
    setRuntimeOpenFailure(value) { failRuntimeOpen = value; },
    setRuntimeMatchFailure(value) { failRuntimeMatch = value; },
    setRuntimePutFailure(value) { failRuntimePut = value; },
    setRuntimeOpenStall(value) { stallRuntimeOpen = value; },
    setCacheKeysFailure(value) { failCacheKeys = value; },
    setCacheDeleteFailure(name) { failedCacheDeletes.add(name); },
    fireTimers() {
      for (const [id, callback] of [...timers]) {
        timers.delete(id);
        callback();
      }
    },
    get pendingTimers() { return timers.size; }
  };
}

function lifecyclePromise(handler, extra = {}) {
  let pending;
  handler({ ...extra, waitUntil(value) { pending = value; } });
  assert.ok(pending, "lifecycle handler must call waitUntil");
  return pending;
}

async function interceptedResponse(handler, request, lifetimes = []) {
  let pending;
  let dispatching = true;
  handler({
    request,
    respondWith(value) { pending = value; },
    waitUntil(value) {
      assert.equal(dispatching, true, "waitUntil must be registered during event dispatch");
      lifetimes.push(value);
    }
  });
  dispatching = false;
  return pending ? pending : null;
}

describe("service worker lifecycle", () => {
  let harness;

  beforeEach(() => {
    harness = createHarness();
  });

  test("precache commits the complete shell as one batch", async () => {
    await lifecyclePromise(harness.handlers.get("install"));

    assert.equal(harness.stores.size, 1);
    const cache = [...harness.stores.values()][0];
    assert.ok(cache.entries.size > 10);
    assert.ok(cache.entries.has(`${scope}index.html`));
    assert.ok(cache.entries.has(`${scope}src/main.js`));
  });

  test("a failed install leaves no partially cached responses", async () => {
    harness.setFetch(async (request) => {
      if (request.url.endsWith("src/ui/app.js")) return new Response("missing", { status: 404 });
      return new Response("ok", { status: 200 });
    });

    await assert.rejects(lifecyclePromise(harness.handlers.get("install")), /cache batch rejected/);
    const cache = [...harness.stores.values()][0];
    assert.equal(cache.entries.size, 0);
  });

  test("activation deletes only older app shells and claims clients", async () => {
    await lifecyclePromise(harness.handlers.get("install"));
    await harness.cacheStorage.open("reentry-deck-shell-old");
    await harness.cacheStorage.open("unrelated-cache");

    await lifecyclePromise(harness.handlers.get("activate"));

    const names = await harness.cacheStorage.keys();
    assert.equal(names.includes("reentry-deck-shell-old"), false);
    assert.equal(names.includes("unrelated-cache"), true);
    assert.equal(names.filter((name) => name.startsWith("reentry-deck-shell-")).length, 1);
    assert.equal(harness.claimed, true);
  });

  test("activation claims clients even when old-cache listing or deletion fails", async () => {
    await lifecyclePromise(harness.handlers.get("install"));
    await harness.cacheStorage.open("reentry-deck-shell-stuck");
    harness.setCacheDeleteFailure("reentry-deck-shell-stuck");

    await lifecyclePromise(harness.handlers.get("activate"));

    assert.equal(harness.claimed, true);
    assert.equal((await harness.cacheStorage.keys()).includes("reentry-deck-shell-stuck"), true);

    harness = createHarness();
    await lifecyclePromise(harness.handlers.get("install"));
    harness.setCacheKeysFailure(true);
    await lifecyclePromise(harness.handlers.get("activate"));
    assert.equal(harness.claimed, true);
  });

  test("offline navigation and query-bearing shell assets use canonical cached responses", async () => {
    await lifecyclePromise(harness.handlers.get("install"));
    harness.setFetch(async () => { throw new Error("offline"); });
    const fetchHandler = harness.handlers.get("fetch");

    const navigation = await interceptedResponse(fetchHandler, { method: "GET", mode: "navigate", url: scope });
    assert.equal(navigation.status, 200);
    assert.equal(await navigation.text(), "online:/index.html");

    const asset = await interceptedResponse(fetchHandler, {
      method: "GET",
      mode: "cors",
      url: `${scope}src/main.js?release=offline`
    });
    assert.equal(asset.status, 200);
    assert.equal(await asset.text(), "online:/src/main.js");
  });

  test("cached shell survives transient HTTP errors and missing uncached assets do not masquerade as hits", async () => {
    await lifecyclePromise(harness.handlers.get("install"));
    const fetchHandler = harness.handlers.get("fetch");
    harness.setFetch(async (request) => new Response("temporary failure", {
      status: request.url.endsWith("unlisted.js") ? 404 : 503
    }));

    const navigation = await interceptedResponse(fetchHandler, { method: "GET", mode: "navigate", url: scope });
    assert.equal(navigation.status, 200);
    assert.equal(await navigation.text(), "online:/index.html");

    const cachedAsset = await interceptedResponse(fetchHandler, { method: "GET", mode: "cors", url: `${scope}src/main.js` });
    assert.equal(cachedAsset.status, 200);
    assert.equal(await cachedAsset.text(), "online:/src/main.js");

    const unknownAsset = await interceptedResponse(fetchHandler, { method: "GET", mode: "cors", url: `${scope}src/unlisted.js` });
    assert.equal(unknownAsset.status, 404);
    assert.equal(await unknownAsset.text(), "temporary failure");
  });

  test("runtime cache quota failure never hides a successful network response", async () => {
    await lifecyclePromise(harness.handlers.get("install"));
    harness.setRuntimePutFailure(true);
    harness.setFetch(async () => new Response("fresh network copy", { status: 200 }));

    const response = await interceptedResponse(harness.handlers.get("fetch"), {
      method: "GET",
      mode: "cors",
      url: `${scope}src/main.js`
    });

    assert.equal(response.status, 200);
    assert.equal(await response.text(), "fresh network copy");
    assert.equal(harness.pendingTimers, 0);
  });

  test("runtime cache open or read denial never hides the network and has an explicit offline failure", async () => {
    await lifecyclePromise(harness.handlers.get("install"));
    const fetchHandler = harness.handlers.get("fetch");

    harness.setRuntimeOpenFailure(true);
    harness.setFetch(async () => new Response("network without cache", { status: 200 }));
    const online = await interceptedResponse(fetchHandler, {
      method: "GET",
      mode: "cors",
      url: `${scope}src/main.js`
    });
    assert.equal(online.status, 200);
    assert.equal(await online.text(), "network without cache");

    harness.setFetch(async () => { throw new Error("offline"); });
    const noCache = await interceptedResponse(fetchHandler, { method: "GET", mode: "navigate", url: scope });
    assert.equal(noCache.status, 503);
    assert.match(await noCache.text(), /离线状态下无法载入复航台/u);

    harness.setRuntimeOpenFailure(false);
    harness.setRuntimeMatchFailure(true);
    const unreadableCache = await interceptedResponse(fetchHandler, {
      method: "GET",
      mode: "cors",
      url: `${scope}src/main.js`
    });
    assert.equal(unreadableCache.status, 503);
    assert.equal(await unreadableCache.text(), "Offline asset unavailable");
  });

  test("a stalled runtime cache cannot delay an available network response", async () => {
    await lifecyclePromise(harness.handlers.get("install"));
    harness.setRuntimeOpenStall(true);
    harness.setFetch(async () => new Response("fast network", { status: 200 }));
    const lifetimes = [];

    const response = await interceptedResponse(harness.handlers.get("fetch"), {
      method: "GET",
      mode: "cors",
      url: `${scope}src/main.js`
    }, lifetimes);

    assert.equal(response.status, 200);
    assert.equal(await response.text(), "fast network");
    assert.equal(lifetimes.length, 1);
    assert.equal(harness.pendingTimers, 1, "only the bounded cache-open timer remains");
    harness.fireTimers();
    await Promise.all(lifetimes);
    assert.equal(harness.pendingTimers, 0);
  });

  test("stalled navigation and shell fetches abort into the complete cache", async () => {
    await lifecyclePromise(harness.handlers.get("install"));
    harness.setFetch((_request, { signal } = {}) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new DOMException("timed out", "AbortError")), { once: true });
    }));
    const fetchHandler = harness.handlers.get("fetch");
    const navigationPromise = interceptedResponse(fetchHandler, { method: "GET", mode: "navigate", url: scope });
    for (let attempt = 0; attempt < 10 && harness.pendingTimers !== 1; attempt += 1) await Promise.resolve();
    assert.equal(harness.pendingTimers, 1);
    harness.fireTimers();
    const navigation = await navigationPromise;
    assert.equal(await navigation.text(), "online:/index.html");

    const assetPromise = interceptedResponse(fetchHandler, { method: "GET", mode: "cors", url: `${scope}src/main.js` });
    for (let attempt = 0; attempt < 10 && harness.pendingTimers !== 1; attempt += 1) await Promise.resolve();
    assert.equal(harness.pendingTimers, 1);
    harness.fireTimers();
    const asset = await assetPromise;
    assert.equal(await asset.text(), "online:/src/main.js");
    assert.equal(harness.pendingTimers, 0);
  });

  test("non-GET and cross-origin requests are not intercepted", async () => {
    const fetchHandler = harness.handlers.get("fetch");

    assert.equal(await interceptedResponse(fetchHandler, { method: "POST", mode: "cors", url: scope }), null);
    assert.equal(await interceptedResponse(fetchHandler, { method: "GET", mode: "cors", url: "https://example.com/app.js" }), null);
  });
});
