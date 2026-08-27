import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { IMPORT_LIMITS, createCrumb, createProject } from "../src/core/model.js";
import {
  APP_VERSION,
  AppStore,
  MemoryStorage,
  STORAGE_KEY,
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
});

describe("AppStore loading and recovery", () => {
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

  test("mutating a previously emitted state cannot change an older state object", () => {
    const store = new AppStore(new MemoryStorage(), T0);
    const first = store.update((draft) => draft.projects.push(createProject({ id: "p1", title: "First" }, T0)), T1);
    const second = store.update((draft) => {
      draft.projects[0].title = "Second";
    }, T2);

    assert.equal(first.projects[0].title, "First");
    assert.equal(second.projects[0].title, "Second");
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
    assert.match(store.notices.at(-1), /外部修订号未前进/);
    assert.deepEqual(store.getState().projects.map((item) => item.id), ["current"]);
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

    const snapshot = store.exportSnapshot();

    assert.equal(snapshot.format, "reentry-deck-backup");
    assert.equal(snapshot.appVersion, APP_VERSION);
    assert.match(snapshot.checksum, /^fnv1a32:[0-9a-f]{8}$/u);
    assert.equal(Number.isFinite(Date.parse(snapshot.exportedAt)), true);
    assert.deepEqual(snapshot.data, store.getState());
    assert.notStrictEqual(snapshot.data, store.getState());
    assert.notStrictEqual(snapshot.data.projects, store.getState().projects);
    snapshot.data.projects[0].title = "Mutated snapshot";
    assert.equal(store.getState().projects[0].title, "Original");
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
