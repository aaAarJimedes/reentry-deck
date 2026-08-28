import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { IMPORT_LIMITS, createCrumb, createProject } from "../src/core/model.js";
import {
  APP_VERSION,
  AppStore,
  MemoryStorage,
  STORAGE_KEY,
  STORE_NOTICE_LIMIT,
  WRITE_LOCK_KEY,
  inspectStorageUsage
} from "../src/core/store.js";

const PREVIOUS_KEY = `${STORAGE_KEY}/previous`;
const T0 = Date.parse("2026-08-28T00:00:00.000Z");
const T1 = Date.parse("2026-08-28T01:00:00.000Z");
const T2 = Date.parse("2026-08-28T02:00:00.000Z");

function persisted(storage, key = STORAGE_KEY) {
  const text = storage.getItem(key);
  return text === null ? null : JSON.parse(text);
}

function stateWithProject(id = "p1", title = "Project") {
  return {
    schemaVersion: 1,
    meta: {
      createdAt: new Date(T0).toISOString(),
      updatedAt: new Date(T0).toISOString(),
      revision: 4
    },
    settings: { theme: "system", staleAfterDays: 7, reducedMotion: false },
    projects: [createProject({ id, title }, T0)],
    sessions: [],
    crumbs: [],
    checkpoints: [],
    ui: { selectedProjectId: id }
  };
}

describe("MemoryStorage", () => {
  test("implements the localStorage operations used by AppStore", () => {
    const storage = new MemoryStorage();

    assert.equal(storage.getItem("missing"), null);
    storage.setItem("number", 123);
    assert.equal(storage.getItem("number"), "123");
    storage.removeItem("number");
    assert.equal(storage.getItem("number"), null);
    storage.setItem("a", "A");
    storage.setItem("b", "B");
    assert.equal(storage.length, 2);
    assert.equal(storage.key(0), "a");
    assert.equal(storage.key(99), null);
    storage.clear();
    assert.equal(storage.getItem("a"), null);
    assert.equal(storage.getItem("b"), null);
  });

  test("estimates UTF-16 origin and app storage against a conservative boundary", () => {
    const storage = new MemoryStorage();
    storage.setItem(STORAGE_KEY, "四");
    storage.setItem("another-app", "AB");
    const appBytes = (STORAGE_KEY.length + 1) * 2;
    const totalBytes = appBytes + ("another-app".length + 2) * 2;

    assert.deepEqual(inspectStorageUsage(storage, totalBytes), {
      available: true,
      appBytes,
      totalBytes,
      referenceBytes: totalBytes,
      ratio: 1,
      status: "critical"
    });
    assert.equal(inspectStorageUsage(storage, totalBytes + 1).status, "warning");
    assert.equal(inspectStorageUsage(storage, Math.floor(totalBytes / 0.8)).status, "warning");
    assert.equal(inspectStorageUsage(storage, Math.ceil(totalBytes / 0.8)).status, "ok");
    assert.equal(inspectStorageUsage(storage, totalBytes * 2).status, "ok");
  });

  test("storage inspection fails closed for unavailable, invalid, or unreadable storage", () => {
    const broken = {
      length: 1,
      key() { return "reentry-deck/broken"; },
      getItem() { throw new Error("denied"); }
    };

    for (const result of [inspectStorageUsage(null), inspectStorageUsage(new MemoryStorage(), 0), inspectStorageUsage(broken)]) {
      assert.equal(result.available, false);
      assert.equal(result.status, "unavailable");
      assert.equal(Object.isFrozen(result), true);
    }
  });

  test("storage inspection snapshots a bounded trustworthy entry count", () => {
    let lengthReads = 0;
    const growing = {
      get length() {
        lengthReads += 1;
        return lengthReads === 1 ? 1 : Number.MAX_SAFE_INTEGER;
      },
      key(index) { return index === 0 ? "reentry-deck/state" : null; },
      getItem() { return "ok"; }
    };
    const measured = inspectStorageUsage(growing, 1_000);

    assert.equal(measured.available, true);
    assert.equal(lengthReads, 1);
    assert.equal(measured.appBytes, ("reentry-deck/state".length + 2) * 2);
    for (const unsafe of [
      { get length() { throw new Error("denied"); }, key() {}, getItem() {} },
      { length: 10_001, key() {}, getItem() {} },
      { length: 1, key() { return "reentry-deck/state"; }, getItem() { return 42; } }
    ]) {
      assert.equal(inspectStorageUsage(unsafe).available, false);
    }
  });
});

describe("AppStore loading and recovery", () => {
  test("storage diagnostics retain only a bounded recent text window", () => {
    let reads = 0;
    const storage = {
      getItem() {
        reads += 1;
        if (reads === 1) return null;
        throw new Error(`read denied ${"x".repeat(1_000)}`);
      }
    };
    const store = new AppStore(storage, T0, null);

    for (let index = 0; index < 20; index += 1) store.refreshFromStorage();

    const notices = store.drainNotices();
    assert.equal(notices.length, STORE_NOTICE_LIMIT);
    assert.ok(notices.every((notice) => notice.length <= 500));
    assert.match(notices[0], /read denied/u);
    assert.deepEqual(store.drainNotices(), []);
  });

  test("starts safely when the browser denies storage reads", () => {
    const deniedStorage = {
      getItem() {
        const error = new Error("blocked by privacy policy");
        error.name = "SecurityError";
        throw error;
      }
    };
    const store = new AppStore(deniedStorage, T0, null);

    assert.deepEqual(store.getState().projects, []);
    assert.match(store.drainNotices().join("；"), /本地存储不可访问.*blocked by privacy policy/u);
    assert.throws(() => store.update(() => {}, T1), /没有提供可用的本地存储/u);
  });

  test("reports a denied default storage property without crashing construction", () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get() {
        throw new Error("origin storage blocked");
      }
    });
    try {
      const store = new AppStore(undefined, T0, null);
      assert.deepEqual(store.getState().projects, []);
      assert.match(store.drainNotices().join("；"), /本地存储不可访问.*origin storage blocked/u);
    } finally {
      if (original) Object.defineProperty(globalThis, "localStorage", original);
      else delete globalThis.localStorage;
    }
  });

  test("keeps the current state when a later external read is denied", () => {
    class DeniedLaterStorage extends MemoryStorage {
      denied = false;

      getItem(key) {
        if (this.denied) throw new Error("read access revoked");
        return super.getItem(key);
      }
    }
    const storage = new DeniedLaterStorage();
    storage.setItem(STORAGE_KEY, JSON.stringify(stateWithProject("safe", "Safe")));
    const store = new AppStore(storage, T0, null);
    const before = store.getState();
    storage.denied = true;

    assert.equal(store.refreshFromStorage(T1), false);
    assert.strictEqual(store.getState(), before);
    assert.match(store.drainNotices().join("；"), /无法读取另一个标签页的更新.*read access revoked/u);
    assert.throws(() => store.update(() => {}, T1), /无法(取得安全写入租约|核对现有数据).*read access revoked/u);
    assert.strictEqual(store.getState(), before);
  });

  test("destroy detaches storage events and clears subscriptions", () => {
    const storage = new MemoryStorage();
    const eventTarget = new EventTarget();
    const store = new AppStore(storage, T0, eventTarget);
    let emissions = 0;
    store.subscribe(() => emissions += 1);
    store.destroy();
    store.destroy();

    storage.setItem(STORAGE_KEY, JSON.stringify(stateWithProject("external", "External")));
    const event = new Event("storage");
    Object.defineProperty(event, "key", { value: STORAGE_KEY });
    eventTarget.dispatchEvent(event);

    assert.equal(emissions, 0);
    assert.deepEqual(store.getState().projects, []);
  });

  test("a storage clear event synchronizes an empty state with a forward revision", () => {
    const storage = new MemoryStorage();
    const eventTarget = new EventTarget();
    storage.setItem(STORAGE_KEY, JSON.stringify(stateWithProject("before-clear", "Before clear")));
    const store = new AppStore(storage, T0, eventTarget);
    const previousRevision = store.getState().meta.revision;
    const sources = [];
    store.subscribe((_state, event) => sources.push(event.source));
    storage.clear();
    const event = new Event("storage");
    Object.defineProperty(event, "key", { value: null });

    eventTarget.dispatchEvent(event);

    assert.deepEqual(store.getState().projects, []);
    assert.equal(store.getState().meta.revision, previousRevision + 1);
    assert.deepEqual(sources, ["external"]);
  });

  test("storage events from another storage area or unrelated key are ignored", () => {
    const storage = new MemoryStorage();
    const eventTarget = new EventTarget();
    const store = new AppStore(storage, T0, eventTarget);
    let emissions = 0;
    store.subscribe(() => emissions += 1);
    storage.setItem(STORAGE_KEY, JSON.stringify(stateWithProject("external", "External")));
    const wrongArea = new Event("storage");
    Object.defineProperties(wrongArea, {
      key: { value: STORAGE_KEY },
      storageArea: { value: new MemoryStorage() }
    });
    const wrongKey = new Event("storage");
    Object.defineProperty(wrongKey, "key", { value: "some-other-key" });

    eventTarget.dispatchEvent(wrongArea);
    eventTarget.dispatchEvent(wrongKey);

    assert.equal(emissions, 0);
    assert.deepEqual(store.getState().projects, []);
  });

  test("starts with a deterministic empty state when no saved data exists", () => {
    const store = new AppStore(new MemoryStorage(), T0);

    assert.equal(store.getState().meta.createdAt, new Date(T0).toISOString());
    assert.equal(store.getState().meta.revision, 0);
    assert.deepEqual(store.getState().projects, []);
    assert.deepEqual(store.notices, []);
  });

  test("loads and normalizes a valid current state", () => {
    const storage = new MemoryStorage();
    const saved = stateWithProject();
    saved.projects[0].title = "  Trim me  ";
    storage.setItem(STORAGE_KEY, JSON.stringify(saved));

    const store = new AppStore(storage, T1);

    assert.equal(store.getState().projects[0].title, "Trim me");
    assert.equal(store.getState().meta.revision, 4);
    assert.deepEqual(store.notices, []);
  });

  test("recovers the previous state when current JSON is malformed", () => {
    const storage = new MemoryStorage();
    storage.setItem(STORAGE_KEY, "{broken json");
    storage.setItem(PREVIOUS_KEY, JSON.stringify(stateWithProject("recovered", "Recovered")));

    const store = new AppStore(storage, T1);

    assert.equal(store.getState().projects[0].id, "recovered");
    assert.deepEqual(store.notices, ["主数据损坏，已自动恢复到上一个可用版本。请尽快导出备份。"]);
    assert.equal(storage.getItem(STORAGE_KEY), "{broken json");
  });

  test("recovers the previous state when current data uses an unsupported future schema", () => {
    const storage = new MemoryStorage();
    storage.setItem(STORAGE_KEY, JSON.stringify({ schemaVersion: 999 }));
    storage.setItem(PREVIOUS_KEY, JSON.stringify(stateWithProject("old", "Old")));

    const store = new AppStore(storage, T1);

    assert.equal(store.getState().projects[0].id, "old");
    assert.match(store.notices[0], /自动恢复/);
  });

  test("recovers the previous state instead of silently dropping corrupt current references", () => {
    const storage = new MemoryStorage();
    const corrupt = stateWithProject("current", "Corrupt");
    corrupt.sessions.push({ id: "orphan", projectId: "missing", status: "completed" });
    storage.setItem(STORAGE_KEY, JSON.stringify(corrupt));
    storage.setItem(PREVIOUS_KEY, JSON.stringify(stateWithProject("safe", "Safe")));

    const store = new AppStore(storage, T1, null);

    assert.equal(store.getState().projects[0].id, "safe");
    assert.match(store.notices[0], /自动恢复/);
    assert.equal(JSON.parse(storage.getItem(STORAGE_KEY)).sessions[0].id, "orphan");

    store.update((draft) => { draft.projects[0].title = "Repaired"; }, T2);
    assert.equal(persisted(storage).projects[0].title, "Repaired");
    assert.equal(persisted(storage, PREVIOUS_KEY).projects[0].id, "safe");
  });

  test("falls back to a clean state when both current and previous values are unreadable", () => {
    const storage = new MemoryStorage();
    storage.setItem(STORAGE_KEY, "not-json");
    storage.setItem(PREVIOUS_KEY, JSON.stringify({ schemaVersion: 2 }));

    const store = new AppStore(storage, T1);

    assert.deepEqual(store.getState().projects, []);
    assert.equal(store.getState().meta.createdAt, new Date(T1).toISOString());
    assert.equal(store.notices.length, 1);
    assert.match(store.notices[0], /本地数据无法读取/);
    assert.equal(storage.getItem(STORAGE_KEY), "not-json");
  });

  test("does not use a previous value in the absence of a current value", () => {
    const storage = new MemoryStorage();
    storage.setItem(PREVIOUS_KEY, JSON.stringify(stateWithProject("previous")));

    const store = new AppStore(storage, T1);

    assert.deepEqual(store.getState().projects, []);
    assert.deepEqual(store.notices, []);
  });
});

describe("AppStore updates and persistence", () => {
  test("workspace metadata never moves backward when the system clock regresses", () => {
    const store = new AppStore(new MemoryStorage(), T0, null);
    store.update((draft) => draft.projects.push(createProject({ id: "p1" }, T1)), T1);
    const latest = store.update((draft) => { draft.projects[0].title = "Later"; }, T2);
    const regressed = store.update((draft) => { draft.projects[0].title = "Clock moved"; }, T0);

    assert.equal(latest.meta.updatedAt, new Date(T2).toISOString());
    assert.equal(regressed.meta.updatedAt, latest.meta.updatedAt);
    assert.equal(regressed.meta.revision, latest.meta.revision + 1);
  });

  test("update works on a clone, increments revision, persists, and emits the committed state", () => {
    const storage = new MemoryStorage();
    const store = new AppStore(storage, T0);
    const original = store.getState();
    const seen = [];
    const unsubscribe = store.subscribe((state) => seen.push(state));

    const next = store.update((draft) => {
      draft.projects.push(createProject({ id: "p1", title: "New" }, T1));
      draft.ui.selectedProjectId = "p1";
    }, T1);

    assert.notStrictEqual(next, original);
    assert.deepEqual(original.projects, []);
    assert.equal(next.meta.updatedAt, new Date(T1).toISOString());
    assert.equal(next.meta.revision, 1);
    assert.strictEqual(store.getState(), next);
    assert.deepEqual(persisted(storage), next);
    assert.deepEqual(seen, [next]);

    unsubscribe();
    store.update((draft) => {
      draft.projects[0].title = "Changed";
    }, T2);
    assert.equal(seen.length, 1);
  });

  test("each successful overwrite keeps the immediately preceding serialized state", () => {
    const storage = new MemoryStorage();
    const initial = stateWithProject("p1", "Initial");
    storage.setItem(STORAGE_KEY, JSON.stringify(initial));
    const store = new AppStore(storage, T0);

    store.update((draft) => {
      draft.projects[0].title = "First";
    }, T1);
    assert.deepEqual(persisted(storage, PREVIOUS_KEY), initial);

    const firstCommit = structuredClone(store.getState());
    store.update((draft) => {
      draft.projects[0].title = "Second";
    }, T2);
    assert.deepEqual(persisted(storage, PREVIOUS_KEY), firstCommit);
    assert.equal(persisted(storage).projects[0].title, "Second");
  });

  test("a recipe exception leaves state and storage unchanged and emits nothing", () => {
    const storage = new MemoryStorage();
    const store = new AppStore(storage, T0);
    store.update((draft) => draft.projects.push(createProject({ id: "p1" }, T0)), T0);
    const beforeState = store.getState();
    const beforeStorage = storage.getItem(STORAGE_KEY);
    let emissions = 0;
    store.subscribe(() => emissions += 1);

    assert.throws(() => store.update(() => {
      throw new Error("recipe failed");
    }, T1), /recipe failed/);

    assert.strictEqual(store.getState(), beforeState);
    assert.equal(storage.getItem(STORAGE_KEY), beforeStorage);
    assert.equal(emissions, 0);
  });

  test("validation failure leaves state and storage unchanged and emits nothing", () => {
    const storage = new MemoryStorage();
    const store = new AppStore(storage, T0);
    store.update((draft) => draft.projects.push(createProject({ id: "same" }, T0)), T0);
    const beforeState = store.getState();
    const beforeStorage = storage.getItem(STORAGE_KEY);
    let emissions = 0;
    store.subscribe(() => emissions += 1);

    assert.throws(
      () => store.update((draft) => draft.sessions.push({ id: "same" }), T1),
      /无法保存：记录 ID 重复：same/
    );

    assert.strictEqual(store.getState(), beforeState);
    assert.equal(storage.getItem(STORAGE_KEY), beforeStorage);
    assert.equal(emissions, 0);
  });

  test("a local update cannot cross the shared 50,000-record safety boundary", () => {
    const storage = new MemoryStorage();
    const store = new AppStore(storage, T0, null);
    const before = store.getState();

    assert.throws(
      () => store.update((draft) => { draft.crumbs = new Array(50_001); }, T1),
      /超过 50000 条安全上限/
    );
    assert.strictEqual(store.getState(), before);
    assert.equal(storage.getItem(STORAGE_KEY), null);
  });

  test("local updates enforce the same strict content, reference, and time boundaries as imports", () => {
    const cases = [
      {
        mutate(draft) {
          draft.projects[0].description = "x".repeat(IMPORT_LIMITS.projectDescription + 1);
        },
        pattern: /项目说明超过 800 字符上限/
      },
      {
        mutate(draft) {
          draft.crumbs.push(createCrumb({ id: "orphan", projectId: "missing", text: "lost" }, T1));
        },
        pattern: /面包屑引用了不存在的项目：orphan/
      },
      {
        mutate(draft) {
          draft.projects[0].updatedAt = "2026-08-28T00:00:00Z";
        },
        pattern: /项目时间无效：p1.updatedAt/
      },
      {
        mutate(draft) {
          draft.projects[0].title = "visible\u202Ehidden";
        },
        pattern: /项目名称包含不可见控制字符：p1/
      },
      {
        mutate(draft) {
          draft.meta = new Date(T1);
        },
        pattern: /元数据对象无效/
      },
      {
        mutate(draft) {
          draft.settings.staleAfterDays = 366;
        },
        pattern: /陈旧阈值必须是 1 到 365 之间的整数/
      },
      {
        mutate(draft) {
          draft.settings.staleAfterDays = 1.5;
        },
        pattern: /陈旧阈值必须是 1 到 365 之间的整数/
      },
      {
        mutate(draft) {
          draft.settings.extension = { nested: { mutable: true } };
        },
        pattern: /设置包含未知字段：extension/
      }
    ];

    for (const { mutate, pattern } of cases) {
      const storage = new MemoryStorage();
      const store = new AppStore(storage, T0, null);
      store.update((draft) => draft.projects.push(createProject({ id: "p1" }, T0)), T0);
      const beforeState = store.getState();
      const beforeStorage = storage.getItem(STORAGE_KEY);

      assert.throws(() => store.update(mutate, T1), pattern);
      assert.strictEqual(store.getState(), beforeState);
      assert.equal(storage.getItem(STORAGE_KEY), beforeStorage);
    }
  });

  test("a valid attention threshold persists as a numeric setting", () => {
    const storage = new MemoryStorage();
    const store = new AppStore(storage, T0, null);

    const saved = store.update((draft) => { draft.settings.staleAfterDays = 14; }, T1);

    assert.equal(saved.settings.staleAfterDays, 14);
    assert.equal(persisted(storage).settings.staleAfterDays, 14);
  });

  test("a forced reduced-motion preference persists as a boolean setting", () => {
    const storage = new MemoryStorage();
    const store = new AppStore(storage, T0, null);

    const saved = store.update((draft) => { draft.settings.reducedMotion = true; }, T1);

    assert.equal(saved.settings.reducedMotion, true);
    assert.equal(persisted(storage).settings.reducedMotion, true);
  });

  test("a current-value write failure restores serialized data and does not commit or emit", () => {
    class FailNextCurrentWriteStorage extends MemoryStorage {
      failNextCurrentWrite = false;

      setItem(key, value) {
        if (key === STORAGE_KEY && this.failNextCurrentWrite) {
          this.failNextCurrentWrite = false;
          throw new Error("quota reached");
        }
        super.setItem(key, value);
      }
    }

    const storage = new FailNextCurrentWriteStorage();
    storage.setItem(STORAGE_KEY, JSON.stringify(stateWithProject("p1", "Before")));
    const store = new AppStore(storage, T0);
    const beforeState = store.getState();
    const beforeStorage = storage.getItem(STORAGE_KEY);
    let emissions = 0;
    store.subscribe(() => emissions += 1);
    storage.failNextCurrentWrite = true;

    assert.throws(
      () => store.update((draft) => {
        draft.projects[0].title = "After";
      }, T1),
      /本地保存失败，原数据仍然保留：quota reached/
    );

    assert.strictEqual(store.getState(), beforeState);
    assert.equal(storage.getItem(STORAGE_KEY), beforeStorage);
    assert.equal(emissions, 0);
  });

  test("a non-Error storage rejection still produces a stable save diagnostic", () => {
    class PrimitiveFailureStorage extends MemoryStorage {
      failNextCurrentWrite = false;

      setItem(key, value) {
        if (key === STORAGE_KEY && this.failNextCurrentWrite) {
          this.failNextCurrentWrite = false;
          throw "primitive storage rejection";
        }
        super.setItem(key, value);
      }
    }

    const storage = new PrimitiveFailureStorage();
    const store = new AppStore(storage, T0, null);
    storage.failNextCurrentWrite = true;

    assert.throws(
      () => store.update((draft) => { draft.settings.staleAfterDays = 30; }, T1),
      /本地保存失败，原数据仍然保留：访问被拒绝/u
    );
    assert.equal(store.getState().settings.staleAfterDays, 7);
  });

  test("mutating a previously emitted state cannot change an older state object", () => {
    const store = new AppStore(new MemoryStorage(), T0);
    const first = store.update((draft) => draft.projects.push(createProject({ id: "p1", title: "First" }, T0)), T1);
    const second = store.update((draft) => {
      draft.projects[0].title = "Second";
    }, T2);

    assert.equal(first.projects[0].title, "First");
    assert.equal(second.projects[0].title, "Second");
  });

  test("published state is recursively frozen across containers and records", () => {
    const storage = new MemoryStorage();
    const store = new AppStore(storage, T0, null);
    const state = store.update((draft) => draft.projects.push(createProject({ id: "p1", title: "Original" }, T0)), T1);

    for (const value of [state, state.meta, state.settings, state.ui, state.projects, state.projects[0], state.sessions, state.crumbs, state.checkpoints]) {
      assert.equal(Object.isFrozen(value), true);
    }
    assert.throws(() => { store.getState().projects[0].title = "Tampered"; }, TypeError);
    assert.throws(() => { store.getState().projects.push(createProject({ id: "p2" }, T1)); }, TypeError);
    assert.equal(store.getState().projects[0].title, "Original");
    assert.equal(persisted(storage).projects[0].title, "Original");

    const next = store.update((draft) => { draft.projects[0].title = "Updated through recipe"; }, T2);
    assert.equal(next.projects[0].title, "Updated through recipe");
    assert.equal(Object.isFrozen(next.projects[0]), true);
  });

  test("a failing subscriber cannot misreport a committed write or block later subscribers", () => {
    const storage = new MemoryStorage();
    const store = new AppStore(storage, T0, null);
    let failingCalls = 0;
    let healthyCalls = 0;
    store.subscribe(() => {
      failingCalls += 1;
      throw new Error("render unavailable");
    });
    store.subscribe((state, event) => {
      healthyCalls += 1;
      assert.equal(Object.isFrozen(state), true);
      assert.equal(event.source, "local");
    });

    const first = store.update((draft) => { draft.settings.theme = "dark"; }, T1);
    const second = store.update((draft) => { draft.settings.theme = "light"; }, T2);

    assert.equal(first.settings.theme, "dark");
    assert.equal(second.settings.theme, "light");
    assert.equal(persisted(storage).settings.theme, "light");
    assert.equal(failingCalls, 2);
    assert.equal(healthyCalls, 2);
    assert.equal(store.drainNotices().filter((notice) => notice.includes("render unavailable")).length, 1);
    assert.throws(() => store.subscribe(null), /订阅者必须是函数/u);
  });

  test("saving without storage reports a clear error and keeps the empty state", () => {
    const store = new AppStore(null, T0);
    const before = store.getState();

    assert.throws(() => store.update(() => {}, T1), /浏览器没有提供可用的本地存储/);
    assert.strictEqual(store.getState(), before);
  });

  test("prevents stale tabs from overwriting a newer persisted revision and can retry on refreshed state", () => {
    const storage = new MemoryStorage();
    const firstTab = new AppStore(storage, T0, null);
    const secondTab = new AppStore(storage, T0, null);
    const sources = [];
    secondTab.subscribe((_state, event) => sources.push(event.source));

    firstTab.update((draft) => draft.projects.push(createProject({ id: "from-first" }, T1)), T1);
    assert.throws(
      () => secondTab.update((draft) => draft.projects.push(createProject({ id: "from-second" }, T1)), T1),
      /另一个标签页刚刚更新了数据/
    );
    assert.deepEqual(secondTab.getState().projects.map((item) => item.id), ["from-first"]);
    assert.deepEqual(sources, ["external"]);

    secondTab.update((draft) => draft.projects.push(createProject({ id: "from-second" }, T2)), T2);
    assert.deepEqual(persisted(storage).projects.map((item) => item.id), ["from-first", "from-second"]);
    assert.deepEqual(sources, ["external", "local"]);
  });

  test("a short write lease serializes truly simultaneous tab commits and expires safely", () => {
    class InterleavingStorage extends MemoryStorage {
      onLease = null;

      setItem(key, value) {
        super.setItem(key, value);
        if (key === WRITE_LOCK_KEY && this.onLease) {
          const callback = this.onLease;
          this.onLease = null;
          callback();
        }
      }
    }
    const storage = new InterleavingStorage();
    const firstTab = new AppStore(storage, T0, null);
    const competingTab = new AppStore(storage, T0, null);
    let competingError = null;
    storage.onLease = () => {
      try {
        competingTab.update((draft) => draft.projects.push(createProject({ id: "competing" }, T1)), T1);
      } catch (error) {
        competingError = error;
      }
    };

    const saved = firstTab.update((draft) => draft.projects.push(createProject({ id: "winner" }, T1)), T1);

    assert.deepEqual(saved.projects.map((project) => project.id), ["winner"]);
    assert.match(competingError?.message ?? "", /另一个标签页正在保存/u);
    assert.deepEqual(persisted(storage).projects.map((project) => project.id), ["winner"]);
    assert.equal(storage.getItem(WRITE_LOCK_KEY), null);

    storage.setItem(WRITE_LOCK_KEY, JSON.stringify({ owner: "crashed-tab", expiresAt: 0 }));
    const next = firstTab.update((draft) => { draft.settings.theme = "dark"; }, T2);
    assert.equal(next.settings.theme, "dark");
    assert.equal(storage.getItem(WRITE_LOCK_KEY), null);
  });

  test("rechecks primary data after serialization to catch legacy tabs that ignore the lease", () => {
    class LegacyInterleavingStorage extends MemoryStorage {
      lockReads = 0;
      externalRaw = null;

      getItem(key) {
        const value = super.getItem(key);
        if (key === WRITE_LOCK_KEY) {
          this.lockReads += 1;
          if (this.lockReads === 3 && this.externalRaw !== null) super.setItem(STORAGE_KEY, this.externalRaw);
        }
        return value;
      }
    }
    const storage = new LegacyInterleavingStorage();
    const store = new AppStore(storage, T0, null);
    const external = stateWithProject("legacy-winner", "Legacy winner");
    external.meta.revision = 1;
    external.meta.updatedAt = new Date(T1).toISOString();
    storage.externalRaw = JSON.stringify(external);

    assert.throws(
      () => store.update((draft) => draft.projects.push(createProject({ id: "must-not-overwrite" }, T1)), T1),
      /在本次保存期间更新了数据/u
    );

    assert.deepEqual(store.getState().projects.map((project) => project.id), ["legacy-winner"]);
    assert.deepEqual(persisted(storage).projects.map((project) => project.id), ["legacy-winner"]);
    assert.equal(storage.getItem(WRITE_LOCK_KEY), null);
  });

  test("verifies the committed primary value before publishing local state", () => {
    class PostWriteInterleavingStorage extends MemoryStorage {
      externalRaw = null;
      replaceNextPrimary = false;

      setItem(key, value) {
        super.setItem(key, value);
        if (key === STORAGE_KEY && this.replaceNextPrimary) {
          this.replaceNextPrimary = false;
          super.setItem(key, this.externalRaw);
        }
      }
    }
    const storage = new PostWriteInterleavingStorage();
    const store = new AppStore(storage, T0, null);
    store.update((draft) => draft.projects.push(createProject({ id: "original" }, T0)), T0);
    const external = stateWithProject("post-write-winner", "Post-write winner");
    external.meta.revision = 2;
    external.meta.updatedAt = new Date(T1).toISOString();
    storage.externalRaw = JSON.stringify(external);
    storage.replaceNextPrimary = true;

    assert.throws(
      () => store.update((draft) => { draft.projects[0].title = "Must not publish"; }, T1),
      /保存完成时替换了数据/u
    );

    assert.deepEqual(store.getState().projects.map((project) => project.id), ["post-write-winner"]);
    assert.deepEqual(persisted(storage).projects.map((project) => project.id), ["post-write-winner"]);
    assert.equal(storage.getItem(WRITE_LOCK_KEY), null);
  });

  test("a denied post-write verification does not misreport a successful standard write", () => {
    class PostWriteReadDeniedStorage extends MemoryStorage {
      denyNextPrimaryRead = false;

      getItem(key) {
        if (key === STORAGE_KEY && this.denyNextPrimaryRead) {
          this.denyNextPrimaryRead = false;
          throw new Error("read denied");
        }
        return super.getItem(key);
      }

      setItem(key, value) {
        super.setItem(key, value);
        if (key === STORAGE_KEY) this.denyNextPrimaryRead = true;
      }
    }
    const storage = new PostWriteReadDeniedStorage();
    const store = new AppStore(storage, T0, null);

    const next = store.update((draft) => draft.projects.push(createProject({ id: "committed" }, T1)), T1);

    assert.deepEqual(next.projects.map((project) => project.id), ["committed"]);
    assert.deepEqual(persisted(storage).projects.map((project) => project.id), ["committed"]);
    assert.match(store.notices.at(-1), /已写入，但无法立即复核/u);
    assert.equal(storage.getItem(WRITE_LOCK_KEY), null);
  });

  test("rechecks the primary value after writing the rolling snapshot and before publishing", () => {
    class SnapshotInterleavingStorage extends MemoryStorage {
      externalRaw = null;
      replaceDuringSnapshot = false;

      setItem(key, value) {
        super.setItem(key, value);
        if (key === PREVIOUS_KEY && this.replaceDuringSnapshot) {
          this.replaceDuringSnapshot = false;
          super.setItem(STORAGE_KEY, this.externalRaw);
        }
      }
    }
    const storage = new SnapshotInterleavingStorage();
    const store = new AppStore(storage, T0, null);
    store.update((draft) => draft.projects.push(createProject({ id: "original" }, T0)), T0);
    const external = stateWithProject("snapshot-winner", "Snapshot winner");
    external.meta.revision = 2;
    external.meta.updatedAt = new Date(T1).toISOString();
    storage.externalRaw = JSON.stringify(external);
    storage.replaceDuringSnapshot = true;

    assert.throws(
      () => store.update((draft) => { draft.projects[0].title = "Must not publish"; }, T1),
      /保存完成时替换了数据/u
    );

    assert.deepEqual(store.getState().projects.map((project) => project.id), ["snapshot-winner"]);
    assert.deepEqual(persisted(storage).projects.map((project) => project.id), ["snapshot-winner"]);
    assert.equal(storage.getItem(WRITE_LOCK_KEY), null);
  });

  test("an active foreign write lease fails before recipes can overwrite storage", () => {
    const storage = new MemoryStorage();
    const store = new AppStore(storage, T0, null);
    const before = store.getState();
    storage.setItem(WRITE_LOCK_KEY, JSON.stringify({ owner: "other-tab", expiresAt: Date.now() + 1_000 }));

    assert.throws(
      () => store.update((draft) => draft.projects.push(createProject({ id: "blocked" }, T1)), T1),
      /另一个标签页正在保存/u
    );
    assert.strictEqual(store.getState(), before);
    assert.equal(storage.getItem(STORAGE_KEY), null);
  });

  test("an implausibly distant lease cannot make the workspace permanently read-only", () => {
    const storage = new MemoryStorage();
    const store = new AppStore(storage, T0, null);
    storage.setItem(WRITE_LOCK_KEY, JSON.stringify({ owner: "clock-rollback", expiresAt: Date.now() + 60_000 }));

    const saved = store.update((draft) => draft.projects.push(createProject({ id: "recovered" }, T1)), T1);

    assert.deepEqual(saved.projects.map((project) => project.id), ["recovered"]);
    assert.deepEqual(persisted(storage).projects.map((project) => project.id), ["recovered"]);
    assert.equal(storage.getItem(WRITE_LOCK_KEY), null);
  });

  test("a lease that expires before the primary write aborts without committing", () => {
    const originalNow = Date.now;
    const storage = new MemoryStorage();
    const store = new AppStore(storage, T0, null);
    let clockReads = 0;
    Date.now = () => clockReads++ === 0 ? 1_000 : 7_000;
    try {
      assert.throws(
        () => store.update((draft) => draft.projects.push(createProject({ id: "too-late" }, T1)), T1),
        /同时取得了保存权/u
      );
      assert.equal(storage.getItem(STORAGE_KEY), null);
      assert.equal(storage.getItem(WRITE_LOCK_KEY), null);
      assert.deepEqual(store.getState().projects, []);
    } finally {
      Date.now = originalNow;
    }
  });

  test("rejects a corrupt external-tab payload without adopting its lossy normalization", () => {
    const storage = new MemoryStorage();
    storage.setItem(STORAGE_KEY, JSON.stringify(stateWithProject("safe", "Safe")));
    const store = new AppStore(storage, T0, null);
    let emissions = 0;
    const sources = [];
    store.subscribe((_state, event) => {
      emissions += 1;
      sources.push(event.source);
    });
    const corrupt = stateWithProject("external", "External");
    corrupt.crumbs.push({ id: "orphan", projectId: "missing", text: "would be dropped" });
    storage.setItem(STORAGE_KEY, JSON.stringify(corrupt));

    const refreshed = store.refreshFromStorage(T1);

    assert.equal(refreshed, false);
    assert.equal(store.getState().projects[0].id, "safe");
    assert.match(store.notices.at(-1), /另一个标签页写入的数据无法安全采用/);
    assert.equal(emissions, 1);
    assert.deepEqual(sources, ["external"]);

    assert.equal(store.refreshFromStorage(T2), false);
    assert.equal(emissions, 1);
    assert.equal(store.notices.length, 1);
    const notices = store.drainNotices();
    assert.equal(notices.length, 1);
    assert.match(notices[0], /另一个标签页写入的数据无法安全采用/);
    assert.deepEqual(store.drainNotices(), []);
  });

  test("rejects structurally valid external revision rollback without changing the current state", () => {
    const storage = new MemoryStorage();
    storage.setItem(STORAGE_KEY, JSON.stringify(stateWithProject("current", "Current")));
    const store = new AppStore(storage, T0, null);
    const before = store.getState();
    const rollback = stateWithProject("older", "Older");
    rollback.meta.revision = before.meta.revision - 1;
    storage.setItem(STORAGE_KEY, JSON.stringify(rollback));

    assert.equal(store.refreshFromStorage(T1), false);
    assert.strictEqual(store.getState(), before);
    assert.match(store.notices.at(-1), /外部修订号倒退/);
    assert.deepEqual(store.getState().projects.map((item) => item.id), ["current"]);
  });

  test("adopts a same-revision collision and remains writable at the next revision", () => {
    const storage = new MemoryStorage();
    const current = stateWithProject("current", "Current");
    storage.setItem(STORAGE_KEY, JSON.stringify(current));
    const store = new AppStore(storage, T0, null);
    const collision = stateWithProject("collision", "Collision winner");
    collision.meta.revision = current.meta.revision;
    collision.meta.updatedAt = new Date(T1).toISOString();
    storage.setItem(STORAGE_KEY, JSON.stringify(collision));
    const sources = [];
    store.subscribe((_state, event) => sources.push(event.source));

    assert.equal(store.refreshFromStorage(T1), true);
    assert.deepEqual(store.getState().projects.map((project) => project.id), ["collision"]);
    assert.match(store.notices.at(-1), /相同修订号的不同内容/u);
    assert.deepEqual(sources, ["external"]);

    const saved = store.update((draft) => { draft.projects[0].title = "Writable again"; }, T2);
    assert.equal(saved.meta.revision, current.meta.revision + 1);
    assert.equal(saved.projects[0].title, "Writable again");
    assert.equal(persisted(storage).projects[0].title, "Writable again");
  });

  test("treats differently formatted but semantically identical external JSON as idempotent", () => {
    const storage = new MemoryStorage();
    const current = stateWithProject("current", "Current");
    storage.setItem(STORAGE_KEY, JSON.stringify(current));
    const store = new AppStore(storage, T0, null);
    const before = store.getState();
    const sources = [];
    store.subscribe((_state, event) => sources.push(event.source));
    storage.setItem(STORAGE_KEY, JSON.stringify(current, null, 2));

    assert.equal(store.refreshFromStorage(T1), false);
    assert.strictEqual(store.getState(), before);
    assert.deepEqual(store.drainNotices(), []);
    assert.deepEqual(sources, []);

    const saved = store.update((draft) => { draft.projects[0].title = "Still writable"; }, T1);
    assert.equal(saved.meta.revision, current.meta.revision + 1);
    assert.equal(persisted(storage).projects[0].title, "Still writable");
  });

  test("rejects a forward external revision whose workspace time moves backward", () => {
    const storage = new MemoryStorage();
    const current = stateWithProject("current", "Current");
    current.meta.updatedAt = new Date(T2).toISOString();
    storage.setItem(STORAGE_KEY, JSON.stringify(current));
    const store = new AppStore(storage, T2, null);
    const before = store.getState();
    const timeRollback = stateWithProject("rollback", "Time rollback");
    timeRollback.meta.revision = before.meta.revision + 1;
    timeRollback.meta.updatedAt = new Date(T1).toISOString();
    storage.setItem(STORAGE_KEY, JSON.stringify(timeRollback));

    assert.equal(store.refreshFromStorage(T2), false);
    assert.strictEqual(store.getState(), before);
    assert.match(store.notices.at(-1), /外部更新时间倒退/);
  });

  test("external primary-key removal becomes a monotonic empty revision", () => {
    const storage = new MemoryStorage();
    storage.setItem(STORAGE_KEY, JSON.stringify(stateWithProject("current", "Current")));
    const store = new AppStore(storage, T0, null);
    const previousRevision = store.getState().meta.revision;
    storage.removeItem(STORAGE_KEY);

    assert.equal(store.refreshFromStorage(T1), true);
    assert.deepEqual(store.getState().projects, []);
    assert.equal(store.getState().meta.revision, previousRevision + 1);
    const saved = store.update((draft) => { draft.settings.theme = "dark"; }, T2);
    assert.equal(saved.meta.revision, previousRevision + 2);
  });

  test("a quota failure for the rollback copy does not make successful current writes read-only", () => {
    class BackupQuotaStorage extends MemoryStorage {
      setItem(key, value) {
        if (key === PREVIOUS_KEY && String(value).length > 1000) throw new Error("backup quota");
        super.setItem(key, value);
      }
    }
    const storage = new BackupQuotaStorage();
    const store = new AppStore(storage, T0, null);
    store.update((draft) => draft.projects.push(createProject({ id: "large", description: "x".repeat(IMPORT_LIMITS.projectDescription) }, T1)), T1);

    const next = store.update((draft) => { draft.projects[0].title = "Still writable"; }, T2);

    assert.equal(next.projects[0].title, "Still writable");
    assert.equal(persisted(storage).projects[0].title, "Still writable");
  });

  test("a main-write quota error can release the rolling snapshot and retry once", () => {
    class ReclaimableQuotaStorage extends MemoryStorage {
      quotaMode = false;

      setItem(key, value) {
        if (this.quotaMode && key === STORAGE_KEY && this.getItem(PREVIOUS_KEY) !== null) {
          const error = new Error("storage full");
          error.name = "QuotaExceededError";
          throw error;
        }
        super.setItem(key, value);
      }
    }
    const storage = new ReclaimableQuotaStorage();
    const store = new AppStore(storage, T0, null);
    store.update((draft) => draft.projects.push(createProject({ id: "p1", title: "First" }, T0)), T0);
    store.update((draft) => { draft.projects[0].title = "Second"; }, T1);
    assert.notEqual(storage.getItem(PREVIOUS_KEY), null);
    storage.quotaMode = true;

    const saved = store.update((draft) => { draft.projects[0].title = "Saved after reclaim"; }, T2);

    assert.equal(saved.projects[0].title, "Saved after reclaim");
    assert.equal(persisted(storage).projects[0].title, "Saved after reclaim");
    assert.equal(storage.getItem(PREVIOUS_KEY), null);
    assert.match(store.notices.at(-1), /释放.*滚动撤销快照/);
  });

  test("a quota retry rechecks primary data before releasing the rolling snapshot", () => {
    class QuotaInterleavingStorage extends MemoryStorage {
      quotaMode = false;
      quotaObserved = false;
      externalRaw = null;
      injected = false;

      getItem(key) {
        const value = super.getItem(key);
        if (key === WRITE_LOCK_KEY && this.quotaObserved && !this.injected) {
          this.injected = true;
          super.setItem(STORAGE_KEY, this.externalRaw);
        }
        return value;
      }

      setItem(key, value) {
        if (this.quotaMode && key === STORAGE_KEY && !this.quotaObserved) {
          this.quotaObserved = true;
          const error = new Error("storage full");
          error.name = "QuotaExceededError";
          throw error;
        }
        super.setItem(key, value);
      }
    }
    const storage = new QuotaInterleavingStorage();
    const store = new AppStore(storage, T0, null);
    store.update((draft) => draft.projects.push(createProject({ id: "p1", title: "First" }, T0)), T0);
    store.update((draft) => { draft.projects[0].title = "Second"; }, T1);
    const beforePrevious = storage.getItem(PREVIOUS_KEY);
    const external = stateWithProject("quota-winner", "Quota winner");
    external.meta.revision = 3;
    external.meta.updatedAt = new Date(T2).toISOString();
    storage.externalRaw = JSON.stringify(external);
    storage.quotaMode = true;

    assert.throws(
      () => store.update((draft) => { draft.projects[0].title = "Must not overwrite"; }, T2 + 1),
      /在本次保存期间更新了数据/u
    );

    assert.deepEqual(store.getState().projects.map((project) => project.id), ["quota-winner"]);
    assert.deepEqual(persisted(storage).projects.map((project) => project.id), ["quota-winner"]);
    assert.equal(storage.getItem(PREVIOUS_KEY), beforePrevious);
    assert.equal(storage.getItem(WRITE_LOCK_KEY), null);
  });

  test("a displaced quota retry preserves the external tab's rolling snapshot", () => {
    class PostRetryInterleavingStorage extends MemoryStorage {
      quotaMode = false;
      primaryAttempts = 0;
      externalRaw = null;
      externalPrevious = null;

      setItem(key, value) {
        if (!this.quotaMode || key !== STORAGE_KEY) {
          super.setItem(key, value);
          return;
        }
        this.primaryAttempts += 1;
        if (this.primaryAttempts === 1) {
          const error = new Error("storage full");
          error.name = "QuotaExceededError";
          throw error;
        }
        super.setItem(STORAGE_KEY, value);
        super.setItem(STORAGE_KEY, this.externalRaw);
        super.setItem(PREVIOUS_KEY, this.externalPrevious);
      }
    }
    const storage = new PostRetryInterleavingStorage();
    const store = new AppStore(storage, T0, null);
    store.update((draft) => draft.projects.push(createProject({ id: "p1", title: "First" }, T0)), T0);
    store.update((draft) => { draft.projects[0].title = "Second"; }, T1);
    const external = stateWithProject("retry-winner", "Retry winner");
    external.meta.revision = 3;
    external.meta.updatedAt = new Date(T2).toISOString();
    const externalPrevious = stateWithProject("external-rollback", "External rollback");
    externalPrevious.meta.revision = 2;
    externalPrevious.meta.updatedAt = new Date(T1).toISOString();
    storage.externalRaw = JSON.stringify(external);
    storage.externalPrevious = JSON.stringify(externalPrevious);
    storage.quotaMode = true;

    assert.throws(
      () => store.update((draft) => { draft.projects[0].title = "Must not publish"; }, T2 + 1),
      /保存完成时替换了数据/u
    );

    assert.deepEqual(store.getState().projects.map((project) => project.id), ["retry-winner"]);
    assert.deepEqual(persisted(storage).projects.map((project) => project.id), ["retry-winner"]);
    assert.deepEqual(persisted(storage, PREVIOUS_KEY).projects.map((project) => project.id), ["external-rollback"]);
    assert.equal(storage.getItem(WRITE_LOCK_KEY), null);
  });

  test("a failed quota retry restores the rolling snapshot and leaves the primary state unchanged", () => {
    class PersistentQuotaStorage extends MemoryStorage {
      quotaMode = false;

      setItem(key, value) {
        if (this.quotaMode && key === STORAGE_KEY) {
          const error = new Error("still full");
          error.name = "QuotaExceededError";
          throw error;
        }
        super.setItem(key, value);
      }
    }
    const storage = new PersistentQuotaStorage();
    const store = new AppStore(storage, T0, null);
    store.update((draft) => draft.projects.push(createProject({ id: "p1", title: "First" }, T0)), T0);
    store.update((draft) => { draft.projects[0].title = "Second"; }, T1);
    const beforeState = store.getState();
    const beforePrimary = storage.getItem(STORAGE_KEY);
    const beforePrevious = storage.getItem(PREVIOUS_KEY);
    storage.quotaMode = true;

    assert.throws(
      () => store.update((draft) => { draft.projects[0].title = "Must not commit"; }, T2),
      /本地保存失败，原数据仍然保留：still full/
    );
    assert.strictEqual(store.getState(), beforeState);
    assert.equal(storage.getItem(STORAGE_KEY), beforePrimary);
    assert.equal(storage.getItem(PREVIOUS_KEY), beforePrevious);
  });
});

describe("AppStore replacement, snapshots, and reset", () => {
  test("rolling snapshots support safe undo and redo with monotonic revisions", () => {
    const storage = new MemoryStorage();
    const store = new AppStore(storage, T0, null);
    let emissions = 0;
    store.subscribe(() => emissions += 1);

    store.update((draft) => draft.projects.push(createProject({ id: "p1", title: "First" }, T0)), T0);
    assert.equal(store.hasPreviousSnapshot(), false, "the first write has no older persisted state");
    store.update((draft) => { draft.projects[0].title = "Second"; }, T1);
    assert.equal(store.hasPreviousSnapshot(), true);

    const undone = store.restorePrevious(T2);
    assert.equal(undone.projects[0].title, "First");
    assert.equal(undone.meta.revision, 3);
    assert.equal(persisted(storage, PREVIOUS_KEY).projects[0].title, "Second");

    const redone = store.restorePrevious(T2 + 1);
    assert.equal(redone.projects[0].title, "Second");
    assert.equal(redone.meta.revision, 4);
    assert.equal(emissions, 4);
  });

  test("missing or damaged rolling snapshots never replace current data", () => {
    const storage = new MemoryStorage();
    const store = new AppStore(storage, T0, null);
    const before = store.getState();
    assert.equal(store.hasPreviousSnapshot(), false);
    assert.throws(() => store.restorePrevious(T1), /没有可恢复/);

    storage.setItem(PREVIOUS_KEY, "{broken");
    assert.equal(store.hasPreviousSnapshot(), false);
    assert.throws(() => store.restorePrevious(T1), /已损坏/);
    assert.strictEqual(store.getState(), before);
  });

  test("a stale tab cannot restore an old snapshot over a newer external write", () => {
    const storage = new MemoryStorage();
    storage.setItem(STORAGE_KEY, JSON.stringify(stateWithProject("p1", "Initial")));
    storage.setItem(PREVIOUS_KEY, JSON.stringify(stateWithProject("p1", "Older")));
    const firstTab = new AppStore(storage, T0, null);
    const staleTab = new AppStore(storage, T0, null);
    firstTab.update((draft) => { draft.projects[0].title = "External"; }, T1);

    assert.throws(() => staleTab.restorePrevious(T2), /另一个标签页刚刚更新了数据/);
    assert.equal(staleTab.getState().projects[0].title, "External");
    assert.equal(persisted(storage).projects[0].title, "External");
  });

  test("replace normalizes input, increments imported revision, persists, and emits", () => {
    const storage = new MemoryStorage();
    const store = new AppStore(storage, T0);
    let emitted;
    store.subscribe((state) => emitted = state);
    const incoming = stateWithProject("incoming", "  Incoming  ");
    incoming.projects[0].title = "  Incoming  ";

    const next = store.replace(incoming, T1);

    assert.equal(next.projects[0].title, "Incoming");
    assert.equal(next.meta.revision, incoming.meta.revision + 1);
    assert.equal(next.meta.updatedAt, new Date(T1).toISOString());
    assert.strictEqual(emitted, next);
    assert.deepEqual(persisted(storage), next);
    assert.equal(incoming.projects[0].title, "  Incoming  ");
    assert.equal(incoming.meta.revision, 4);
  });

  test("replace advances beyond the current revision even when a backup revision is older", () => {
    const store = new AppStore(new MemoryStorage(), T0, null);
    for (let index = 0; index < 6; index += 1) store.update(() => {}, T1 + index);
    const currentRevision = store.getState().meta.revision;
    const incoming = stateWithProject("older-backup", "Older backup");
    incoming.meta.revision = 1;

    const replaced = store.replace(incoming, T2);

    assert.equal(replaced.meta.revision, currentRevision + 1);
  });

  test("replace rejects duplicate ids before changing state or storage", () => {
    const storage = new MemoryStorage();
    const store = new AppStore(storage, T0);
    store.update((draft) => draft.projects.push(createProject({ id: "existing" }, T0)), T0);
    const beforeState = store.getState();
    const beforeStorage = storage.getItem(STORAGE_KEY);
    const incoming = stateWithProject("duplicate");
    incoming.sessions.push({ id: "duplicate", projectId: "duplicate" });

    assert.throws(() => store.replace(incoming, T1), /导入失败：记录 ID 重复：duplicate/);
    assert.strictEqual(store.getState(), beforeState);
    assert.equal(storage.getItem(STORAGE_KEY), beforeStorage);
  });

  test("replace rejects malformed collections and orphan records without changing current data", () => {
    const storage = new MemoryStorage();
    const store = new AppStore(storage, T0, null);
    store.update((draft) => draft.projects.push(createProject({ id: "safe" }, T0)), T0);
    const before = storage.getItem(STORAGE_KEY);

    const malformed = stateWithProject("incoming");
    malformed.sessions = [{ id: "orphan-session", projectId: "missing", status: "active" }];
    assert.throws(() => store.replace(malformed, T1), /会话引用了不存在的项目/);

    assert.equal(storage.getItem(STORAGE_KEY), before);
    assert.deepEqual(store.getState().projects.map((item) => item.id), ["safe"]);
  });

  test("importSnapshot accepts both backup envelopes and raw state", () => {
    const store = new AppStore(new MemoryStorage(), T0);

    const fromEnvelope = store.importSnapshot(
      { format: "reentry-deck-backup", data: stateWithProject("envelope", "Envelope") },
      T1
    );
    assert.equal(fromEnvelope.projects[0].id, "envelope");

    const fromRaw = store.importSnapshot(stateWithProject("raw", "Raw"), T2);
    assert.equal(fromRaw.projects[0].id, "raw");
  });

  test("previewImport validates and compares without changing state or storage", () => {
    const storage = new MemoryStorage();
    const store = new AppStore(storage, T0, null);
    store.update((draft) => draft.projects.push(createProject({ id: "current", title: "Current" }, T0)), T0);
    const beforeState = store.getState();
    const beforeStorage = storage.getItem(STORAGE_KEY);

    const preview = store.previewImport(stateWithProject("incoming", "Incoming"), T1);

    assert.equal(preview.projectChanges.addedTotal, 1);
    assert.equal(preview.projectChanges.removedTotal, 1);
    assert.strictEqual(store.getState(), beforeState);
    assert.equal(storage.getItem(STORAGE_KEY), beforeStorage);
  });

  test("a recognized backup envelope without data is rejected without clearing existing data", () => {
    const store = new AppStore(new MemoryStorage(), T0);
    store.update((draft) => draft.projects.push(createProject({ id: "p1" }, T0)), T0);
    const before = store.getState();

    assert.throws(
      () => store.importSnapshot({ format: "reentry-deck-backup" }, T1),
      /导入失败：备份信封缺少数据内容/
    );
    assert.strictEqual(store.getState(), before);
  });

  test("exportSnapshot returns metadata and a detached state copy", () => {
    const store = new AppStore(new MemoryStorage(), T0);
    store.update((draft) => draft.projects.push(createProject({ id: "p1", title: "Original" }, T0)), T0);
    const nativeStructuredClone = globalThis.structuredClone;
    globalThis.structuredClone = () => { throw new Error("workspace clone must not be used"); };
    let snapshot;
    try {
      snapshot = store.exportSnapshot(T2);
    } finally {
      globalThis.structuredClone = nativeStructuredClone;
    }

    assert.equal(snapshot.format, "reentry-deck-backup");
    assert.equal(snapshot.appVersion, APP_VERSION);
    assert.match(snapshot.checksum, /^fnv1a32:[0-9a-f]{8}$/u);
    assert.equal(snapshot.exportedAt, new Date(T2).toISOString());
    assert.deepEqual(snapshot.data, store.getState());
    assert.notStrictEqual(snapshot.data, store.getState());
    assert.notStrictEqual(snapshot.data.projects, store.getState().projects);
    snapshot.data.projects[0].title = "Mutated snapshot";
    assert.equal(store.getState().projects[0].title, "Original");
  });

  test("exportSnapshotText reuses one canonical data serialization without cloning the workspace", () => {
    const store = new AppStore(new MemoryStorage(), T0);
    store.update((draft) => draft.projects.push(createProject({ id: "p1", title: "Compact export" }, T0)), T0);
    const nativeStructuredClone = globalThis.structuredClone;
    globalThis.structuredClone = () => { throw new Error("workspace clone must not be used"); };
    let text;
    try {
      text = store.exportSnapshotText(T2);
    } finally {
      globalThis.structuredClone = nativeStructuredClone;
    }

    const snapshot = JSON.parse(text);
    assert.equal(snapshot.format, "reentry-deck-backup");
    assert.equal(snapshot.exportedAt, new Date(T2).toISOString());
    assert.deepEqual(snapshot.data, store.getState());
    assert.doesNotThrow(() => new AppStore(new MemoryStorage(), T2, null).previewImport(snapshot, T2));
    assert.doesNotMatch(text, /\r|\n/u);
    assert.ok(text.length < JSON.stringify(store.exportSnapshot(), null, 2).length);
  });

  test("exportSnapshotText reuses the serialization captured by the last committed state", () => {
    const store = new AppStore(new MemoryStorage(), T0, null);
    store.update((draft) => draft.projects.push(createProject({ id: "p1", title: "Cached" }, T0)), T1);
    const nativeStringify = JSON.stringify;
    let stateSerializationAttempts = 0;
    JSON.stringify = (value, ...args) => {
      if (value === store.getState()) {
        stateSerializationAttempts += 1;
        throw new Error("current state must not be serialized again");
      }
      return nativeStringify(value, ...args);
    };
    let first;
    let second;
    try {
      first = store.exportSnapshotText(T2);
      second = store.exportSnapshotText(T2);
    } finally {
      JSON.stringify = nativeStringify;
    }

    assert.equal(stateSerializationAttempts, 0);
    assert.equal(first, second);
    assert.deepEqual(JSON.parse(first).data, store.getState());
  });

  test("a snapshot round trip preserves data while applying import revision semantics", () => {
    const source = new AppStore(new MemoryStorage(), T0);
    source.update((draft) => {
      draft.projects.push(createProject({ id: "p1", title: "Round trip" }, T0));
      draft.ui.selectedProjectId = "p1";
    }, T1);
    const snapshot = JSON.parse(JSON.stringify(source.exportSnapshot()));
    const target = new AppStore(new MemoryStorage(), T2);

    const imported = target.importSnapshot(snapshot, T2);

    assert.deepEqual(imported.projects, source.getState().projects);
    assert.deepEqual(imported.settings, source.getState().settings);
    assert.deepEqual(imported.ui, source.getState().ui);
    assert.equal(imported.meta.createdAt, source.getState().meta.createdAt);
    assert.equal(imported.meta.revision, source.getState().meta.revision + 1);
    assert.equal(imported.meta.updatedAt, new Date(T2).toISOString());
  });

  test("reset persists and emits a fresh monotonic state while backing up the old data", () => {
    const storage = new MemoryStorage();
    const store = new AppStore(storage, T0);
    store.update((draft) => draft.projects.push(createProject({ id: "p1" }, T0)), T1);
    const beforeReset = structuredClone(store.getState());
    let emitted;
    store.subscribe((state) => emitted = state);

    const result = store.reset(T2);

    assert.equal(result, undefined);
    assert.deepEqual(store.getState().projects, []);
    assert.equal(store.getState().meta.revision, beforeReset.meta.revision + 1);
    assert.equal(store.getState().meta.createdAt, new Date(T2).toISOString());
    assert.strictEqual(emitted, store.getState());
    assert.deepEqual(persisted(storage), store.getState());
    assert.deepEqual(persisted(storage, PREVIOUS_KEY), beforeReset);
  });
});
