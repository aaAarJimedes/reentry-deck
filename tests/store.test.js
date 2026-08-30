import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { checksumSerializedSnapshotData } from "../src/core/import-preview.js";
import { IMPORT_LIMITS, createCrumb, createProject, createSession } from "../src/core/model.js";
import {
  APP_VERSION,
  AppStore,
  MemoryStorage,
  PREVIOUS_BINDING_FORMAT,
  PREVIOUS_BINDING_FORMAT_KEY,
  PREVIOUS_BINDING_KEY,
  STORAGE_KEY,
  STORE_NOTICE_LIMIT,
  WRITE_LOCK_KEY,
  inspectStorageUsage
} from "../src/core/store.js";

const PREVIOUS_KEY = `${STORAGE_KEY}/previous`;
const T0 = Date.parse("2026-08-28T00:00:00.000Z");
const T1 = Date.parse("2026-08-28T01:00:00.000Z");
const T2 = Date.parse("2026-08-28T02:00:00.000Z");

class MutationTrackingStorage extends MemoryStorage {
  mutations = [];

  setItem(key, value) {
    this.mutations.push(["set", key]);
    super.setItem(key, value);
  }

  removeItem(key) {
    this.mutations.push(["remove", key]);
    super.removeItem(key);
  }

  resetMutations() {
    this.mutations.length = 0;
  }
}

function persisted(storage, key = STORAGE_KEY) {
  const text = storage.getItem(key);
  return text === null ? null : JSON.parse(text);
}

function previousBindingEntry(primaryRaw, previousRaw) {
  return {
    primaryChecksum: checksumSerializedSnapshotData(primaryRaw),
    previousChecksum: previousRaw === "legacy"
      ? "legacy"
      : previousRaw === null
        ? null
        : checksumSerializedSnapshotData(previousRaw)
  };
}

function previousBindingRaw(primaryRaw, previousRaw, retainedEntries = []) {
  return JSON.stringify({
    entries: [...retainedEntries, previousBindingEntry(primaryRaw, previousRaw)]
  });
}

function setPreviousBinding(storage, primaryRaw, previousRaw, retainedEntries = []) {
  storage.setItem(PREVIOUS_BINDING_KEY, previousBindingRaw(primaryRaw, previousRaw, retainedEntries));
  storage.setItem(PREVIOUS_BINDING_FORMAT_KEY, PREVIOUS_BINDING_FORMAT);
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

  test("modern persistence remains writable by the strict v0.249 metadata contract", () => {
    const storage = new MemoryStorage();
    const store = new AppStore(storage, T0, null);
    store.update((draft) => draft.projects.push(createProject({ id: "p1", title: "First" }, T0)), T0);
    store.update((draft) => { draft.projects[0].title = "Modern"; }, T1);
    const modernRaw = storage.getItem(STORAGE_KEY);
    const legacyLoaded = JSON.parse(modernRaw);
    const legacyMetaFields = new Set(["createdAt", "updatedAt", "revision"]);

    for (const field of Object.keys(legacyLoaded.meta)) {
      assert.ok(legacyMetaFields.has(field), `v0.249 would reject meta.${field}`);
    }

    legacyLoaded.projects[0].title = "Legacy cached edit";
    legacyLoaded.meta.updatedAt = new Date(T2).toISOString();
    legacyLoaded.meta.revision += 1;
    storage.setItem(PREVIOUS_KEY, modernRaw);
    storage.setItem(STORAGE_KEY, JSON.stringify(legacyLoaded));
    const reloaded = new AppStore(storage, T2 + 1, null);

    assert.equal(reloaded.getState().projects[0].title, "Legacy cached edit");
    assert.equal(reloaded.hasPreviousSnapshot(T2 + 2), false, "an old writer's unmatched rollback stays fail-closed");
  });

  test("a marker without a usable ledger never turns ambiguous rollback data into recovery", () => {
    const previousRaw = JSON.stringify(stateWithProject("ambiguous-previous", "Ambiguous previous"));
    for (const primaryRaw of [
      JSON.stringify(stateWithProject("valid-primary", "Valid primary")),
      "{broken"
    ]) {
      const storage = new MemoryStorage();
      storage.setItem(STORAGE_KEY, primaryRaw);
      storage.setItem(PREVIOUS_KEY, previousRaw);
      storage.setItem(PREVIOUS_BINDING_FORMAT_KEY, PREVIOUS_BINDING_FORMAT);
      const store = new AppStore(storage, T1, null);

      if (primaryRaw === "{broken") assert.deepEqual(store.getState().projects, []);
      else assert.deepEqual(store.getState().projects.map((project) => project.id), ["valid-primary"]);
      assert.equal(store.hasPreviousSnapshot(T1 + 1_000), false);
    }
  });

  test("losing the modern format marker never downgrades a present ledger to legacy trust", () => {
    const storage = new MemoryStorage();
    const store = new AppStore(storage, T0, null);
    store.update((draft) => draft.projects.push(createProject({ id: "safe", title: "First" }, T0)), T0);
    store.update((draft) => { draft.projects[0].title = "Second"; }, T1);
    const unrelatedRaw = JSON.stringify(stateWithProject("unrelated", "Unrelated rollback"));
    storage.setItem(PREVIOUS_KEY, unrelatedRaw);
    storage.removeItem(PREVIOUS_BINDING_FORMAT_KEY);

    const reloaded = new AppStore(storage, T1 + 1_000, null);

    assert.equal(reloaded.hasPreviousSnapshot(T1 + 2_000), false);
    assert.throws(() => reloaded.restorePrevious(T1 + 3_000), /不属于当前工作区/u);

    storage.setItem(STORAGE_KEY, "{broken");
    const corruptReload = new AppStore(storage, T1 + 4_000, null);
    assert.deepEqual(corruptReload.getState().projects, []);
    assert.match(corruptReload.drainNotices().join("；"), /拒绝恢复/u);
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

  test("a parseable corrupt primary recovers only the rollback snapshot named by its checksum", () => {
    const safeRaw = JSON.stringify(stateWithProject("safe", "Safe"));
    const corrupt = stateWithProject("current", "Corrupt");
    corrupt.sessions.push({ id: "orphan", projectId: "missing", status: "completed" });
    const corruptRaw = JSON.stringify(corrupt);
    const storage = new MemoryStorage();
    storage.setItem(STORAGE_KEY, corruptRaw);
    storage.setItem(PREVIOUS_KEY, safeRaw);
    setPreviousBinding(storage, corruptRaw, safeRaw);

    const store = new AppStore(storage, T1, null);

    assert.deepEqual(store.getState().projects.map((project) => project.id), ["safe"]);
    assert.match(store.drainNotices().join("；"), /自动恢复/u);
    assert.equal(store.hasPreviousSnapshot(T1 + 1_000), false);
  });

  test("an empty-string primary is treated as corruption and recovers its bound snapshot", () => {
    const storage = new MemoryStorage();
    const original = new AppStore(storage, T0, null);
    original.update((draft) => draft.projects.push(createProject({ id: "safe", title: "First" }, T0)), T0);
    original.update((draft) => { draft.projects[0].title = "Second"; }, T1);
    storage.setItem(STORAGE_KEY, "");

    const recovered = new AppStore(storage, T1 + 1_000, null);

    assert.equal(recovered.getState().projects[0].title, "First");
    assert.match(recovered.drainNotices().join("；"), /自动恢复/u);
  });

  test("a successful repair save keeps the accepted startup recovery as its rollback", () => {
    const storage = new MemoryStorage();
    const original = new AppStore(storage, T0, null);
    original.update((draft) => draft.projects.push(createProject({ id: "safe", title: "First" }, T0)), T0);
    original.update((draft) => { draft.projects[0].title = "Second"; }, T1);
    storage.setItem(STORAGE_KEY, "{broken");
    const recovered = new AppStore(storage, T1 + 1_000, null);

    recovered.update((draft) => { draft.projects[0].title = "Repaired"; }, T2);

    assert.equal(recovered.hasPreviousSnapshot(T2 + 1_000), true);
    assert.equal(recovered.restorePrevious(T2 + 2_000).projects[0].title, "First");
  });

  test("an aborted repair save preserves the startup recovery proof for the next reload", () => {
    class FailedRepairStorage extends MemoryStorage {
      failPrimary = false;

      setItem(key, value) {
        if (this.failPrimary && key === STORAGE_KEY) {
          throw new Error("primary denied");
        }
        super.setItem(key, value);
      }
    }
    const storage = new FailedRepairStorage();
    const original = new AppStore(storage, T0, null);
    original.update((draft) => draft.projects.push(createProject({ id: "safe", title: "First" }, T0)), T0);
    original.update((draft) => { draft.projects[0].title = "Second"; }, T1);
    const acceptedRecoveryRaw = storage.getItem(PREVIOUS_KEY);
    storage.setItem(STORAGE_KEY, "{broken");
    const recovered = new AppStore(storage, T1 + 1_000, null);
    assert.equal(recovered.getState().projects[0].title, "First");
    storage.failPrimary = true;

    assert.throws(
      () => recovered.update((draft) => { draft.projects[0].title = "Repair attempt"; }, T2),
      /原数据仍然保留/u
    );

    assert.equal(storage.getItem(STORAGE_KEY), "{broken");
    assert.equal(storage.getItem(PREVIOUS_KEY), acceptedRecoveryRaw);
    const secondReload = new AppStore(storage, T2 + 1_000, null);
    assert.equal(secondReload.getState().projects[0].title, "First");
    assert.match(secondReload.drainNotices().join("；"), /自动恢复/u);
  });

  test("a startup repair never reclaims its only valid recovery snapshot for quota", () => {
    class RecoveryQuotaStorage extends MemoryStorage {
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
    const storage = new RecoveryQuotaStorage();
    const original = new AppStore(storage, T0, null);
    original.update((draft) => draft.projects.push(createProject({ id: "safe", title: "First" }, T0)), T0);
    original.update((draft) => { draft.projects[0].title = "Second"; }, T1);
    const acceptedRecoveryRaw = storage.getItem(PREVIOUS_KEY);
    storage.setItem(STORAGE_KEY, "{broken");
    const recovered = new AppStore(storage, T1 + 1_000, null);
    storage.quotaMode = true;

    assert.throws(
      () => recovered.update((draft) => { draft.projects[0].title = "Repair attempt"; }, T2),
      /唯一有效副本/u
    );

    assert.equal(storage.getItem(STORAGE_KEY), "{broken");
    assert.equal(storage.getItem(PREVIOUS_KEY), acceptedRecoveryRaw);
    storage.quotaMode = false;
    const secondReload = new AppStore(storage, T2 + 1_000, null);
    assert.equal(secondReload.getState().projects[0].title, "First");
    assert.match(secondReload.drainNotices().join("；"), /自动恢复/u);
  });

  test("an aborted final repair check keeps recovery mode active for an immediate quota retry", () => {
    class RevertedRepairStorage extends MemoryStorage {
      corruptRaw = null;
      revertDuringFinalBindingCheck = false;
      quotaMode = false;

      getItem(key) {
        if (this.revertDuringFinalBindingCheck
          && key === PREVIOUS_BINDING_KEY
          && super.getItem(STORAGE_KEY) !== this.corruptRaw) {
          this.revertDuringFinalBindingCheck = false;
          super.setItem(STORAGE_KEY, this.corruptRaw);
        }
        return super.getItem(key);
      }

      setItem(key, value) {
        if (this.quotaMode && key === STORAGE_KEY && this.getItem(PREVIOUS_KEY) !== null) {
          const error = new Error("storage full");
          error.name = "QuotaExceededError";
          throw error;
        }
        super.setItem(key, value);
      }
    }
    const storage = new RevertedRepairStorage();
    const original = new AppStore(storage, T0, null);
    original.update((draft) => draft.projects.push(createProject({ id: "safe", title: "First" }, T0)), T0);
    original.update((draft) => { draft.projects[0].title = "Second"; }, T1);
    const acceptedRecoveryRaw = storage.getItem(PREVIOUS_KEY);
    storage.corruptRaw = "{broken";
    storage.setItem(STORAGE_KEY, storage.corruptRaw);
    const recovered = new AppStore(storage, T1 + 1_000, null);
    storage.revertDuringFinalBindingCheck = true;

    assert.throws(
      () => recovered.update((draft) => { draft.projects[0].title = "First repair"; }, T2),
      /主数据未保留/u
    );

    storage.quotaMode = true;
    assert.throws(
      () => recovered.update((draft) => { draft.projects[0].title = "Quota retry"; }, T2 + 1_000),
      /唯一有效副本/u
    );
    assert.equal(storage.getItem(STORAGE_KEY), storage.corruptRaw);
    assert.equal(storage.getItem(PREVIOUS_KEY), acceptedRecoveryRaw);
    storage.quotaMode = false;
    const reloaded = new AppStore(storage, T2 + 2_000, null);
    assert.equal(reloaded.getState().projects[0].title, "First");
  });

  test("a repair displaced by corrupt data preserves the multiply endorsed recovery snapshot", () => {
    class DisplacedRepairStorage extends MemoryStorage {
      displaceRepair = false;

      setItem(key, value) {
        super.setItem(key, value);
        if (this.displaceRepair && key === STORAGE_KEY) {
          this.displaceRepair = false;
          super.setItem(STORAGE_KEY, "{worse");
        }
      }
    }
    const storage = new DisplacedRepairStorage();
    const original = new AppStore(storage, T0, null);
    original.update((draft) => draft.projects.push(createProject({ id: "safe", title: "First" }, T0)), T0);
    original.update((draft) => { draft.projects[0].title = "Second"; }, T1);
    const acceptedRecoveryRaw = storage.getItem(PREVIOUS_KEY);
    storage.setItem(STORAGE_KEY, "{broken");
    const recovered = new AppStore(storage, T1 + 1_000, null);
    storage.displaceRepair = true;

    assert.throws(
      () => recovered.update((draft) => { draft.projects[0].title = "Repair attempt"; }, T2),
      /主数据未保留/u
    );

    assert.equal(storage.getItem(STORAGE_KEY), "{worse");
    assert.equal(storage.getItem(PREVIOUS_KEY), acceptedRecoveryRaw);
    const secondReload = new AppStore(storage, T2 + 1_000, null);
    assert.equal(secondReload.getState().projects[0].title, "First");
    assert.match(secondReload.drainNotices().join("；"), /自动恢复/u);
  });

  test("a parseable corrupt primary rejects a rollback snapshot with the wrong checksum", () => {
    const intendedRaw = JSON.stringify(stateWithProject("intended", "Intended"));
    const corrupt = stateWithProject("current", "Corrupt");
    corrupt.sessions.push({ id: "orphan", projectId: "missing", status: "completed" });
    const corruptRaw = JSON.stringify(corrupt);
    const storage = new MemoryStorage();
    storage.setItem(STORAGE_KEY, corruptRaw);
    storage.setItem(PREVIOUS_KEY, JSON.stringify(stateWithProject("stale", "Stale")));
    setPreviousBinding(storage, corruptRaw, intendedRaw);

    const store = new AppStore(storage, T1, null);

    assert.deepEqual(store.getState().projects, []);
    assert.match(store.drainNotices().join("；"), /校验标记.*拒绝恢复/u);
    assert.equal(store.hasPreviousSnapshot(T1 + 1_000), false);
  });

  test("a bound but damaged rollback snapshot reports content failure instead of provenance failure", () => {
    const corrupt = stateWithProject("current", "Corrupt");
    corrupt.sessions.push({ id: "orphan", projectId: "missing", status: "completed" });
    const corruptRaw = JSON.stringify(corrupt);
    const storage = new MemoryStorage();
    storage.setItem(STORAGE_KEY, corruptRaw);
    storage.setItem(PREVIOUS_KEY, "{broken");
    setPreviousBinding(storage, corruptRaw, "{broken");

    const store = new AppStore(storage, T1, null);
    const notices = store.drainNotices().join("；");

    assert.deepEqual(store.getState().projects, []);
    assert.match(notices, /来源标记已通过.*内容损坏或结构无效/u);
    assert.doesNotMatch(notices, /未受.*校验标记信任/u);
  });

  test("a later valid primary restores normal snapshot rotation after startup recovery", () => {
    for (const sameContent of [true, false]) {
      const recoveredRaw = JSON.stringify(stateWithProject("recovered", "Recovered"));
      const corrupt = stateWithProject("current", "Corrupt");
      corrupt.sessions.push({ id: "orphan", projectId: "missing", status: "completed" });
      const corruptRaw = JSON.stringify(corrupt);
      const storage = new MemoryStorage();
      storage.setItem(STORAGE_KEY, corruptRaw);
      storage.setItem(PREVIOUS_KEY, recoveredRaw);
      setPreviousBinding(storage, corruptRaw, recoveredRaw);
      const store = new AppStore(storage, T1, null);
      store.drainNotices();
      const external = sameContent
        ? JSON.parse(recoveredRaw)
        : stateWithProject("external", "External");
      if (!sameContent) {
        external.meta.revision = 5;
        external.meta.updatedAt = new Date(T1).toISOString();
      }
      const externalRaw = JSON.stringify(external);
      setPreviousBinding(storage, externalRaw, null);
      storage.setItem(STORAGE_KEY, externalRaw);

      assert.equal(store.refreshFromStorage(T1 + 1_000), !sameContent);
      const saved = store.update((draft) => { draft.settings.staleAfterDays = 21; }, T2);

      assert.equal(storage.getItem(PREVIOUS_KEY), externalRaw);
      assert.equal(store.hasPreviousSnapshot(T2 + 500), true);
      const restored = store.restorePrevious(T2 + 1_000);
      assert.deepEqual(restored.projects.map((project) => project.id), [sameContent ? "recovered" : "external"]);
      assert.equal(restored.settings.staleAfterDays, 7);
    }
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
    assert.match(store.notices[0], /旧格式兼容候选.*内容损坏或结构无效/u);
    assert.doesNotMatch(store.notices[0], /来源标记已通过/u);
    assert.equal(storage.getItem(STORAGE_KEY), "not-json");
  });

  test("does not expose an orphaned previous value when no primary workspace exists", () => {
    const storage = new MemoryStorage();
    storage.setItem(PREVIOUS_KEY, JSON.stringify(stateWithProject("previous")));

    const store = new AppStore(storage, T1);

    assert.deepEqual(store.getState().projects, []);
    assert.equal(store.hasPreviousSnapshot(T1 + 1_000), false);
    assert.deepEqual(store.notices, []);
    const saved = store.update((draft) => draft.projects.push(createProject({ id: "new" }, T1)), T1 + 2_000);
    assert.equal(Object.prototype.hasOwnProperty.call(saved.meta, "previousChecksum"), false);
    assert.equal(store.hasPreviousSnapshot(T1 + 3_000), false);
    const reloaded = new AppStore(storage, T1 + 4_000, null);
    assert.deepEqual(reloaded.getState().projects.map((project) => project.id), ["new"]);
    assert.equal(reloaded.hasPreviousSnapshot(T1 + 5_000), false);
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

  test("an incompatible session closure update fails before revision, storage, snapshot, lock, or emission changes", () => {
    const storage = new MutationTrackingStorage();
    const store = new AppStore(storage, T0, null);
    store.update((draft) => {
      draft.projects.push(createProject({ id: "p1" }, T0));
      draft.sessions.push(createSession({ id: "s1", projectId: "p1" }, T0));
    }, T0);
    store.update((draft) => { draft.projects[0].title = "Seeded snapshot"; }, T0);
    const beforeState = store.getState();
    const beforeRevision = beforeState.meta.revision;
    const beforeCurrent = storage.getItem(STORAGE_KEY);
    const beforePrevious = storage.getItem(PREVIOUS_KEY);
    let emissions = 0;
    store.subscribe(() => emissions += 1);
    storage.resetMutations();

    assert.throws(
      () => store.update((draft) => { draft.sessions[0].closeReason = "checkpoint"; }, T1),
      /会话状态与关闭原因不匹配：s1/u
    );

    assert.strictEqual(store.getState(), beforeState);
    assert.equal(store.getState().meta.revision, beforeRevision);
    assert.equal(storage.getItem(STORAGE_KEY), beforeCurrent);
    assert.equal(storage.getItem(PREVIOUS_KEY), beforePrevious);
    assert.equal(storage.getItem(WRITE_LOCK_KEY), null);
    assert.deepEqual(storage.mutations, []);
    assert.equal(emissions, 0);
  });

  test("legacy closed sessions without a reason remain loadable, writable, and uninferred", () => {
    const storage = new MemoryStorage();
    const legacy = stateWithProject("p1", "Legacy");
    legacy.sessions.push(
      {
        id: "completed-legacy",
        projectId: "p1",
        intention: "",
        status: "completed",
        startedAt: new Date(T0).toISOString(),
        endedAt: new Date(T0).toISOString(),
        checkpointId: null,
        sourceCheckpointId: null
      },
      {
        id: "abandoned-legacy",
        projectId: "p1",
        intention: "",
        status: "abandoned",
        startedAt: new Date(T0).toISOString(),
        endedAt: new Date(T0).toISOString(),
        checkpointId: null,
        sourceCheckpointId: null,
        closeReason: null
      }
    );
    storage.setItem(STORAGE_KEY, JSON.stringify(legacy));

    const store = new AppStore(storage, T0, null);

    assert.deepEqual(store.getState().sessions.map((session) => session.closeReason), [null, null]);
    assert.deepEqual(store.drainNotices(), []);
    store.update((draft) => { draft.settings.reducedMotion = true; }, T1);
    assert.deepEqual(persisted(storage).sessions.map((session) => session.closeReason), [null, null]);
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

  test("a pending sidecar preserves the current rollback relationship when primary writing fails", () => {
    class FailedPrimaryStorage extends MemoryStorage {
      failPrimary = false;

      setItem(key, value) {
        if (this.failPrimary && key === STORAGE_KEY) throw new Error("primary denied");
        super.setItem(key, value);
      }
    }
    const storage = new FailedPrimaryStorage();
    const store = new AppStore(storage, T0, null);
    store.update((draft) => draft.projects.push(createProject({ id: "p1", title: "First" }, T0)), T0);
    store.update((draft) => { draft.projects[0].title = "Second"; }, T1);
    const beforePrimary = storage.getItem(STORAGE_KEY);
    const beforePrevious = storage.getItem(PREVIOUS_KEY);
    storage.failPrimary = true;

    assert.throws(
      () => store.update((draft) => { draft.projects[0].title = "Rejected third"; }, T2),
      /原数据仍然保留：primary denied/u
    );

    assert.equal(storage.getItem(STORAGE_KEY), beforePrimary);
    assert.equal(storage.getItem(PREVIOUS_KEY), beforePrevious);
    storage.failPrimary = false;
    const reloaded = new AppStore(storage, T2 + 1_000, null);
    assert.equal(reloaded.getState().projects[0].title, "Second");
    assert.equal(reloaded.hasPreviousSnapshot(T2 + 2_000), true);
    assert.equal(reloaded.restorePrevious(T2 + 3_000).projects[0].title, "First");
  });

  test("a transient provenance read failure aborts before erasing a valid rollback proof", () => {
    class ProvenanceReadFailureStorage extends MemoryStorage {
      failFormatRead = false;
      failPrimary = false;
      primaryAttempts = 0;

      getItem(key) {
        if (this.failFormatRead && key === PREVIOUS_BINDING_FORMAT_KEY) {
          this.failFormatRead = false;
          throw new Error("sidecar read denied");
        }
        return super.getItem(key);
      }

      setItem(key, value) {
        if (this.failPrimary && key === STORAGE_KEY) {
          this.primaryAttempts += 1;
          throw new Error("primary denied");
        }
        super.setItem(key, value);
      }
    }
    const storage = new ProvenanceReadFailureStorage();
    const store = new AppStore(storage, T0, null);
    store.update((draft) => draft.projects.push(createProject({ id: "safe", title: "First" }, T0)), T0);
    store.update((draft) => { draft.projects[0].title = "Second"; }, T1);
    const beforePrimary = storage.getItem(STORAGE_KEY);
    const beforePrevious = storage.getItem(PREVIOUS_KEY);
    const beforeBinding = storage.getItem(PREVIOUS_BINDING_KEY);
    storage.failFormatRead = true;
    storage.failPrimary = true;

    assert.throws(
      () => store.update((draft) => { draft.projects[0].title = "Must not publish"; }, T2),
      /无法读取滚动撤销快照的来源记录/u
    );

    assert.equal(storage.primaryAttempts, 0);
    assert.equal(storage.getItem(STORAGE_KEY), beforePrimary);
    assert.equal(storage.getItem(PREVIOUS_KEY), beforePrevious);
    assert.equal(storage.getItem(PREVIOUS_BINDING_KEY), beforeBinding);
    storage.failPrimary = false;
    const reloaded = new AppStore(storage, T2 + 1_000, null);
    assert.equal(reloaded.hasPreviousSnapshot(T2 + 2_000), true);
    assert.equal(reloaded.restorePrevious(T2 + 3_000).projects[0].title, "First");
  });

  test("an aborted first sidecar migration preserves legacy rollback semantics", () => {
    class FailedMigrationStorage extends MemoryStorage {
      failPrimary = false;

      setItem(key, value) {
        if (this.failPrimary && key === STORAGE_KEY) throw new Error("migration denied");
        super.setItem(key, value);
      }
    }
    const storage = new FailedMigrationStorage();
    const currentRaw = JSON.stringify(stateWithProject("current", "Legacy current"));
    const previousRaw = JSON.stringify(stateWithProject("previous", "Legacy previous"));
    storage.setItem(STORAGE_KEY, currentRaw);
    storage.setItem(PREVIOUS_KEY, previousRaw);
    const store = new AppStore(storage, T0, null);
    assert.equal(store.hasPreviousSnapshot(T0 + 1), true);
    storage.failPrimary = true;

    assert.throws(
      () => store.update((draft) => { draft.projects[0].title = "Rejected migration"; }, T1),
      /原数据仍然保留：migration denied/u
    );

    storage.failPrimary = false;
    const reloaded = new AppStore(storage, T1 + 1_000, null);
    assert.equal(reloaded.getState().projects[0].title, "Legacy current");
    assert.equal(reloaded.hasPreviousSnapshot(T1 + 2_000), true);
    assert.equal(reloaded.restorePrevious(T1 + 3_000).projects[0].title, "Legacy previous");
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
      externalBindingRaw = null;
      replaceDuringSnapshot = false;

      setItem(key, value) {
        super.setItem(key, value);
        if (key === PREVIOUS_KEY && this.replaceDuringSnapshot) {
          this.replaceDuringSnapshot = false;
          super.setItem(PREVIOUS_BINDING_KEY, this.externalBindingRaw);
          super.setItem(PREVIOUS_BINDING_FORMAT_KEY, PREVIOUS_BINDING_FORMAT);
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
    storage.externalBindingRaw = previousBindingRaw(storage.externalRaw, null);
    storage.replaceDuringSnapshot = true;

    assert.throws(
      () => store.update((draft) => { draft.projects[0].title = "Must not publish"; }, T1),
      /保存完成时替换了数据/u
    );

    assert.deepEqual(store.getState().projects.map((project) => project.id), ["snapshot-winner"]);
    assert.deepEqual(persisted(storage).projects.map((project) => project.id), ["snapshot-winner"]);
    assert.equal(storage.getItem(PREVIOUS_KEY), null);
    assert.equal(store.hasPreviousSnapshot(T1 + 1_000), false);
    const reloadedBeforeRetry = new AppStore(storage, T1 + 1_500, null);
    assert.equal(reloadedBeforeRetry.hasPreviousSnapshot(T1 + 1_600), false);
    const saved = store.update((draft) => { draft.projects[0].title = "Winner updated"; }, T1 + 2_000);
    assert.equal(saved.projects[0].title, "Winner updated");
    assert.equal(store.hasPreviousSnapshot(T1 + 3_000), true);
    const restored = store.restorePrevious(T1 + 4_000);
    assert.equal(restored.projects[0].title, "Snapshot winner");
    assert.equal(storage.getItem(WRITE_LOCK_KEY), null);
  });

  test("a final provenance check cannot hide a primary replacement", () => {
    class BindingVerificationInterleavingStorage extends MemoryStorage {
      arm = false;
      afterPrimary = false;
      externalRaw = null;

      setItem(key, value) {
        super.setItem(key, value);
        if (this.arm && key === STORAGE_KEY) this.afterPrimary = true;
      }

      getItem(key) {
        const value = super.getItem(key);
        if (this.afterPrimary && key === PREVIOUS_BINDING_KEY) {
          this.afterPrimary = false;
          super.setItem(STORAGE_KEY, this.externalRaw);
        }
        return value;
      }
    }
    const storage = new BindingVerificationInterleavingStorage();
    const store = new AppStore(storage, T0, null);
    store.update((draft) => draft.projects.push(createProject({ id: "local", title: "First" }, T0)), T0);
    const external = stateWithProject("binding-winner", "External winner");
    external.meta.revision = 3;
    external.meta.updatedAt = new Date(T2).toISOString();
    storage.externalRaw = JSON.stringify(external);
    storage.arm = true;

    assert.throws(
      () => store.update((draft) => { draft.projects[0].title = "Local reported success"; }, T1),
      /保存完成时替换了数据/u
    );

    assert.deepEqual(store.getState().projects.map((project) => project.id), ["binding-winner"]);
    assert.deepEqual(persisted(storage).projects.map((project) => project.id), ["binding-winner"]);
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
      const expiredToken = JSON.parse(storage.getItem(WRITE_LOCK_KEY));
      assert.ok(expiredToken.expiresAt <= 7_000, "an expired owner is left for safe takeover instead of risky deletion");
      assert.deepEqual(store.getState().projects, []);
    } finally {
      Date.now = originalNow;
    }

    const retried = store.update((draft) => draft.projects.push(createProject({ id: "after-expiry" }, T2)), T2);
    assert.deepEqual(retried.projects.map((project) => project.id), ["after-expiry"]);
    assert.equal(storage.getItem(WRITE_LOCK_KEY), null);
  });

  test("releasing an expired owner never deletes a competitor installed during the final lock read", () => {
    const originalNow = Date.now;
    let fakeNow = 1_000;
    class ReleaseReadRaceStorage extends MemoryStorage {
      failPrimaryRead = false;
      armRelease = false;
      competitorToken = null;

      getItem(key) {
        if (this.failPrimaryRead && key === STORAGE_KEY) {
          this.failPrimaryRead = false;
          this.armRelease = true;
          throw new Error("primary read denied");
        }
        const value = super.getItem(key);
        if (this.armRelease && key === WRITE_LOCK_KEY) {
          this.armRelease = false;
          fakeNow += 6_000;
          this.competitorToken = JSON.stringify({ owner: "competitor", expiresAt: fakeNow + 5_000 });
          super.setItem(WRITE_LOCK_KEY, this.competitorToken);
          return value;
        }
        return value;
      }
    }
    const storage = new ReleaseReadRaceStorage();
    const store = new AppStore(storage, T0, null);
    storage.failPrimaryRead = true;
    Date.now = () => fakeNow;
    try {
      assert.throws(
        () => store.update((draft) => draft.projects.push(createProject({ id: "blocked" }, T1)), T1),
        /无法核对现有数据.*primary read denied/u
      );
      assert.equal(storage.getItem(WRITE_LOCK_KEY), storage.competitorToken);
      assert.equal(storage.getItem(STORAGE_KEY), null);
    } finally {
      Date.now = originalNow;
    }
  });

  test("a committed same-owner lease renewal that reports failure remains recoverable", () => {
    const originalNow = Date.now;
    let fakeNow = 8_000_000;
    class CommittedRenewalFailureStorage extends MemoryStorage {
      quotaMode = false;
      lockSets = 0;

      setItem(key, value) {
        if (this.quotaMode && key === STORAGE_KEY) {
          const error = new Error("full");
          error.name = "QuotaExceededError";
          throw error;
        }
        super.setItem(key, value);
        if (this.quotaMode && key === WRITE_LOCK_KEY) {
          this.lockSets += 1;
          if (this.lockSets === 7) throw new Error("renew committed then threw");
        }
      }
    }
    const storage = new CommittedRenewalFailureStorage();
    const store = new AppStore(storage, T0, null);
    store.update((draft) => draft.projects.push(createProject({ id: "p1", title: "First" }, T0)), T0);
    store.update((draft) => { draft.projects[0].title = "Second"; }, T1);
    const primaryBefore = storage.getItem(STORAGE_KEY);
    const previousBefore = storage.getItem(PREVIOUS_KEY);
    const bindingBefore = storage.getItem(PREVIOUS_BINDING_KEY);
    storage.quotaMode = true;
    Date.now = () => fakeNow++;
    try {
      assert.throws(
        () => store.update((draft) => { draft.projects[0].title = "No commit"; }, T2),
        /原数据仍然保留/u
      );
      assert.ok(storage.lockSets > 7, "recovery continues with the committed same-owner renewal");
      assert.equal(storage.getItem(STORAGE_KEY), primaryBefore);
      assert.equal(storage.getItem(PREVIOUS_KEY), previousBefore);
      assert.equal(storage.getItem(PREVIOUS_BINDING_KEY), bindingBefore);
      assert.equal(storage.getItem(PREVIOUS_BINDING_FORMAT_KEY), PREVIOUS_BINDING_FORMAT);
      assert.equal(storage.getItem(WRITE_LOCK_KEY), null);
    } finally {
      Date.now = originalNow;
      storage.quotaMode = false;
    }

    const reloaded = new AppStore(storage, T2 + 1_000, null);
    assert.equal(reloaded.getState().projects[0].title, "Second");
    assert.equal(reloaded.hasPreviousSnapshot(T2 + 2_000), true);
    assert.equal(reloaded.restorePrevious(T2 + 3_000).projects[0].title, "First");
  });

  test("a renewal that completes after its lease expires reacquires before recovery", () => {
    const originalNow = Date.now;
    for (const throwsAfterCommit of [false, true]) {
      let fakeNow = 8_250_000;
      class StalledRenewalStorage extends MemoryStorage {
        quotaMode = false;
        lockSets = 0;

        setItem(key, value) {
          if (this.quotaMode && key === STORAGE_KEY) {
            const error = new Error("full");
            error.name = "QuotaExceededError";
            throw error;
          }
          super.setItem(key, value);
          if (this.quotaMode && key === WRITE_LOCK_KEY) {
            this.lockSets += 1;
            if (this.lockSets === 7) {
              fakeNow += 6_000;
              if (throwsAfterCommit) throw new Error("stalled renewal committed then threw");
            }
          }
        }
      }
      const storage = new StalledRenewalStorage();
      const store = new AppStore(storage, T0, null);
      store.update((draft) => draft.projects.push(createProject({ id: "p1", title: "First" }, T0)), T0);
      store.update((draft) => { draft.projects[0].title = "Second"; }, T1);
      const primaryBefore = storage.getItem(STORAGE_KEY);
      const previousBefore = storage.getItem(PREVIOUS_KEY);
      const bindingBefore = storage.getItem(PREVIOUS_BINDING_KEY);
      storage.quotaMode = true;
      Date.now = () => fakeNow;
      try {
        assert.throws(
          () => store.update((draft) => { draft.projects[0].title = "No commit"; }, T2),
          /原数据仍然保留/u,
          `throwsAfterCommit=${throwsAfterCommit}`
        );
        assert.ok(storage.lockSets > 7, `recovery reacquires after the stalled token (${throwsAfterCommit})`);
        assert.equal(storage.getItem(STORAGE_KEY), primaryBefore, String(throwsAfterCommit));
        assert.equal(storage.getItem(PREVIOUS_KEY), previousBefore, String(throwsAfterCommit));
        assert.equal(storage.getItem(PREVIOUS_BINDING_KEY), bindingBefore, String(throwsAfterCommit));
        assert.equal(storage.getItem(PREVIOUS_BINDING_FORMAT_KEY), PREVIOUS_BINDING_FORMAT, String(throwsAfterCommit));
        assert.equal(storage.getItem(WRITE_LOCK_KEY), null, String(throwsAfterCommit));
      } finally {
        Date.now = originalNow;
        storage.quotaMode = false;
      }

      const reloaded = new AppStore(storage, T2 + 1_000, null);
      assert.equal(reloaded.hasPreviousSnapshot(T2 + 2_000), true, String(throwsAfterCommit));
      assert.equal(reloaded.restorePrevious(T2 + 3_000).projects[0].title, "First", String(throwsAfterCommit));
    }
  });

  test("a committed fallback recovery lease that reports failure restores a removed rollback", () => {
    const originalNow = Date.now;
    let fakeNow = 8_500_000;
    class CommittedFallbackRecoveryStorage extends MemoryStorage {
      quotaMode = false;
      advanceOnRemoval = false;
      throwAfterRecoveryLease = false;

      setItem(key, value) {
        if (this.quotaMode && key === STORAGE_KEY) {
          const error = new Error("still full");
          error.name = "QuotaExceededError";
          throw error;
        }
        super.setItem(key, value);
        if (this.throwAfterRecoveryLease && key === WRITE_LOCK_KEY) {
          this.throwAfterRecoveryLease = false;
          throw new Error("fallback recovery lease committed then threw");
        }
      }

      removeItem(key) {
        super.removeItem(key);
        if (this.advanceOnRemoval && key === PREVIOUS_KEY) {
          this.advanceOnRemoval = false;
          fakeNow += 4_600;
          this.throwAfterRecoveryLease = true;
        }
      }
    }
    const storage = new CommittedFallbackRecoveryStorage();
    const store = new AppStore(storage, T0, null);
    store.update((draft) => draft.projects.push(createProject({ id: "p1", title: "First" }, T0)), T0);
    store.update((draft) => { draft.projects[0].title = "Second"; }, T1);
    const primaryBefore = storage.getItem(STORAGE_KEY);
    const previousBefore = storage.getItem(PREVIOUS_KEY);
    const bindingBefore = storage.getItem(PREVIOUS_BINDING_KEY);
    storage.quotaMode = true;
    storage.advanceOnRemoval = true;
    Date.now = () => fakeNow;
    try {
      assert.throws(
        () => store.update((draft) => { draft.projects[0].title = "No commit"; }, T2),
        /原数据仍然保留/u
      );
      assert.equal(storage.throwAfterRecoveryLease, false, "the fallback recovery write reports its committed failure");
      assert.equal(storage.getItem(STORAGE_KEY), primaryBefore);
      assert.equal(storage.getItem(PREVIOUS_KEY), previousBefore);
      assert.equal(storage.getItem(PREVIOUS_BINDING_KEY), bindingBefore);
      assert.equal(storage.getItem(PREVIOUS_BINDING_FORMAT_KEY), PREVIOUS_BINDING_FORMAT);
      assert.equal(storage.getItem(WRITE_LOCK_KEY), null);
    } finally {
      Date.now = originalNow;
      storage.quotaMode = false;
    }

    const reloaded = new AppStore(storage, T2 + 1_000, null);
    assert.equal(reloaded.hasPreviousSnapshot(T2 + 2_000), true);
    assert.equal(reloaded.restorePrevious(T2 + 3_000).projects[0].title, "First");
  });

  test("an expired fallback recovery token is retried once with a fresh clock", () => {
    const originalNow = Date.now;
    for (const throwsAfterCommit of [false, true]) {
      let fakeNow = 8_750_000;
      class StalledFallbackRecoveryStorage extends MemoryStorage {
        quotaMode = false;
        advanceOnRemoval = false;
        stallFallbackLease = false;

        setItem(key, value) {
          if (this.quotaMode && key === STORAGE_KEY) {
            const error = new Error("still full");
            error.name = "QuotaExceededError";
            throw error;
          }
          super.setItem(key, value);
          if (this.stallFallbackLease && key === WRITE_LOCK_KEY) {
            this.stallFallbackLease = false;
            fakeNow += 6_000;
            if (throwsAfterCommit) throw new Error("fallback token expired after commit");
          }
        }

        removeItem(key) {
          super.removeItem(key);
          if (this.advanceOnRemoval && key === PREVIOUS_KEY) {
            this.advanceOnRemoval = false;
            fakeNow += 4_600;
            this.stallFallbackLease = true;
          }
        }
      }
      const storage = new StalledFallbackRecoveryStorage();
      const store = new AppStore(storage, T0, null);
      store.update((draft) => draft.projects.push(createProject({ id: "p1", title: "First" }, T0)), T0);
      store.update((draft) => { draft.projects[0].title = "Second"; }, T1);
      const primaryBefore = storage.getItem(STORAGE_KEY);
      const previousBefore = storage.getItem(PREVIOUS_KEY);
      const bindingBefore = storage.getItem(PREVIOUS_BINDING_KEY);
      storage.quotaMode = true;
      storage.advanceOnRemoval = true;
      Date.now = () => fakeNow;
      try {
        assert.throws(
          () => store.update((draft) => { draft.projects[0].title = "No commit"; }, T2),
          /原数据仍然保留/u,
          `throwsAfterCommit=${throwsAfterCommit}`
        );
        assert.equal(storage.stallFallbackLease, false, String(throwsAfterCommit));
        assert.equal(storage.getItem(STORAGE_KEY), primaryBefore, String(throwsAfterCommit));
        assert.equal(storage.getItem(PREVIOUS_KEY), previousBefore, String(throwsAfterCommit));
        assert.equal(storage.getItem(PREVIOUS_BINDING_KEY), bindingBefore, String(throwsAfterCommit));
        assert.equal(storage.getItem(PREVIOUS_BINDING_FORMAT_KEY), PREVIOUS_BINDING_FORMAT, String(throwsAfterCommit));
        assert.equal(storage.getItem(WRITE_LOCK_KEY), null, String(throwsAfterCommit));
      } finally {
        Date.now = originalNow;
        storage.quotaMode = false;
      }

      const reloaded = new AppStore(storage, T2 + 1_000, null);
      assert.equal(reloaded.hasPreviousSnapshot(T2 + 2_000), true, String(throwsAfterCommit));
      assert.equal(reloaded.restorePrevious(T2 + 3_000).projects[0].title, "First", String(throwsAfterCommit));
    }
  });

  test("same-owner recovery adoption refreshes the clock after a delayed lock read", () => {
    const originalNow = Date.now;
    let fakeNow = 8_900_000;
    class DelayedSameOwnerReadStorage extends MemoryStorage {
      quotaMode = false;
      armLockReads = false;
      lockReads = 0;

      setItem(key, value) {
        if (this.quotaMode && key === STORAGE_KEY) {
          const error = new Error("still full");
          error.name = "QuotaExceededError";
          throw error;
        }
        super.setItem(key, value);
      }

      removeItem(key) {
        super.removeItem(key);
        if (this.quotaMode && key === PREVIOUS_KEY) this.armLockReads = true;
      }

      getItem(key) {
        if (this.armLockReads && key === WRITE_LOCK_KEY) {
          this.lockReads += 1;
          if (this.lockReads <= 2) throw new Error("transient lock read");
          const value = super.getItem(key);
          fakeNow += 6_000;
          this.armLockReads = false;
          return value;
        }
        return super.getItem(key);
      }
    }
    const storage = new DelayedSameOwnerReadStorage();
    const store = new AppStore(storage, T0, null);
    store.update((draft) => draft.projects.push(createProject({ id: "p1", title: "First" }, T0)), T0);
    store.update((draft) => { draft.projects[0].title = "Second"; }, T1);
    const primaryBefore = storage.getItem(STORAGE_KEY);
    const previousBefore = storage.getItem(PREVIOUS_KEY);
    const bindingBefore = storage.getItem(PREVIOUS_BINDING_KEY);
    storage.quotaMode = true;
    Date.now = () => fakeNow;
    try {
      assert.throws(
        () => store.update((draft) => { draft.projects[0].title = "No commit"; }, T2),
        /本地保存失败，原数据仍然保留/u
      );
      assert.equal(storage.lockReads, 3);
      assert.equal(storage.getItem(STORAGE_KEY), primaryBefore);
      assert.equal(storage.getItem(PREVIOUS_KEY), previousBefore);
      assert.equal(storage.getItem(PREVIOUS_BINDING_KEY), bindingBefore);
      assert.equal(storage.getItem(PREVIOUS_BINDING_FORMAT_KEY), PREVIOUS_BINDING_FORMAT);
      assert.equal(storage.getItem(WRITE_LOCK_KEY), null);
    } finally {
      Date.now = originalNow;
      storage.quotaMode = false;
    }

    const reloaded = new AppStore(storage, T2 + 1_000, null);
    assert.equal(reloaded.hasPreviousSnapshot(T2 + 2_000), true);
    assert.equal(reloaded.restorePrevious(T2 + 3_000).projects[0].title, "First");
  });

  test("post-commit snapshot cleanup reacquires after its removal outlasts the lease", () => {
    const originalNow = Date.now;
    for (const { advanceBy, throwsAfterCommit } of [
      { advanceBy: 4_600, throwsAfterCommit: false },
      { advanceBy: 6_000, throwsAfterCommit: false },
      { advanceBy: 6_000, throwsAfterCommit: true }
    ]) {
      let fakeNow = 9_000_000;
      class ExpiredCleanupRemovalStorage extends MemoryStorage {
        failSnapshotWrite = false;
        armRemoval = false;

        setItem(key, value) {
          if (this.failSnapshotWrite && key === PREVIOUS_KEY) {
            this.failSnapshotWrite = false;
            this.armRemoval = true;
            throw new Error("snapshot denied");
          }
          super.setItem(key, value);
        }

        removeItem(key) {
          super.removeItem(key);
          if (this.armRemoval && key === PREVIOUS_KEY) {
            this.armRemoval = false;
            fakeNow += advanceBy;
            if (throwsAfterCommit) throw new Error("cleanup removal committed then threw");
          }
        }
      }
      const storage = new ExpiredCleanupRemovalStorage();
      const store = new AppStore(storage, T0, null);
      store.update((draft) => draft.projects.push(createProject({ id: "p1", title: "First" }, T0)), T0);
      store.update((draft) => { draft.projects[0].title = "Second"; }, T1);
      const previousExpected = storage.getItem(STORAGE_KEY);
      storage.failSnapshotWrite = true;
      Date.now = () => fakeNow;
      try {
        const saved = store.update((draft) => { draft.projects[0].title = "Third"; }, T2);
        assert.equal(saved.projects[0].title, "Third", `${advanceBy}/${throwsAfterCommit}`);
        assert.equal(storage.getItem(PREVIOUS_KEY), previousExpected, `${advanceBy}/${throwsAfterCommit}`);
        assert.equal(storage.getItem(PREVIOUS_BINDING_FORMAT_KEY), PREVIOUS_BINDING_FORMAT);
        assert.notEqual(storage.getItem(PREVIOUS_BINDING_KEY), null);
        assert.equal(store.hasPreviousSnapshot(T2 + 1), true, `${advanceBy}/${throwsAfterCommit}`);
        assert.equal(storage.getItem(WRITE_LOCK_KEY), null, `${advanceBy}/${throwsAfterCommit}`);
      } finally {
        Date.now = originalNow;
      }

      const reloaded = new AppStore(storage, T2 + 1_000, null);
      assert.equal(reloaded.hasPreviousSnapshot(T2 + 2_000), true, `${advanceBy}/${throwsAfterCommit}`);
      assert.equal(reloaded.restorePrevious(T2 + 3_000).projects[0].title, "Second");
    }
  });

  test("slow successful primary and rollback writes remain locally undoable", () => {
    const originalNow = Date.now;
    for (const { keyToStall, advanceBy, throwsAfterCommit } of [
      { keyToStall: STORAGE_KEY, advanceBy: 4_600, throwsAfterCommit: false },
      { keyToStall: STORAGE_KEY, advanceBy: 6_000, throwsAfterCommit: false },
      { keyToStall: PREVIOUS_KEY, advanceBy: 4_600, throwsAfterCommit: false },
      { keyToStall: PREVIOUS_KEY, advanceBy: 6_000, throwsAfterCommit: false },
      { keyToStall: PREVIOUS_KEY, advanceBy: 6_000, throwsAfterCommit: true }
    ]) {
      let fakeNow = 9_500_000;
      class SlowCommittedWriteStorage extends MemoryStorage {
        armedKey = null;
        stalled = false;

        setItem(key, value) {
          super.setItem(key, value);
          if (!this.stalled && key === this.armedKey) {
            this.stalled = true;
            fakeNow += advanceBy;
            if (throwsAfterCommit) throw new Error("slow storage write committed then threw");
          }
        }
      }
      const storage = new SlowCommittedWriteStorage();
      const store = new AppStore(storage, T0, null);
      store.update((draft) => draft.projects.push(createProject({ id: "p1", title: "First" }, T0)), T0);
      store.update((draft) => { draft.projects[0].title = "Second"; }, T1);
      const previousExpected = storage.getItem(STORAGE_KEY);
      storage.armedKey = keyToStall;
      Date.now = () => fakeNow;
      try {
        const saved = store.update((draft) => { draft.projects[0].title = "Third"; }, T2);
        assert.equal(saved.projects[0].title, "Third", `${keyToStall}/${advanceBy}/${throwsAfterCommit}`);
        assert.equal(storage.getItem(PREVIOUS_KEY), previousExpected, `${keyToStall}/${advanceBy}/${throwsAfterCommit}`);
        assert.equal(store.hasPreviousSnapshot(T2 + 1), true, `${keyToStall}/${advanceBy}/${throwsAfterCommit}`);
        assert.equal(storage.getItem(WRITE_LOCK_KEY), null, `${keyToStall}/${advanceBy}/${throwsAfterCommit}`);
      } finally {
        Date.now = originalNow;
      }

      const reloaded = new AppStore(storage, T2 + 1_000, null);
      assert.equal(reloaded.hasPreviousSnapshot(T2 + 2_000), true, `${keyToStall}/${advanceBy}/${throwsAfterCommit}`);
      assert.equal(reloaded.restorePrevious(T2 + 3_000).projects[0].title, "Second");
    }
  });

  test("a primary write that commits before reporting failure completes its rollback", () => {
    const originalNow = Date.now;
    for (const { errorName, advanceBy } of [
      { errorName: "Error", advanceBy: 0 },
      { errorName: "QuotaExceededError", advanceBy: 0 },
      { errorName: "Error", advanceBy: 6_000 },
      { errorName: "QuotaExceededError", advanceBy: 6_000 }
    ]) {
      let fakeNow = 9_750_000;
      class CommittedPrimaryFailureStorage extends MemoryStorage {
        armed = false;

        setItem(key, value) {
          super.setItem(key, value);
          if (this.armed && key === STORAGE_KEY) {
            this.armed = false;
            fakeNow += advanceBy;
            const error = new Error("primary committed then reported failure");
            error.name = errorName;
            throw error;
          }
        }
      }
      const storage = new CommittedPrimaryFailureStorage();
      const store = new AppStore(storage, T0, null);
      store.update((draft) => draft.projects.push(createProject({ id: "p1", title: "First" }, T0)), T0);
      store.update((draft) => { draft.projects[0].title = "Second"; }, T1);
      const previousExpected = storage.getItem(STORAGE_KEY);
      storage.armed = true;
      Date.now = () => fakeNow;
      try {
        const saved = store.update((draft) => { draft.projects[0].title = "Third"; }, T2);
        assert.equal(saved.projects[0].title, "Third", `${errorName}/${advanceBy}`);
        assert.equal(storage.getItem(PREVIOUS_KEY), previousExpected, `${errorName}/${advanceBy}`);
        assert.equal(store.hasPreviousSnapshot(T2 + 1), true, `${errorName}/${advanceBy}`);
        assert.equal(storage.getItem(WRITE_LOCK_KEY), null, `${errorName}/${advanceBy}`);
      } finally {
        Date.now = originalNow;
      }

      const reloaded = new AppStore(storage, T2 + 1_000, null);
      assert.equal(reloaded.getState().projects[0].title, "Third");
      assert.equal(reloaded.hasPreviousSnapshot(T2 + 2_000), true, `${errorName}/${advanceBy}`);
      assert.equal(reloaded.restorePrevious(T2 + 3_000).projects[0].title, "Second");
    }
  });

  test("quota provenance restoration reacquires after its final mutation outlasts the lease", () => {
    const originalNow = Date.now;
    for (const throwsAfterCommit of [false, true]) {
      let fakeNow = 10_000_000;
      class ExpiredProvenanceTailStorage extends MemoryStorage {
        quotaMode = false;
        originalBinding = null;
        stalled = false;

        setItem(key, value) {
          if (this.quotaMode && key === STORAGE_KEY) {
            const error = new Error("still full");
            error.name = "QuotaExceededError";
            throw error;
          }
          super.setItem(key, value);
          if (this.quotaMode && !this.stalled
            && key === PREVIOUS_BINDING_KEY && value === this.originalBinding) {
            this.stalled = true;
            fakeNow += 6_000;
            if (throwsAfterCommit) throw new Error("binding restoration committed then threw");
          }
        }
      }
      const storage = new ExpiredProvenanceTailStorage();
      const store = new AppStore(storage, T0, null);
      store.update((draft) => draft.projects.push(createProject({ id: "p1", title: "First" }, T0)), T0);
      store.update((draft) => { draft.projects[0].title = "Second"; }, T1);
      const primaryBefore = storage.getItem(STORAGE_KEY);
      const previousBefore = storage.getItem(PREVIOUS_KEY);
      const bindingBefore = storage.getItem(PREVIOUS_BINDING_KEY);
      const formatBefore = storage.getItem(PREVIOUS_BINDING_FORMAT_KEY);
      storage.originalBinding = bindingBefore;
      storage.quotaMode = true;
      Date.now = () => fakeNow;
      try {
        assert.throws(
          () => store.update((draft) => { draft.projects[0].title = "No commit"; }, T2),
          /本地保存失败，原数据仍然保留/u,
          `throwsAfterCommit=${throwsAfterCommit}`
        );
        assert.equal(storage.stalled, true);
        assert.equal(storage.getItem(STORAGE_KEY), primaryBefore, String(throwsAfterCommit));
        assert.equal(storage.getItem(PREVIOUS_KEY), previousBefore, String(throwsAfterCommit));
        assert.equal(storage.getItem(PREVIOUS_BINDING_KEY), bindingBefore, String(throwsAfterCommit));
        assert.equal(storage.getItem(PREVIOUS_BINDING_FORMAT_KEY), formatBefore, String(throwsAfterCommit));
        assert.equal(store.hasPreviousSnapshot(T2 + 1), true, String(throwsAfterCommit));
        assert.equal(storage.getItem(WRITE_LOCK_KEY), null, String(throwsAfterCommit));
      } finally {
        Date.now = originalNow;
        storage.quotaMode = false;
      }

      const reloaded = new AppStore(storage, T2 + 1_000, null);
      assert.equal(reloaded.hasPreviousSnapshot(T2 + 2_000), true, String(throwsAfterCommit));
      assert.equal(reloaded.restorePrevious(T2 + 3_000).projects[0].title, "First");
    }
  });

  test("a delayed binding write repairs the direct cooperative winner's rollback ledger after lease expiry", () => {
    const originalNow = Date.now;
    let fakeNow = 1_000_000;
    class DelayedBindingStorage extends MemoryStorage {
      armed = false;
      competingTab = null;

      setItem(key, value) {
        if (this.armed && key === PREVIOUS_BINDING_KEY) {
          this.armed = false;
          fakeNow += 6_000;
          this.competingTab.update((draft) => { draft.projects[0].title = "B winner"; }, T2);
        }
        super.setItem(key, value);
      }
    }
    const storage = new DelayedBindingStorage();
    const firstTab = new AppStore(storage, T0, null);
    firstTab.update((draft) => draft.projects.push(createProject({ id: "p1", title: "First" }, T0)), T0);
    firstTab.update((draft) => { draft.projects[0].title = "Second"; }, T1);
    const predecessorRaw = storage.getItem(STORAGE_KEY);
    const olderRollbackRaw = storage.getItem(PREVIOUS_KEY);
    const competingTab = new AppStore(storage, T1 + 1, null);
    storage.competingTab = competingTab;
    storage.armed = true;
    Date.now = () => fakeNow;
    try {
      assert.throws(
        () => firstTab.update((draft) => { draft.projects[0].title = "A losing candidate"; }, T2 + 1),
        /同时取得了保存权|本地保存未完成/u
      );
      assert.equal(persisted(storage).projects[0].title, "B winner");
      assert.equal(storage.getItem(PREVIOUS_KEY), predecessorRaw);
      assert.notEqual(storage.getItem(PREVIOUS_KEY), olderRollbackRaw);
      assert.equal(firstTab.getState().projects[0].title, "B winner");
      assert.equal(storage.getItem(WRITE_LOCK_KEY), null);
    } finally {
      Date.now = originalNow;
    }
    const reloaded = new AppStore(storage, T2 + 2_000, null);
    assert.equal(reloaded.hasPreviousSnapshot(T2 + 3_000), true);
    assert.equal(reloaded.restorePrevious(T2 + 4_000).projects[0].title, "Second");
  });

  test("a delayed first-overwrite binding write repairs a winner that creates the first rollback", () => {
    const originalNow = Date.now;
    let fakeNow = 1_500_000;
    class DelayedFirstBindingStorage extends MemoryStorage {
      armed = false;
      competingTab = null;

      setItem(key, value) {
        if (this.armed && key === PREVIOUS_BINDING_KEY) {
          this.armed = false;
          fakeNow += 6_000;
          this.competingTab.update((draft) => { draft.projects[0].title = "B first winner"; }, T2);
        }
        super.setItem(key, value);
      }
    }
    const storage = new DelayedFirstBindingStorage();
    const firstTab = new AppStore(storage, T0, null);
    firstTab.update((draft) => draft.projects.push(createProject({ id: "p1", title: "First" }, T0)), T0);
    const predecessorRaw = storage.getItem(STORAGE_KEY);
    assert.equal(storage.getItem(PREVIOUS_KEY), null);
    storage.competingTab = new AppStore(storage, T1, null);
    storage.armed = true;
    Date.now = () => fakeNow;
    try {
      assert.throws(
        () => firstTab.update((draft) => { draft.projects[0].title = "A losing candidate"; }, T2 + 1),
        /同时取得了保存权|本地保存未完成/u
      );
      assert.equal(persisted(storage).projects[0].title, "B first winner");
      assert.equal(storage.getItem(PREVIOUS_KEY), predecessorRaw);
      assert.equal(firstTab.getState().projects[0].title, "B first winner");
      assert.equal(storage.getItem(WRITE_LOCK_KEY), null);
    } finally {
      Date.now = originalNow;
    }
    const reloaded = new AppStore(storage, T2 + 2_000, null);
    assert.equal(reloaded.hasPreviousSnapshot(T2 + 3_000), true);
    assert.equal(reloaded.restorePrevious(T2 + 4_000).projects[0].title, "First");
  });

  test("a delayed snapshot write restores the exact predecessor declared by the cooperative winner", () => {
    const originalNow = Date.now;
    let fakeNow = 2_000_000;
    class DelayedSnapshotStorage extends MemoryStorage {
      armed = false;
      competingTab = null;

      setItem(key, value) {
        if (this.armed && key === PREVIOUS_KEY) {
          this.armed = false;
          fakeNow += 6_000;
          assert.throws(
            () => this.competingTab.update((draft) => { draft.projects[0].title = "B stale attempt"; }, T2),
            /另一个标签页刚刚更新了数据/u
          );
          this.competingTab.update((draft) => { draft.projects[0].title = "B winner"; }, T2 + 2);
        }
        super.setItem(key, value);
      }
    }
    const storage = new DelayedSnapshotStorage();
    const firstTab = new AppStore(storage, T0, null);
    firstTab.update((draft) => draft.projects.push(createProject({ id: "p1", title: "First" }, T0)), T0);
    firstTab.update((draft) => { draft.projects[0].title = "Second"; }, T1);
    const staleRollbackRaw = storage.getItem(STORAGE_KEY);
    const competingTab = new AppStore(storage, T1 + 1, null);
    storage.competingTab = competingTab;
    storage.armed = true;
    Date.now = () => fakeNow;
    try {
      assert.throws(
        () => firstTab.update((draft) => { draft.projects[0].title = "A committed intermediate"; }, T2 + 1),
        /保存完成时替换了数据/u
      );
      assert.equal(persisted(storage).projects[0].title, "B winner");
      assert.equal(persisted(storage, PREVIOUS_KEY).projects[0].title, "A committed intermediate");
      assert.notEqual(storage.getItem(PREVIOUS_KEY), staleRollbackRaw);
      assert.equal(firstTab.getState().projects[0].title, "B winner");
      assert.equal(storage.getItem(WRITE_LOCK_KEY), null);
    } finally {
      Date.now = originalNow;
    }
    const reloaded = new AppStore(storage, T2 + 2_000, null);
    assert.equal(reloaded.hasPreviousSnapshot(T2 + 3_000), true);
    assert.equal(reloaded.restorePrevious(T2 + 4_000).projects[0].title, "A committed intermediate");
  });

  test("a delayed provenance rollback cannot erase the cooperative winner's ledger", () => {
    const originalNow = Date.now;
    let fakeNow = 3_000_000;
    class DelayedProvenanceRestoreStorage extends MemoryStorage {
      quotaMode = false;
      competitorWriting = false;
      armBindingRemoval = false;
      competingTab = null;

      setItem(key, value) {
        if (this.quotaMode && !this.competitorWriting && key === STORAGE_KEY) {
          const error = new Error("still full");
          error.name = "QuotaExceededError";
          throw error;
        }
        super.setItem(key, value);
      }

      removeItem(key) {
        if (this.armBindingRemoval && key === PREVIOUS_BINDING_KEY) {
          this.armBindingRemoval = false;
          fakeNow += 6_000;
          this.competitorWriting = true;
          try {
            this.competingTab.update((draft) => { draft.projects[0].title = "B winner"; }, T2);
          } finally {
            this.competitorWriting = false;
          }
        }
        super.removeItem(key);
      }
    }
    const storage = new DelayedProvenanceRestoreStorage();
    const currentRaw = JSON.stringify(stateWithProject("current", "Current"));
    const legacyPreviousRaw = JSON.stringify(stateWithProject("legacy", "Legacy previous"));
    storage.setItem(STORAGE_KEY, currentRaw);
    storage.setItem(PREVIOUS_KEY, legacyPreviousRaw);
    const firstTab = new AppStore(storage, T0, null);
    const competingTab = new AppStore(storage, T0, null);
    storage.competingTab = competingTab;
    storage.quotaMode = true;
    storage.armBindingRemoval = true;
    Date.now = () => fakeNow;
    try {
      assert.throws(
        () => firstTab.update((draft) => { draft.projects[0].title = "A losing quota edit"; }, T2 + 1),
        /本地保存未完成|同时取得了保存权/u
      );
      assert.equal(persisted(storage).projects[0].title, "B winner");
      assert.equal(storage.getItem(PREVIOUS_KEY), currentRaw);
      assert.notEqual(storage.getItem(PREVIOUS_BINDING_KEY), null);
      assert.equal(storage.getItem(PREVIOUS_BINDING_FORMAT_KEY), PREVIOUS_BINDING_FORMAT);
      assert.equal(firstTab.getState().projects[0].title, "B winner");
      assert.equal(storage.getItem(WRITE_LOCK_KEY), null);
    } finally {
      Date.now = originalNow;
      storage.quotaMode = false;
    }
    const reloaded = new AppStore(storage, T2 + 2_000, null);
    assert.equal(reloaded.hasPreviousSnapshot(T2 + 3_000), true);
    assert.equal(reloaded.restorePrevious(T2 + 4_000).projects[0].title, "Current");
  });

  test("a delayed quota-recovery read cannot overwrite the cooperative winner's new snapshot", () => {
    const originalNow = Date.now;
    let fakeNow = 3_500_000;
    class DelayedRecoveryReadStorage extends MemoryStorage {
      quotaMode = false;
      competitorWriting = false;
      sawRestoredBinding = false;
      armRecoveryRead = false;
      originalBinding = null;
      competingTab = null;

      setItem(key, value) {
        if (this.quotaMode && !this.competitorWriting && key === STORAGE_KEY) {
          const error = new Error("still full");
          error.name = "QuotaExceededError";
          throw error;
        }
        super.setItem(key, value);
        if (this.quotaMode && !this.competitorWriting
          && key === PREVIOUS_BINDING_KEY && value === this.originalBinding) {
          this.sawRestoredBinding = true;
        } else if (this.sawRestoredBinding && key === WRITE_LOCK_KEY) {
          this.sawRestoredBinding = false;
          this.armRecoveryRead = true;
        }
      }

      getItem(key) {
        const value = super.getItem(key);
        if (this.armRecoveryRead && key === PREVIOUS_KEY) {
          this.armRecoveryRead = false;
          fakeNow += 6_000;
          this.competitorWriting = true;
          try {
            this.competingTab.update((draft) => { draft.projects[0].title = "B quota winner"; }, T2);
          } finally {
            this.competitorWriting = false;
          }
          return value;
        }
        return value;
      }
    }
    const storage = new DelayedRecoveryReadStorage();
    const firstTab = new AppStore(storage, T0, null);
    firstTab.update((draft) => draft.projects.push(createProject({ id: "p1", title: "First" }, T0)), T0);
    firstTab.update((draft) => { draft.projects[0].title = "Second"; }, T1);
    const predecessorRaw = storage.getItem(STORAGE_KEY);
    storage.originalBinding = storage.getItem(PREVIOUS_BINDING_KEY);
    storage.competingTab = new AppStore(storage, T1 + 1, null);
    storage.quotaMode = true;
    Date.now = () => fakeNow;
    try {
      assert.throws(
        () => firstTab.update((draft) => { draft.projects[0].title = "A losing quota edit"; }, T2 + 1),
        /本地保存未完成|同时取得了保存权/u
      );
      assert.equal(persisted(storage).projects[0].title, "B quota winner");
      assert.equal(storage.getItem(PREVIOUS_KEY), predecessorRaw);
      assert.equal(storage.getItem(PREVIOUS_BINDING_FORMAT_KEY), PREVIOUS_BINDING_FORMAT);
      assert.notEqual(storage.getItem(PREVIOUS_BINDING_KEY), null);
    } finally {
      Date.now = originalNow;
      storage.quotaMode = false;
    }
    const reloaded = new AppStore(storage, T2 + 2_000, null);
    assert.equal(reloaded.hasPreviousSnapshot(T2 + 3_000), true);
    assert.equal(reloaded.restorePrevious(T2 + 4_000).projects[0].title, "Second");
  });

  test("a delayed cleanup read cannot remove the cooperative winner's snapshot", () => {
    const originalNow = Date.now;
    let fakeNow = 4_000_000;
    class DelayedCleanupReadStorage extends MemoryStorage {
      failSnapshotWrite = false;
      cleanupPreviousReads = 0;
      competingTab = null;

      setItem(key, value) {
        if (this.failSnapshotWrite && key === PREVIOUS_KEY) {
          this.failSnapshotWrite = false;
          this.cleanupPreviousReads = 0;
          throw new Error("snapshot denied");
        }
        super.setItem(key, value);
      }

      getItem(key) {
        const value = super.getItem(key);
        if (this.cleanupPreviousReads >= 0 && key === PREVIOUS_KEY) {
          this.cleanupPreviousReads += 1;
          if (this.cleanupPreviousReads === 2) {
            this.cleanupPreviousReads = -1;
            fakeNow += 6_000;
            assert.throws(
              () => this.competingTab.update((draft) => { draft.projects[0].title = "B stale cleanup"; }, T2),
              /另一个标签页刚刚更新了数据/u
            );
            this.competingTab.update((draft) => { draft.projects[0].title = "B cleanup winner"; }, T2 + 2);
            return value;
          }
        }
        return value;
      }
    }
    const storage = new DelayedCleanupReadStorage();
    storage.cleanupPreviousReads = -1;
    const firstTab = new AppStore(storage, T0, null);
    firstTab.update((draft) => draft.projects.push(createProject({ id: "p1", title: "First" }, T0)), T0);
    firstTab.update((draft) => { draft.projects[0].title = "Second"; }, T1);
    storage.competingTab = new AppStore(storage, T1 + 1, null);
    storage.failSnapshotWrite = true;
    Date.now = () => fakeNow;
    try {
      assert.throws(
        () => firstTab.update((draft) => { draft.projects[0].title = "A committed intermediate"; }, T2 + 1),
        /保存完成时替换了数据/u
      );
      assert.equal(persisted(storage).projects[0].title, "B cleanup winner");
      assert.equal(persisted(storage, PREVIOUS_KEY).projects[0].title, "A committed intermediate");
      assert.notEqual(storage.getItem(PREVIOUS_BINDING_KEY), null);
      assert.equal(storage.getItem(PREVIOUS_BINDING_FORMAT_KEY), PREVIOUS_BINDING_FORMAT);
    } finally {
      Date.now = originalNow;
    }
    const reloaded = new AppStore(storage, T2 + 2_000, null);
    assert.equal(reloaded.hasPreviousSnapshot(T2 + 3_000), true);
    assert.equal(reloaded.restorePrevious(T2 + 4_000).projects[0].title, "A committed intermediate");
  });

  test("a delayed unsupported-format restoration cannot disable the cooperative winner's ledger", () => {
    const originalNow = Date.now;
    let fakeNow = 4_500_000;
    class DelayedFormatRestoreStorage extends MemoryStorage {
      quotaMode = false;
      competitorWriting = false;
      armFormatRestore = false;
      competingTab = null;

      setItem(key, value) {
        if (this.quotaMode && !this.competitorWriting && key === STORAGE_KEY) {
          const error = new Error("still full");
          error.name = "QuotaExceededError";
          throw error;
        }
        if (this.armFormatRestore && key === PREVIOUS_BINDING_FORMAT_KEY && value === "2") {
          this.armFormatRestore = false;
          fakeNow += 6_000;
          this.competitorWriting = true;
          try {
            this.competingTab.update((draft) => { draft.projects[0].title = "B format winner"; }, T2);
          } finally {
            this.competitorWriting = false;
          }
        }
        super.setItem(key, value);
      }
    }
    const storage = new DelayedFormatRestoreStorage();
    const currentRaw = JSON.stringify(stateWithProject("current", "Current"));
    const previousRaw = JSON.stringify(stateWithProject("previous", "Untrusted previous"));
    storage.setItem(STORAGE_KEY, currentRaw);
    storage.setItem(PREVIOUS_KEY, previousRaw);
    storage.setItem(PREVIOUS_BINDING_KEY, previousBindingRaw(currentRaw, previousRaw));
    storage.setItem(PREVIOUS_BINDING_FORMAT_KEY, "2");
    const firstTab = new AppStore(storage, T0, null);
    storage.competingTab = new AppStore(storage, T0, null);
    storage.quotaMode = true;
    storage.armFormatRestore = true;
    Date.now = () => fakeNow;
    try {
      assert.throws(
        () => firstTab.update((draft) => { draft.projects[0].title = "A losing format edit"; }, T2 + 1),
        /本地保存未完成|同时取得了保存权/u
      );
      assert.equal(persisted(storage).projects[0].title, "B format winner");
      assert.equal(storage.getItem(PREVIOUS_KEY), currentRaw);
      assert.equal(storage.getItem(PREVIOUS_BINDING_FORMAT_KEY), PREVIOUS_BINDING_FORMAT);
      assert.notEqual(storage.getItem(PREVIOUS_BINDING_KEY), null);
    } finally {
      Date.now = originalNow;
      storage.quotaMode = false;
    }
    const reloaded = new AppStore(storage, T2 + 2_000, null);
    assert.equal(reloaded.hasPreviousSnapshot(T2 + 3_000), true);
    assert.equal(reloaded.restorePrevious(T2 + 4_000).projects[0].title, "Current");
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

  test("a failed rollback overwrite reclaims the stale copy and preserves one-step undo and redo", () => {
    class ReclaimableBackupQuotaStorage extends MemoryStorage {
      quotaMode = false;
      rejectedOverwrite = false;

      setItem(key, value) {
        if (this.quotaMode && key === PREVIOUS_KEY && this.getItem(PREVIOUS_KEY) !== null && !this.rejectedOverwrite) {
          this.rejectedOverwrite = true;
          const error = new Error("backup quota");
          error.name = "QuotaExceededError";
          throw error;
        }
        super.setItem(key, value);
      }
    }
    const storage = new ReclaimableBackupQuotaStorage();
    const store = new AppStore(storage, T0, null);
    store.update((draft) => draft.projects.push(createProject({ id: "p1", title: "First" }, T0)), T0);
    const second = store.update((draft) => { draft.projects[0].title = "Second"; }, T1);
    assert.equal(persisted(storage, PREVIOUS_KEY).projects[0].title, "First");
    storage.quotaMode = true;

    const third = store.update((draft) => { draft.settings.reducedMotion = true; }, T2);

    assert.equal(third.settings.reducedMotion, true);
    assert.deepEqual(persisted(storage, PREVIOUS_KEY), second);
    assert.equal(store.hasPreviousSnapshot(T2 + 500), true);
    const undone = store.restorePrevious(T2 + 1_000);
    assert.equal(undone.projects[0].title, "Second");
    assert.equal(undone.settings.reducedMotion, false);
    const redone = store.restorePrevious(T2 + 2_000);
    assert.equal(redone.projects[0].title, "Second");
    assert.equal(redone.settings.reducedMotion, true);
  });

  test("a rollback write that commits before throwing is recognized without destructive cleanup", () => {
    class CommittedThenRejectedBackupStorage extends MemoryStorage {
      rejectAfterWrite = false;

      setItem(key, value) {
        super.setItem(key, value);
        if (this.rejectAfterWrite && key === PREVIOUS_KEY) {
          this.rejectAfterWrite = false;
          const error = new Error("late backup rejection");
          error.name = "QuotaExceededError";
          throw error;
        }
      }
    }
    const storage = new CommittedThenRejectedBackupStorage();
    const store = new AppStore(storage, T0, null);
    store.update((draft) => draft.projects.push(createProject({ id: "p1", title: "First" }, T0)), T0);
    const second = store.update((draft) => { draft.projects[0].title = "Second"; }, T1);
    storage.rejectAfterWrite = true;

    store.update((draft) => { draft.settings.reducedMotion = true; }, T2);

    assert.deepEqual(persisted(storage, PREVIOUS_KEY), second);
    assert.equal(store.hasPreviousSnapshot(T2 + 1_000), true);
    const reloaded = new AppStore(storage, T2 + 2_000, null);
    assert.equal(reloaded.hasPreviousSnapshot(T2 + 3_000), true);
    assert.equal(reloaded.restorePrevious(T2 + 4_000).settings.reducedMotion, false);
  });

  test("a late primary displacement discards the rollback copy written by the losing tab", () => {
    class LateDisplacementStorage extends MemoryStorage {
      rejectAfterPreviousWrite = false;
      armDisplacement = false;
      displaceOnPrimaryRead = false;
      externalRaw = null;
      externalBindingRaw = null;

      getItem(key) {
        if (key === STORAGE_KEY && this.displaceOnPrimaryRead) {
          this.displaceOnPrimaryRead = false;
          super.setItem(PREVIOUS_BINDING_KEY, this.externalBindingRaw);
          super.setItem(PREVIOUS_BINDING_FORMAT_KEY, PREVIOUS_BINDING_FORMAT);
          super.setItem(STORAGE_KEY, this.externalRaw);
        }
        const value = super.getItem(key);
        if (key === PREVIOUS_KEY && this.armDisplacement) {
          this.armDisplacement = false;
          this.displaceOnPrimaryRead = true;
        }
        return value;
      }

      setItem(key, value) {
        super.setItem(key, value);
        if (key === PREVIOUS_KEY && this.rejectAfterPreviousWrite) {
          this.rejectAfterPreviousWrite = false;
          this.armDisplacement = true;
          const error = new Error("late backup rejection");
          error.name = "QuotaExceededError";
          throw error;
        }
      }
    }
    const storage = new LateDisplacementStorage();
    const store = new AppStore(storage, T0, null);
    store.update((draft) => draft.projects.push(createProject({ id: "local", title: "Local" }, T0)), T0);
    const external = stateWithProject("winner", "External winner");
    external.meta.updatedAt = new Date(T1).toISOString();
    storage.externalRaw = JSON.stringify(external);
    storage.externalBindingRaw = previousBindingRaw(storage.externalRaw, null);
    storage.rejectAfterPreviousWrite = true;

    assert.throws(
      () => store.update((draft) => { draft.projects[0].title = "Losing update"; }, T1),
      /保存完成时替换了数据/u
    );

    assert.deepEqual(store.getState().projects.map((project) => project.id), ["winner"]);
    assert.equal(storage.getItem(PREVIOUS_KEY), null);
    const reloaded = new AppStore(storage, T1 + 1_000, null);
    assert.deepEqual(reloaded.getState().projects.map((project) => project.id), ["winner"]);
    assert.equal(reloaded.hasPreviousSnapshot(T1 + 2_000), false);
  });

  test("delayed displaced-primary cleanup repairs the cooperative winner's rollback", () => {
    const originalNow = Date.now;
    let fakeNow = 9_000_000;
    class DelayedDiscardStorage extends MemoryStorage {
      armed = false;
      injected = false;
      inCompetitor = false;
      competingTab = null;
      externalRaw = null;
      externalBindingRaw = null;

      setItem(key, value) {
        super.setItem(key, value);
        if (this.armed && !this.inCompetitor && key === PREVIOUS_KEY) {
          this.armed = false;
          this.injected = true;
          super.setItem(PREVIOUS_BINDING_KEY, this.externalBindingRaw);
          super.setItem(PREVIOUS_BINDING_FORMAT_KEY, PREVIOUS_BINDING_FORMAT);
          super.setItem(STORAGE_KEY, this.externalRaw);
        }
      }

      removeItem(key) {
        if (key === PREVIOUS_KEY && this.injected && !this.inCompetitor) {
          this.injected = false;
          this.inCompetitor = true;
          fakeNow += 6_000;
          try {
            assert.throws(
              () => this.competingTab.update((draft) => { draft.projects[0].title = "B stale"; }, T2 + 2),
              /另一个标签页刚刚更新了数据/u
            );
            this.competingTab.update((draft) => { draft.projects[0].title = "B winner"; }, T2 + 4);
          } finally {
            this.inCompetitor = false;
          }
        }
        super.removeItem(key);
      }
    }
    const storage = new DelayedDiscardStorage();
    const firstTab = new AppStore(storage, T0, null);
    firstTab.update((draft) => draft.projects.push(createProject({ id: "p1", title: "First" }, T0)), T0);
    firstTab.update((draft) => { draft.projects[0].title = "Second"; }, T1);
    storage.competingTab = new AppStore(storage, T1 + 1, null);
    const external = JSON.parse(JSON.stringify(firstTab.getState()));
    external.projects[0].title = "W displaced winner";
    external.meta.revision += 1;
    external.meta.updatedAt = new Date(T2).toISOString();
    storage.externalRaw = JSON.stringify(external);
    storage.externalBindingRaw = previousBindingRaw(storage.externalRaw, null);
    storage.armed = true;
    Date.now = () => fakeNow;
    try {
      assert.throws(
        () => firstTab.update((draft) => { draft.projects[0].title = "A losing candidate"; }, T2 + 1),
        /保存完成时替换了数据/u
      );
      assert.equal(persisted(storage).projects[0].title, "B winner");
      assert.equal(storage.getItem(PREVIOUS_KEY), storage.externalRaw);
      assert.equal(storage.getItem(PREVIOUS_BINDING_FORMAT_KEY), PREVIOUS_BINDING_FORMAT);
      assert.notEqual(storage.getItem(PREVIOUS_BINDING_KEY), null);
      assert.equal(storage.getItem(WRITE_LOCK_KEY), null);
    } finally {
      Date.now = originalNow;
    }

    const reloaded = new AppStore(storage, T2 + 1_000, null);
    assert.equal(reloaded.hasPreviousSnapshot(T2 + 2_000), true);
    assert.equal(reloaded.restorePrevious(T2 + 3_000).projects[0].title, "W displaced winner");
  });

  test("a legacy winner loads but cannot inherit the losing tab's rollback after reload", () => {
    class LegacyWinnerStorage extends MemoryStorage {
      replaceDuringSnapshot = false;
      externalRaw = null;

      setItem(key, value) {
        super.setItem(key, value);
        if (key === PREVIOUS_KEY && this.replaceDuringSnapshot) {
          this.replaceDuringSnapshot = false;
          super.setItem(STORAGE_KEY, this.externalRaw);
        }
      }
    }
    const storage = new LegacyWinnerStorage();
    const store = new AppStore(storage, T0, null);
    store.update((draft) => draft.projects.push(createProject({ id: "local", title: "Local baseline" }, T0)), T0);
    const losingPrevious = storage.getItem(STORAGE_KEY);
    const external = stateWithProject("legacy-winner", "Legacy winner");
    external.meta.revision = 2;
    external.meta.updatedAt = new Date(T1).toISOString();
    storage.externalRaw = JSON.stringify(external);
    storage.replaceDuringSnapshot = true;

    assert.throws(
      () => store.update((draft) => { draft.projects[0].title = "Losing update"; }, T1),
      /已采用外部更新/u
    );

    assert.deepEqual(store.getState().projects.map((project) => project.id), ["legacy-winner"]);
    assert.equal(storage.getItem(PREVIOUS_KEY), losingPrevious);
    assert.equal(store.hasPreviousSnapshot(T1 + 1_000), false);
    const reloaded = new AppStore(storage, T1 + 2_000, null);
    assert.deepEqual(reloaded.getState().projects.map((project) => project.id), ["legacy-winner"]);
    assert.equal(reloaded.hasPreviousSnapshot(T1 + 3_000), false);
  });

  test("an adopted winner keeps a shared predecessor that its checksum explicitly binds", () => {
    class SharedPredecessorStorage extends MemoryStorage {
      replaceDuringSnapshot = false;
      externalRaw = null;
      externalBindingRaw = null;

      setItem(key, value) {
        super.setItem(key, value);
        if (key === PREVIOUS_KEY && this.replaceDuringSnapshot) {
          this.replaceDuringSnapshot = false;
          super.setItem(PREVIOUS_BINDING_KEY, this.externalBindingRaw);
          super.setItem(PREVIOUS_BINDING_FORMAT_KEY, PREVIOUS_BINDING_FORMAT);
          super.setItem(STORAGE_KEY, this.externalRaw);
        }
      }
    }
    const storage = new SharedPredecessorStorage();
    const store = new AppStore(storage, T0, null);
    store.update((draft) => draft.projects.push(createProject({ id: "safe", title: "Shared baseline" }, T0)), T0);
    const sharedRaw = storage.getItem(STORAGE_KEY);
    const external = stateWithProject("winner", "External winner");
    external.meta.updatedAt = new Date(T1).toISOString();
    storage.externalRaw = JSON.stringify(external);
    storage.externalBindingRaw = previousBindingRaw(storage.externalRaw, sharedRaw);
    storage.replaceDuringSnapshot = true;

    assert.throws(
      () => store.update((draft) => { draft.projects[0].title = "Losing update"; }, T1),
      /已采用外部更新/u
    );

    assert.equal(storage.getItem(PREVIOUS_KEY), sharedRaw);
    const reloaded = new AppStore(storage, T1 + 1_000, null);
    assert.equal(reloaded.hasPreviousSnapshot(T1 + 2_000), true);
    assert.deepEqual(reloaded.restorePrevious(T1 + 3_000).projects.map((project) => project.id), ["safe"]);
  });

  test("a corrupt primary displacement preserves the last valid rollback recovery copy", () => {
    class CorruptingSnapshotStorage extends MemoryStorage {
      corruptDuringSnapshot = false;

      setItem(key, value) {
        super.setItem(key, value);
        if (key === PREVIOUS_KEY && this.corruptDuringSnapshot) {
          this.corruptDuringSnapshot = false;
          super.setItem(STORAGE_KEY, "{broken");
        }
      }
    }
    const storage = new CorruptingSnapshotStorage();
    const store = new AppStore(storage, T0, null);
    store.update((draft) => draft.projects.push(createProject({ id: "safe", title: "Safe" }, T0)), T0);
    const safeRaw = storage.getItem(STORAGE_KEY);
    storage.corruptDuringSnapshot = true;

    assert.throws(
      () => store.update((draft) => { draft.projects[0].title = "Must not publish"; }, T1),
      (error) => /主数据未保留/u.test(error.message) && !/已采用外部更新/u.test(error.message)
    );

    assert.deepEqual(store.getState().projects.map((project) => project.id), ["safe"]);
    assert.equal(storage.getItem(STORAGE_KEY), "{broken");
    assert.equal(storage.getItem(PREVIOUS_KEY), safeRaw);
    const recovered = new AppStore(storage, T1 + 1_000, null);
    assert.deepEqual(recovered.getState().projects.map((project) => project.id), ["safe"]);
    assert.match(recovered.drainNotices().join("；"), /自动恢复/u);
  });

  test("post-write snapshot verification restores recovery after corrupt displacement removes the copy", () => {
    class PostSnapshotDisplacementStorage extends MemoryStorage {
      displaceAfterSnapshot = false;

      setItem(key, value) {
        super.setItem(key, value);
        if (this.displaceAfterSnapshot && key === PREVIOUS_KEY) {
          this.displaceAfterSnapshot = false;
          super.setItem(STORAGE_KEY, "{broken");
          super.removeItem(PREVIOUS_KEY);
        }
      }
    }
    const storage = new PostSnapshotDisplacementStorage();
    const store = new AppStore(storage, T0, null);
    store.update((draft) => draft.projects.push(createProject({ id: "safe", title: "Confirmed" }, T0)), T0);
    const confirmedRaw = storage.getItem(STORAGE_KEY);
    storage.displaceAfterSnapshot = true;

    assert.throws(
      () => store.update((draft) => { draft.projects[0].title = "Must not publish"; }, T1),
      /主数据未保留/u
    );

    assert.equal(storage.getItem(STORAGE_KEY), "{broken");
    assert.equal(storage.getItem(PREVIOUS_KEY), confirmedRaw);
    const reloaded = new AppStore(storage, T1 + 1_000, null);
    assert.equal(reloaded.getState().projects[0].title, "Confirmed");
    assert.match(reloaded.drainNotices().join("；"), /自动恢复/u);
  });

  test("a snapshot-write failure restores recovery after displacing primary and removing the old copy", () => {
    class SnapshotFailureDisplacementStorage extends MemoryStorage {
      displaceDuringSnapshot = false;

      setItem(key, value) {
        if (this.displaceDuringSnapshot && key === PREVIOUS_KEY) {
          this.displaceDuringSnapshot = false;
          super.removeItem(PREVIOUS_KEY);
          super.setItem(STORAGE_KEY, "{broken");
          const error = new Error("snapshot full");
          error.name = "QuotaExceededError";
          throw error;
        }
        super.setItem(key, value);
      }
    }
    const storage = new SnapshotFailureDisplacementStorage();
    const store = new AppStore(storage, T0, null);
    store.update((draft) => draft.projects.push(createProject({ id: "safe", title: "First" }, T0)), T0);
    store.update((draft) => { draft.projects[0].title = "Confirmed second"; }, T1);
    const confirmedRaw = storage.getItem(STORAGE_KEY);
    storage.displaceDuringSnapshot = true;

    assert.throws(
      () => store.update((draft) => { draft.projects[0].title = "Must not publish"; }, T2),
      /主数据未保留/u
    );

    assert.equal(storage.getItem(STORAGE_KEY), "{broken");
    assert.equal(storage.getItem(PREVIOUS_KEY), confirmedRaw);
    const reloaded = new AppStore(storage, T2 + 1_000, null);
    assert.equal(reloaded.getState().projects[0].title, "Confirmed second");
    assert.match(reloaded.drainNotices().join("；"), /自动恢复/u);
  });

  test("rollback cleanup restores the confirmed state when its removal installs corrupt primary data", () => {
    class CleanupCorruptsPrimaryStorage extends MemoryStorage {
      failSnapshot = false;

      setItem(key, value) {
        if (this.failSnapshot && key === PREVIOUS_KEY) {
          const error = new Error("snapshot full");
          error.name = "QuotaExceededError";
          throw error;
        }
        super.setItem(key, value);
      }

      removeItem(key) {
        super.removeItem(key);
        if (this.failSnapshot && key === PREVIOUS_KEY) {
          this.failSnapshot = false;
          super.setItem(STORAGE_KEY, "{broken");
        }
      }
    }
    const storage = new CleanupCorruptsPrimaryStorage();
    const store = new AppStore(storage, T0, null);
    store.update((draft) => draft.projects.push(createProject({ id: "safe", title: "First" }, T0)), T0);
    store.update((draft) => { draft.projects[0].title = "Confirmed second"; }, T1);
    const confirmedRaw = storage.getItem(STORAGE_KEY);
    storage.failSnapshot = true;

    assert.throws(
      () => store.update((draft) => { draft.projects[0].title = "Must not publish"; }, T2),
      /主数据未保留/u
    );

    assert.equal(storage.getItem(STORAGE_KEY), "{broken");
    assert.equal(storage.getItem(PREVIOUS_KEY), confirmedRaw);
    const reloaded = new AppStore(storage, T2 + 1_000, null);
    assert.equal(reloaded.getState().projects[0].title, "Confirmed second");
    assert.match(reloaded.drainNotices().join("；"), /自动恢复/u);
  });

  test("rollback cleanup trusts re-read storage facts when removal commits and then throws", () => {
    class ThrowingCleanupStorage extends MemoryStorage {
      failSnapshot = false;

      setItem(key, value) {
        if (this.failSnapshot && key === PREVIOUS_KEY) {
          const error = new Error("snapshot full");
          error.name = "QuotaExceededError";
          throw error;
        }
        super.setItem(key, value);
      }

      removeItem(key) {
        super.removeItem(key);
        if (this.failSnapshot && key === PREVIOUS_KEY) {
          this.failSnapshot = false;
          super.setItem(STORAGE_KEY, "{broken");
          throw new Error("remove reported failure");
        }
      }
    }
    const storage = new ThrowingCleanupStorage();
    const store = new AppStore(storage, T0, null);
    store.update((draft) => draft.projects.push(createProject({ id: "safe", title: "First" }, T0)), T0);
    store.update((draft) => { draft.projects[0].title = "Confirmed second"; }, T1);
    const confirmedRaw = storage.getItem(STORAGE_KEY);
    storage.failSnapshot = true;

    assert.throws(
      () => store.update((draft) => { draft.projects[0].title = "Must not publish"; }, T2),
      /主数据未保留/u
    );

    assert.equal(storage.getItem(STORAGE_KEY), "{broken");
    assert.equal(storage.getItem(PREVIOUS_KEY), confirmedRaw);
    const reloaded = new AppStore(storage, T2 + 1_000, null);
    assert.equal(reloaded.getState().projects[0].title, "Confirmed second");
    assert.match(reloaded.drainNotices().join("；"), /自动恢复/u);
  });

  test("a permanently failed rollback overwrite removes the stale copy instead of exposing an older revision", () => {
    class PermanentBackupQuotaStorage extends MemoryStorage {
      quotaMode = false;

      setItem(key, value) {
        if (this.quotaMode && key === PREVIOUS_KEY) {
          const error = new Error("backup quota");
          error.name = "QuotaExceededError";
          throw error;
        }
        super.setItem(key, value);
      }
    }
    const storage = new PermanentBackupQuotaStorage();
    const store = new AppStore(storage, T0, null);
    store.update((draft) => draft.projects.push(createProject({ id: "p1", title: "First" }, T0)), T0);
    store.update((draft) => { draft.projects[0].title = "Second"; }, T1);
    assert.equal(persisted(storage, PREVIOUS_KEY).projects[0].title, "First");
    storage.quotaMode = true;

    const saved = store.update((draft) => { draft.settings.reducedMotion = true; }, T2);

    assert.equal(saved.settings.reducedMotion, true);
    assert.equal(persisted(storage).settings.reducedMotion, true);
    assert.equal(storage.getItem(PREVIOUS_KEY), null);
    assert.equal(store.hasPreviousSnapshot(T2 + 1_000), false);
    assert.match(store.drainNotices().join("；"), /滚动撤销快照.*不可用/u);
    const reloaded = new AppStore(storage, T2 + 2_000, null);
    assert.equal(reloaded.getState().settings.reducedMotion, true);
    assert.equal(reloaded.hasPreviousSnapshot(T2 + 3_000), false);
  });

  test("rollback cleanup preserves a different snapshot observed after the failed overwrite", () => {
    class InterleavingBackupStorage extends MemoryStorage {
      quotaMode = false;
      replacementRaw = null;
      removedReplacement = false;

      setItem(key, value) {
        if (this.quotaMode && key === PREVIOUS_KEY) {
          this.quotaMode = false;
          super.setItem(PREVIOUS_KEY, this.replacementRaw);
          const error = new Error("backup quota");
          error.name = "QuotaExceededError";
          throw error;
        }
        super.setItem(key, value);
      }

      removeItem(key) {
        if (key === PREVIOUS_KEY && this.getItem(PREVIOUS_KEY) === this.replacementRaw) this.removedReplacement = true;
        super.removeItem(key);
      }
    }
    const storage = new InterleavingBackupStorage();
    const store = new AppStore(storage, T0, null);
    store.update((draft) => draft.projects.push(createProject({ id: "p1", title: "First" }, T0)), T0);
    store.update((draft) => { draft.projects[0].title = "Second"; }, T1);
    storage.replacementRaw = JSON.stringify(stateWithProject("replacement", "Replacement snapshot"));
    storage.quotaMode = true;

    const third = store.update((draft) => { draft.settings.reducedMotion = true; }, T2);

    assert.equal(third.settings.reducedMotion, true);
    assert.equal(storage.getItem(PREVIOUS_KEY), storage.replacementRaw);
    assert.equal(storage.removedReplacement, false);
    assert.equal(store.hasPreviousSnapshot(T2 + 1_000), false);
    assert.match(store.drainNotices().join("；"), /滚动撤销快照.*不可用/u);
    const reloadedWhileUntrusted = new AppStore(storage, T2 + 1_500, null);
    assert.equal(reloadedWhileUntrusted.getState().settings.reducedMotion, true);
    assert.equal(reloadedWhileUntrusted.hasPreviousSnapshot(T2 + 1_600), false);

    const fourth = store.update((draft) => { draft.settings.staleAfterDays = 21; }, T2 + 2_000);
    assert.equal(fourth.settings.staleAfterDays, 21);
    assert.equal(store.hasPreviousSnapshot(T2 + 3_000), true);
    const restored = store.restorePrevious(T2 + 4_000);
    assert.equal(restored.settings.reducedMotion, true);
    assert.equal(restored.settings.staleAfterDays, 7);
  });

  test("an unreadable stale rollback remains blocked in memory without misreporting the committed primary write", () => {
    class UnreadableCleanupStorage extends MemoryStorage {
      failPreviousWrite = false;
      denyPreviousAccess = false;

      getItem(key) {
        if (this.denyPreviousAccess && key === PREVIOUS_KEY) throw new Error("previous read denied");
        return super.getItem(key);
      }

      setItem(key, value) {
        if (this.failPreviousWrite && key === PREVIOUS_KEY) {
          this.denyPreviousAccess = true;
          const error = new Error("backup quota");
          error.name = "QuotaExceededError";
          throw error;
        }
        super.setItem(key, value);
      }

      removeItem(key) {
        if (this.denyPreviousAccess && key === PREVIOUS_KEY) throw new Error("previous remove denied");
        super.removeItem(key);
      }
    }
    const storage = new UnreadableCleanupStorage();
    const store = new AppStore(storage, T0, null);
    store.update((draft) => draft.projects.push(createProject({ id: "p1", title: "First" }, T0)), T0);
    store.update((draft) => { draft.projects[0].title = "Second"; }, T1);
    const staleRaw = storage.getItem(PREVIOUS_KEY);
    storage.failPreviousWrite = true;

    const third = store.update((draft) => { draft.settings.reducedMotion = true; }, T2);

    assert.equal(third.settings.reducedMotion, true);
    assert.equal(persisted(storage).settings.reducedMotion, true);
    storage.denyPreviousAccess = false;
    assert.equal(storage.getItem(PREVIOUS_KEY), staleRaw);
    assert.equal(store.hasPreviousSnapshot(T2 + 1_000), false);
    assert.match(store.drainNotices().join("；"), /滚动撤销快照.*不可用/u);
    const reloadedWhileStale = new AppStore(storage, T2 + 1_500, null);
    assert.equal(reloadedWhileStale.getState().settings.reducedMotion, true);
    assert.equal(reloadedWhileStale.hasPreviousSnapshot(T2 + 1_600), false);

    storage.failPreviousWrite = false;
    store.update((draft) => { draft.settings.staleAfterDays = 21; }, T2 + 2_000);
    assert.equal(store.hasPreviousSnapshot(T2 + 3_000), true);
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
    assert.equal(Object.prototype.hasOwnProperty.call(persisted(storage).meta, "previousChecksum"), false);
    assert.equal(storage.getItem(PREVIOUS_KEY), null);
    assert.equal(store.hasPreviousSnapshot(T2 + 500), false);
    assert.match(store.notices.at(-1), /释放.*滚动撤销快照/);
  });

  test("a first save can identity-check and reclaim an orphan snapshot after a quota error", () => {
    class OrphanQuotaStorage extends MemoryStorage {
      setItem(key, value) {
        if (key === STORAGE_KEY && this.getItem(PREVIOUS_KEY) !== null) {
          const error = new Error("storage full");
          error.name = "QuotaExceededError";
          throw error;
        }
        super.setItem(key, value);
      }
    }
    const storage = new OrphanQuotaStorage();
    storage.setItem(PREVIOUS_KEY, JSON.stringify(stateWithProject("orphan", "Orphan")));
    const store = new AppStore(storage, T0, null);

    const saved = store.update(
      (draft) => draft.projects.push(createProject({ id: "first", title: "First save" }, T1)),
      T1
    );

    assert.deepEqual(saved.projects.map((project) => project.id), ["first"]);
    assert.deepEqual(persisted(storage).projects.map((project) => project.id), ["first"]);
    assert.equal(storage.getItem(PREVIOUS_KEY), null);
    assert.equal(store.hasPreviousSnapshot(T1 + 1_000), false);
    assert.match(store.drainNotices().join("；"), /释放.*滚动撤销快照/u);
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

  test("a quota retry cannot overwrite an external primary installed by rollback removal", () => {
    class RemovalInterleavingQuotaStorage extends MemoryStorage {
      quotaMode = false;
      primaryAttempts = 0;
      externalRaw = null;
      externalPreviousRaw = null;

      setItem(key, value) {
        if (this.quotaMode && key === STORAGE_KEY) {
          this.primaryAttempts += 1;
          if (this.primaryAttempts === 1) {
            const error = new Error("storage full");
            error.name = "QuotaExceededError";
            throw error;
          }
        }
        super.setItem(key, value);
      }

      removeItem(key) {
        super.removeItem(key);
        if (this.quotaMode && key === PREVIOUS_KEY) {
          super.setItem(STORAGE_KEY, this.externalRaw);
          super.setItem(PREVIOUS_KEY, this.externalPreviousRaw);
        }
      }
    }
    const storage = new RemovalInterleavingQuotaStorage();
    const store = new AppStore(storage, T0, null);
    store.update((draft) => draft.projects.push(createProject({ id: "p1", title: "First" }, T0)), T0);
    store.update((draft) => { draft.projects[0].title = "Second"; }, T1);
    const external = stateWithProject("late-quota-winner", "Late quota winner");
    external.meta.revision = store.getState().meta.revision + 1;
    external.meta.updatedAt = new Date(T2).toISOString();
    const externalPrevious = stateWithProject("late-quota-rollback", "Late quota rollback");
    externalPrevious.meta.revision = store.getState().meta.revision;
    externalPrevious.meta.updatedAt = new Date(T1).toISOString();
    storage.externalRaw = JSON.stringify(external);
    storage.externalPreviousRaw = JSON.stringify(externalPrevious);
    storage.quotaMode = true;

    assert.throws(
      () => store.update((draft) => { draft.projects[0].title = "Must not overwrite"; }, T2 + 1),
      /保存期间更新了数据|主数据未保留/u
    );

    assert.deepEqual(store.getState().projects.map((project) => project.id), ["late-quota-winner"]);
    assert.deepEqual(persisted(storage).projects.map((project) => project.id), ["late-quota-winner"]);
    assert.deepEqual(persisted(storage, PREVIOUS_KEY).projects.map((project) => project.id), ["late-quota-rollback"]);
    assert.equal(storage.getItem(WRITE_LOCK_KEY), null);
  });

  test("a corrupt primary installed by rollback removal keeps the confirmed state as recovery", () => {
    class CorruptRemovalQuotaStorage extends MemoryStorage {
      quotaMode = false;
      quotaObserved = false;

      setItem(key, value) {
        if (this.quotaMode && key === STORAGE_KEY && !this.quotaObserved) {
          this.quotaObserved = true;
          const error = new Error("storage full");
          error.name = "QuotaExceededError";
          throw error;
        }
        super.setItem(key, value);
      }

      removeItem(key) {
        super.removeItem(key);
        if (this.quotaMode && key === PREVIOUS_KEY) {
          this.quotaMode = false;
          super.setItem(STORAGE_KEY, "{broken");
        }
      }
    }
    const storage = new CorruptRemovalQuotaStorage();
    const store = new AppStore(storage, T0, null);
    store.update((draft) => draft.projects.push(createProject({ id: "safe", title: "First" }, T0)), T0);
    store.update((draft) => { draft.projects[0].title = "Confirmed second"; }, T1);
    const confirmedRaw = storage.getItem(STORAGE_KEY);
    storage.quotaMode = true;

    assert.throws(
      () => store.update((draft) => { draft.projects[0].title = "Must not publish"; }, T2),
      /保存期间更新了数据|主数据未保留/u
    );

    assert.equal(storage.getItem(STORAGE_KEY), "{broken");
    assert.equal(storage.getItem(PREVIOUS_KEY), confirmedRaw);
    const reloaded = new AppStore(storage, T2 + 1_000, null);
    assert.equal(reloaded.getState().projects[0].title, "Confirmed second");
    assert.match(reloaded.drainNotices().join("；"), /自动恢复/u);
  });

  test("a quota retry preserves a rolling snapshot replaced after the quota failure", () => {
    class SnapshotReplacementQuotaStorage extends MemoryStorage {
      quotaMode = false;
      quotaObserved = false;
      sawPreviousAfterQuota = false;
      replacementRaw = null;
      injected = false;
      postQuotaLockReads = 0;

      getItem(key) {
        const value = super.getItem(key);
        if (this.quotaObserved && key === PREVIOUS_KEY && !this.sawPreviousAfterQuota) {
          this.sawPreviousAfterQuota = true;
        } else if (this.sawPreviousAfterQuota && key === WRITE_LOCK_KEY && !this.injected) {
          this.postQuotaLockReads += 1;
          if (this.postQuotaLockReads === 2) {
            this.injected = true;
            super.setItem(PREVIOUS_KEY, this.replacementRaw);
          }
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
    const storage = new SnapshotReplacementQuotaStorage();
    const store = new AppStore(storage, T0, null);
    store.update((draft) => draft.projects.push(createProject({ id: "p1", title: "First" }, T0)), T0);
    store.update((draft) => { draft.projects[0].title = "Second"; }, T1);
    const primaryBefore = storage.getItem(STORAGE_KEY);
    const replacement = stateWithProject("replacement-rollback", "Replacement rollback");
    replacement.meta.revision = 17;
    replacement.meta.updatedAt = new Date(T2).toISOString();
    storage.replacementRaw = JSON.stringify(replacement);
    storage.quotaMode = true;

    assert.throws(
      () => store.update((draft) => { draft.projects[0].title = "Must not reclaim replacement"; }, T2 + 1),
      /滚动撤销快照/u
    );

    assert.equal(storage.getItem(STORAGE_KEY), primaryBefore);
    assert.deepEqual(store.getState().projects.map((project) => project.id), ["p1"]);
    assert.equal(store.getState().projects[0].title, "Second");
    assert.equal(storage.getItem(PREVIOUS_KEY), storage.replacementRaw);
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

  test("a displaced quota retry does not attach the losing tab's rollback to a winner without one", () => {
    class NullRollbackWinnerStorage extends MemoryStorage {
      quotaMode = false;
      primaryAttempts = 0;
      externalRaw = null;

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
        super.removeItem(PREVIOUS_KEY);
      }
    }
    const storage = new NullRollbackWinnerStorage();
    const store = new AppStore(storage, T0, null);
    store.update((draft) => draft.projects.push(createProject({ id: "local", title: "First" }, T0)), T0);
    store.update((draft) => { draft.projects[0].title = "Second"; }, T1);
    const external = stateWithProject("winner", "Winner without rollback");
    external.meta.revision = 5;
    external.meta.updatedAt = new Date(T2).toISOString();
    storage.externalRaw = JSON.stringify(external);
    storage.quotaMode = true;

    assert.throws(
      () => store.update((draft) => { draft.projects[0].title = "Must not publish"; }, T2 + 1),
      (error) => /本地保存未完成.*已采用外部更新/u.test(error.message)
        && !/原数据仍然保留/u.test(error.message)
    );

    assert.deepEqual(store.getState().projects.map((project) => project.id), ["winner"]);
    assert.equal(storage.getItem(PREVIOUS_KEY), null);
    const reloaded = new AppStore(storage, T2 + 1_000, null);
    assert.deepEqual(reloaded.getState().projects.map((project) => project.id), ["winner"]);
    assert.equal(reloaded.hasPreviousSnapshot(T2 + 2_000), false);
  });

  test("a corrupt quota retry keeps the last confirmed primary as startup recovery", () => {
    class CorruptQuotaRetryStorage extends MemoryStorage {
      quotaMode = false;
      primaryAttempts = 0;

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
        super.setItem(STORAGE_KEY, "{broken");
      }
    }
    const storage = new CorruptQuotaRetryStorage();
    const store = new AppStore(storage, T0, null);
    store.update((draft) => draft.projects.push(createProject({ id: "safe", title: "First" }, T0)), T0);
    store.update((draft) => { draft.projects[0].title = "Second"; }, T1);
    const confirmedRaw = storage.getItem(STORAGE_KEY);
    storage.quotaMode = true;

    assert.throws(
      () => store.update((draft) => { draft.projects[0].title = "Must not publish"; }, T2),
      /主数据未保留/u
    );

    assert.equal(store.getState().projects[0].title, "Second");
    assert.equal(storage.getItem(STORAGE_KEY), "{broken");
    assert.equal(storage.getItem(PREVIOUS_KEY), confirmedRaw);
    const recovered = new AppStore(storage, T2 + 1_000, null);
    assert.equal(recovered.getState().projects[0].title, "Second");
    assert.match(recovered.drainNotices().join("；"), /自动恢复/u);
  });

  test("a valid but policy-rejected quota winner is not given the losing tab's rollback", () => {
    class RejectedWinnerQuotaStorage extends MemoryStorage {
      quotaMode = false;
      primaryAttempts = 0;
      externalRaw = null;

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
        super.removeItem(PREVIOUS_KEY);
      }
    }
    const storage = new RejectedWinnerQuotaStorage();
    const store = new AppStore(storage, T0, null);
    store.update((draft) => draft.projects.push(createProject({ id: "local", title: "First" }, T0)), T0);
    store.update((draft) => { draft.projects[0].title = "Second"; }, T1);
    const external = stateWithProject("old-external", "Older external");
    external.meta.revision = 1;
    storage.externalRaw = JSON.stringify(external);
    storage.quotaMode = true;

    assert.throws(
      () => store.update((draft) => { draft.projects[0].title = "Must not publish"; }, T2),
      /主数据未保留/u
    );

    assert.equal(store.getState().projects[0].title, "Second");
    assert.equal(storage.getItem(PREVIOUS_KEY), null);
    const reloaded = new AppStore(storage, T2 + 1_000, null);
    assert.deepEqual(reloaded.getState().projects.map((project) => project.id), ["old-external"]);
    assert.equal(reloaded.hasPreviousSnapshot(T2 + 2_000), false);
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

  test("a near-expiry or expired quota-cleanup lease renews only to restore the exact removed rollback", () => {
    const originalNow = Date.now;
    let fakeNow = 1_000_000;
    class ExpiringCleanupQuotaStorage extends MemoryStorage {
      quotaMode = false;
      advanceOnRemoval = false;
      advanceBy = 0;

      setItem(key, value) {
        if (this.quotaMode && key === STORAGE_KEY) {
          const error = new Error("still full");
          error.name = "QuotaExceededError";
          throw error;
        }
        super.setItem(key, value);
      }

      removeItem(key) {
        super.removeItem(key);
        if (this.advanceOnRemoval && key === PREVIOUS_KEY) {
          this.advanceOnRemoval = false;
          fakeNow += this.advanceBy;
        }
      }
    }
    const storage = new ExpiringCleanupQuotaStorage();
    const store = new AppStore(storage, T0, null);
    store.update((draft) => draft.projects.push(createProject({ id: "safe", title: "First" }, T0)), T0);
    store.update((draft) => { draft.projects[0].title = "Second"; }, T1);
    const beforePrimary = storage.getItem(STORAGE_KEY);
    const beforePrevious = storage.getItem(PREVIOUS_KEY);
    const beforeBinding = storage.getItem(PREVIOUS_BINDING_KEY);
    const beforeFormat = storage.getItem(PREVIOUS_BINDING_FORMAT_KEY);
    for (const advanceBy of [4_600, 6_000]) {
      storage.quotaMode = true;
      storage.advanceOnRemoval = true;
      storage.advanceBy = advanceBy;
      Date.now = () => fakeNow;
      try {
        assert.throws(
          () => store.update((draft) => { draft.projects[0].title = "Must not commit"; }, T2),
          /原数据仍然保留/u
        );
        assert.equal(storage.getItem(STORAGE_KEY), beforePrimary);
        assert.equal(storage.getItem(PREVIOUS_KEY), beforePrevious);
        assert.equal(storage.getItem(PREVIOUS_BINDING_KEY), beforeBinding);
        assert.equal(storage.getItem(PREVIOUS_BINDING_FORMAT_KEY), beforeFormat);
        assert.equal(storage.getItem(WRITE_LOCK_KEY), null);
      } finally {
        Date.now = originalNow;
        storage.quotaMode = false;
      }
    }
    const reloaded = new AppStore(storage, T2 + 1_000, null);
    assert.equal(reloaded.hasPreviousSnapshot(T2 + 2_000), true);
    assert.equal(reloaded.restorePrevious(T2 + 3_000).projects[0].title, "First");
  });

  test("commit-then-throw marker cleanup still restores legacy provenance before rollback bytes", () => {
    class LegacyMarkerCleanupStorage extends MemoryStorage {
      quotaMode = false;
      throwOnMarkerRemoval = false;

      setItem(key, value) {
        if (this.quotaMode && key === STORAGE_KEY) {
          const error = new Error("still full");
          error.name = "QuotaExceededError";
          throw error;
        }
        super.setItem(key, value);
      }

      removeItem(key) {
        super.removeItem(key);
        if (this.throwOnMarkerRemoval && key === PREVIOUS_BINDING_FORMAT_KEY) {
          this.throwOnMarkerRemoval = false;
          throw new Error("marker removal reported failure");
        }
      }
    }
    const storage = new LegacyMarkerCleanupStorage();
    const primaryRaw = JSON.stringify(stateWithProject("current", "Legacy current"));
    const previousRaw = JSON.stringify(stateWithProject("previous", "Legacy previous"));
    storage.setItem(STORAGE_KEY, primaryRaw);
    storage.setItem(PREVIOUS_KEY, previousRaw);
    const store = new AppStore(storage, T0, null);
    storage.quotaMode = true;
    storage.throwOnMarkerRemoval = true;

    assert.throws(
      () => store.update((draft) => { draft.projects[0].title = "Rejected migration"; }, T1),
      /原数据仍然保留/u
    );

    assert.equal(storage.getItem(STORAGE_KEY), primaryRaw);
    assert.equal(storage.getItem(PREVIOUS_KEY), previousRaw);
    assert.equal(storage.getItem(PREVIOUS_BINDING_KEY), null);
    assert.equal(storage.getItem(PREVIOUS_BINDING_FORMAT_KEY), null);
    storage.quotaMode = false;
    const reloaded = new AppStore(storage, T2, null);
    assert.equal(reloaded.hasPreviousSnapshot(T2 + 1_000), true);
    assert.equal(reloaded.restorePrevious(T2 + 2_000).projects[0].title, "Legacy previous");
  });

  test("commit-then-throw format restoration cannot upgrade unsupported provenance to trusted", () => {
    class UnsupportedFormatRestoreStorage extends MemoryStorage {
      quotaMode = false;
      throwOnUnsupportedRestore = false;

      setItem(key, value) {
        if (this.quotaMode && key === STORAGE_KEY) {
          const error = new Error("still full");
          error.name = "QuotaExceededError";
          throw error;
        }
        super.setItem(key, value);
        if (this.throwOnUnsupportedRestore
          && key === PREVIOUS_BINDING_FORMAT_KEY
          && value === "2") {
          this.throwOnUnsupportedRestore = false;
          throw new Error("future format restore reported failure");
        }
      }
    }
    const storage = new UnsupportedFormatRestoreStorage();
    const primaryRaw = JSON.stringify(stateWithProject("current", "Current"));
    const previousRaw = JSON.stringify(stateWithProject("previous", "Untrusted previous"));
    const unsupportedBinding = previousBindingRaw(primaryRaw, previousRaw);
    storage.setItem(STORAGE_KEY, primaryRaw);
    storage.setItem(PREVIOUS_KEY, previousRaw);
    storage.setItem(PREVIOUS_BINDING_KEY, unsupportedBinding);
    storage.setItem(PREVIOUS_BINDING_FORMAT_KEY, "2");
    const store = new AppStore(storage, T0, null);
    assert.equal(store.hasPreviousSnapshot(T0 + 1), false);
    storage.quotaMode = true;
    storage.throwOnUnsupportedRestore = true;

    assert.throws(
      () => store.update((draft) => { draft.projects[0].title = "Must not commit"; }, T1),
      /原数据仍然保留/u
    );

    assert.equal(storage.getItem(STORAGE_KEY), primaryRaw);
    assert.equal(storage.getItem(PREVIOUS_KEY), previousRaw);
    assert.equal(storage.getItem(PREVIOUS_BINDING_KEY), unsupportedBinding);
    assert.equal(storage.getItem(PREVIOUS_BINDING_FORMAT_KEY), "2");
    storage.quotaMode = false;
    const reloaded = new AppStore(storage, T2, null);
    assert.equal(reloaded.hasPreviousSnapshot(T2 + 1_000), false);
  });

  test("a failed quota retry frees its new sidecars before restoring legacy rollback bytes", () => {
    class ByteCapacityStorage extends MemoryStorage {
      capacity = Number.POSITIVE_INFINITY;

      usage() {
        let total = 0;
        for (let index = 0; index < this.length; index += 1) {
          const key = this.key(index);
          const value = this.getItem(key);
          total += (key.length + value.length) * 2;
        }
        return total;
      }

      setItem(key, value) {
        const entries = new Map();
        for (let index = 0; index < this.length; index += 1) {
          const existingKey = this.key(index);
          entries.set(existingKey, this.getItem(existingKey));
        }
        entries.set(String(key), String(value));
        let proposed = 0;
        for (const [entryKey, entryValue] of entries) {
          proposed += (entryKey.length + entryValue.length) * 2;
        }
        if (proposed > this.capacity) {
          const error = new Error("CAP");
          error.name = "QuotaExceededError";
          throw error;
        }
        super.setItem(key, value);
      }
    }
    const primary = stateWithProject("p", "P");
    primary.meta.revision = 2;
    const previous = stateWithProject("r", "R");
    previous.meta.revision = 1;
    const primaryRaw = JSON.stringify(primary);
    const previousRaw = JSON.stringify(previous);
    const storage = new ByteCapacityStorage();
    storage.setItem(STORAGE_KEY, primaryRaw);
    storage.setItem(PREVIOUS_KEY, previousRaw);
    const seededUsage = storage.usage();
    storage.capacity = seededUsage + 250;
    const store = new AppStore(storage, T0, null);

    assert.throws(
      () => store.update((draft) => {
        for (let index = 0; index < 5; index += 1) {
          draft.projects.push(createProject({
            id: `x${index}`,
            title: `Extra ${index}`,
            description: "z".repeat(800)
          }, T1));
        }
      }, T1),
      /原数据仍然保留/u
    );

    assert.equal(storage.getItem(STORAGE_KEY), primaryRaw);
    assert.equal(storage.getItem(PREVIOUS_KEY), previousRaw);
    assert.equal(storage.getItem(PREVIOUS_BINDING_KEY), null);
    assert.equal(storage.getItem(PREVIOUS_BINDING_FORMAT_KEY), null);
    assert.equal(storage.getItem(WRITE_LOCK_KEY), null);
    assert.equal(storage.usage(), seededUsage);
    storage.capacity = Number.POSITIVE_INFINITY;
    const reloaded = new AppStore(storage, T2, null);
    assert.equal(reloaded.hasPreviousSnapshot(T2 + 1_000), true);
    assert.deepEqual(reloaded.restorePrevious(T2 + 2_000).projects.map((project) => project.id), ["r"]);
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
    assert.throws(() => store.restorePrevious(T1), /没有可恢复|没有可信/u);

    const damagedStorage = new MemoryStorage();
    const current = stateWithProject("current", "Current");
    const currentRaw = JSON.stringify(current);
    damagedStorage.setItem(STORAGE_KEY, currentRaw);
    damagedStorage.setItem(PREVIOUS_KEY, "{broken");
    setPreviousBinding(damagedStorage, currentRaw, "{broken");
    const damagedStore = new AppStore(damagedStorage, T0, null);
    assert.equal(damagedStore.hasPreviousSnapshot(), false);
    assert.throws(() => damagedStore.restorePrevious(T1), /已损坏/);
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

  test("replace rejects an incompatible explicit session closure without changing current data", () => {
    const storage = new MutationTrackingStorage();
    const store = new AppStore(storage, T0, null);
    store.update((draft) => draft.projects.push(createProject({ id: "safe" }, T0)), T0);
    store.update((draft) => { draft.projects[0].title = "Seeded snapshot"; }, T0);
    const beforeState = store.getState();
    const beforeCurrent = storage.getItem(STORAGE_KEY);
    const beforePrevious = storage.getItem(PREVIOUS_KEY);
    let emissions = 0;
    store.subscribe(() => emissions += 1);
    storage.resetMutations();
    const incoming = stateWithProject("incoming");
    incoming.sessions.push({
      id: "contradiction",
      projectId: "incoming",
      intention: "",
      status: "completed",
      startedAt: new Date(T0).toISOString(),
      endedAt: new Date(T0).toISOString(),
      checkpointId: null,
      sourceCheckpointId: null,
      closeReason: "quick-dock"
    });

    assert.throws(() => store.replace(incoming, T1), /会话状态与关闭原因不匹配：contradiction/u);

    assert.strictEqual(store.getState(), beforeState);
    assert.equal(storage.getItem(STORAGE_KEY), beforeCurrent);
    assert.equal(storage.getItem(PREVIOUS_KEY), beforePrevious);
    assert.equal(storage.getItem(WRITE_LOCK_KEY), null);
    assert.deepEqual(storage.mutations, []);
    assert.equal(emissions, 0);
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

  test("snapshot exports share the monotonic workspace time when the clock moves backward", () => {
    const store = new AppStore(new MemoryStorage(), T0);
    store.update((draft) => draft.projects.push(createProject({ id: "p1", title: "Clock anchor" }, T0)), T2);

    const exportTime = store.getSnapshotExportTimestamp(T1);

    assert.equal(exportTime, T2);
    assert.equal(store.exportSnapshot(exportTime).exportedAt, new Date(T2).toISOString());
    assert.equal(JSON.parse(store.exportSnapshotText(exportTime)).exportedAt, new Date(T2).toISOString());
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

describe("AppStore revision ceiling", () => {
  test("an import stops before persisting a revision without a safe successor", () => {
    const storage = new MemoryStorage();
    const store = new AppStore(storage, T0, null);
    const incoming = stateWithProject("ceiling-import", "Ceiling import");
    incoming.meta.revision = Number.MAX_SAFE_INTEGER;
    const before = store.getState();
    let emissions = 0;
    store.subscribe(() => emissions += 1);

    assert.doesNotThrow(() => store.previewImport(incoming, T1));
    assert.throws(() => store.importSnapshot(incoming, T1), /修订号已达到安全上限/u);

    assert.strictEqual(store.getState(), before);
    assert.equal(storage.getItem(STORAGE_KEY), null);
    assert.equal(storage.getItem(PREVIOUS_KEY), null);
    assert.equal(storage.getItem(WRITE_LOCK_KEY), null);
    assert.equal(emissions, 0);
  });

  test("a penultimate import commits the final safe revision and survives reload", () => {
    const storage = new MemoryStorage();
    const store = new AppStore(storage, T0, null);
    const incoming = stateWithProject("final-safe-import", "Final safe import");
    incoming.meta.revision = Number.MAX_SAFE_INTEGER - 1;

    const imported = store.importSnapshot(incoming, T1);
    const reloaded = new AppStore(storage, T2, null);

    assert.equal(imported.meta.revision, Number.MAX_SAFE_INTEGER);
    assert.equal(Number.isSafeInteger(imported.meta.revision), true);
    assert.equal(reloaded.getState().meta.revision, Number.MAX_SAFE_INTEGER);
    assert.equal(reloaded.getState().projects[0].id, "final-safe-import");
    assert.deepEqual(reloaded.drainNotices(), []);
  });

  test("restoring a snapshot advances beyond every revision anchor", () => {
    const storage = new MemoryStorage();
    const current = stateWithProject("current-anchor", "Current anchor");
    const previous = stateWithProject("previous-anchor", "Previous anchor");
    current.meta.revision = 4;
    previous.meta.revision = 9;
    storage.setItem(STORAGE_KEY, JSON.stringify(current));
    storage.setItem(PREVIOUS_KEY, JSON.stringify(previous));
    const store = new AppStore(storage, T0, null);

    const restored = store.restorePrevious(T1);

    assert.equal(restored.meta.revision, 10);
    assert.equal(restored.projects[0].id, "previous-anchor");
    assert.equal(persisted(storage, PREVIOUS_KEY).projects[0].id, "current-anchor");
  });

  test("every local successor path can commit the final safe revision", () => {
    const cases = [
      {
        label: "update",
        run: (store) => store.update((draft) => { draft.projects[0].title = "Changed"; }, T1)
      },
      { label: "replace", run: (store) => store.replace(stateWithProject("replacement", "Replacement"), T1) },
      { label: "reset", run: (store) => store.reset(T1) },
      { label: "restore", run: (store) => store.restorePrevious(T1), needsPrevious: true }
    ];

    for (const item of cases) {
      const storage = new MemoryStorage();
      const current = stateWithProject(`penultimate-${item.label}`, `Penultimate ${item.label}`);
      current.meta.revision = Number.MAX_SAFE_INTEGER - 1;
      storage.setItem(STORAGE_KEY, JSON.stringify(current));
      if (item.needsPrevious) {
        const previous = stateWithProject("previous", "Previous");
        previous.meta.revision = Number.MAX_SAFE_INTEGER - 2;
        storage.setItem(PREVIOUS_KEY, JSON.stringify(previous));
      }
      const store = new AppStore(storage, T0, null);

      item.run(store);

      assert.equal(store.getState().meta.revision, Number.MAX_SAFE_INTEGER, item.label);
      assert.equal(Number.isSafeInteger(store.getState().meta.revision), true, item.label);
      assert.equal(persisted(storage).meta.revision, Number.MAX_SAFE_INTEGER, item.label);
      const reloaded = new AppStore(storage, T2, null);
      assert.equal(reloaded.getState().meta.revision, Number.MAX_SAFE_INTEGER, item.label);
      assert.deepEqual(reloaded.drainNotices(), [], item.label);
    }
  });

  test("every local successor path fails atomically at the safe ceiling", () => {
    const cases = [
      {
        label: "update",
        run: (store) => store.update((draft) => { draft.projects[0].title = "Changed"; }, T1)
      },
      { label: "replace", run: (store) => store.replace(stateWithProject("replacement", "Replacement"), T1) },
      { label: "reset", run: (store) => store.reset(T1) },
      { label: "restore", run: (store) => store.restorePrevious(T1), needsPrevious: true }
    ];

    for (const item of cases) {
      const storage = new MemoryStorage();
      const current = stateWithProject(`ceiling-${item.label}`, `Ceiling ${item.label}`);
      current.meta.revision = Number.MAX_SAFE_INTEGER;
      storage.setItem(STORAGE_KEY, JSON.stringify(current));
      if (item.needsPrevious) {
        const previous = stateWithProject("previous", "Previous");
        previous.meta.revision = Number.MAX_SAFE_INTEGER - 1;
        storage.setItem(PREVIOUS_KEY, JSON.stringify(previous));
      }
      const store = new AppStore(storage, T0, null);
      const beforeState = store.getState();
      const beforeCurrent = storage.getItem(STORAGE_KEY);
      const beforePrevious = storage.getItem(PREVIOUS_KEY);
      let emissions = 0;
      store.subscribe(() => emissions += 1);

      assert.throws(() => item.run(store), /修订号已达到安全上限/u, item.label);
      assert.strictEqual(store.getState(), beforeState, item.label);
      assert.equal(storage.getItem(STORAGE_KEY), beforeCurrent, item.label);
      assert.equal(storage.getItem(PREVIOUS_KEY), beforePrevious, item.label);
      assert.equal(storage.getItem(WRITE_LOCK_KEY), null, item.label);
      assert.equal(emissions, 0, item.label);
    }
  });

  test("an invalid revision anchor is rejected before persistence", () => {
    const storage = new MemoryStorage();
    const current = stateWithProject("invalid-anchor", "Invalid anchor");
    storage.setItem(STORAGE_KEY, JSON.stringify(current));
    const store = new AppStore(storage, T0, null);
    const beforeState = store.getState();
    const beforeCurrent = storage.getItem(STORAGE_KEY);
    let emissions = 0;
    store.subscribe(() => emissions += 1);

    assert.throws(
      () => store.update((draft) => { draft.meta.revision = "4"; }, T1),
      /修订号无效/u
    );

    assert.strictEqual(store.getState(), beforeState);
    assert.equal(storage.getItem(STORAGE_KEY), beforeCurrent);
    assert.equal(storage.getItem(PREVIOUS_KEY), null);
    assert.equal(storage.getItem(WRITE_LOCK_KEY), null);
    assert.equal(emissions, 0);
  });

  test("external clear at the safe ceiling preserves live data and emits one warning", () => {
    const storage = new MemoryStorage();
    const eventTarget = new EventTarget();
    const current = stateWithProject("ceiling-clear", "Ceiling clear");
    current.meta.revision = Number.MAX_SAFE_INTEGER;
    storage.setItem(STORAGE_KEY, JSON.stringify(current));
    const store = new AppStore(storage, T0, eventTarget);
    const before = store.getState();
    const sources = [];
    store.subscribe((_state, event) => sources.push(event.source));
    storage.clear();
    const event = new Event("storage");
    Object.defineProperty(event, "key", { value: null });

    eventTarget.dispatchEvent(event);
    eventTarget.dispatchEvent(event);

    assert.strictEqual(store.getState(), before);
    assert.equal(storage.getItem(STORAGE_KEY), null);
    assert.deepEqual(sources, ["external"]);
    assert.equal(store.notices.length, 1);
    assert.match(store.notices[0], /本地数据已被清空.*修订号已达到安全上限.*仍保留清空前的内存状态.*立即导出完整备份/u);
    assert.equal(store.exportSnapshot(T1).data.projects[0].id, "ceiling-clear");
    assert.throws(
      () => store.update((draft) => { draft.projects[0].title = "Must not return"; }, T2),
      /修订号已达到安全上限/u
    );
    assert.strictEqual(store.getState(), before);
    assert.equal(storage.getItem(STORAGE_KEY), null);
  });

  test("external clear from the penultimate revision adopts an empty final-safe state", () => {
    const storage = new MemoryStorage();
    const eventTarget = new EventTarget();
    const current = stateWithProject("penultimate-clear", "Penultimate clear");
    current.meta.revision = Number.MAX_SAFE_INTEGER - 1;
    storage.setItem(STORAGE_KEY, JSON.stringify(current));
    const store = new AppStore(storage, T0, eventTarget);
    const sources = [];
    store.subscribe((_state, event) => sources.push(event.source));
    storage.clear();
    const event = new Event("storage");
    Object.defineProperty(event, "key", { value: null });

    eventTarget.dispatchEvent(event);

    assert.deepEqual(store.getState().projects, []);
    assert.equal(store.getState().meta.revision, Number.MAX_SAFE_INTEGER);
    assert.equal(Number.isSafeInteger(store.getState().meta.revision), true);
    assert.deepEqual(sources, ["external"]);
    assert.deepEqual(store.drainNotices(), []);
  });

  test("a same-revision collision at the ceiling is adopted with an actionable warning", () => {
    const storage = new MemoryStorage();
    const current = stateWithProject("collision", "Current");
    current.meta.revision = Number.MAX_SAFE_INTEGER;
    storage.setItem(STORAGE_KEY, JSON.stringify(current));
    const store = new AppStore(storage, T0, null);
    const external = stateWithProject("collision", "External");
    external.meta.revision = Number.MAX_SAFE_INTEGER;
    external.meta.updatedAt = new Date(T1).toISOString();
    external.projects[0].updatedAt = new Date(T1).toISOString();
    storage.setItem(STORAGE_KEY, JSON.stringify(external));

    assert.equal(store.refreshFromStorage(T1), true);

    assert.equal(store.getState().projects[0].title, "External");
    assert.match(store.notices.at(-1), /相同修订号.*已达到安全上限.*导出完整备份/u);
    assert.throws(() => store.update(() => {}, T2), /修订号已达到安全上限/u);
    assert.equal(persisted(storage).projects[0].title, "External");
  });

  test("two penultimate tabs converge on the final safe revision before further writes stop", () => {
    const storage = new MemoryStorage();
    const initial = stateWithProject("shared", "Shared");
    initial.meta.revision = Number.MAX_SAFE_INTEGER - 1;
    storage.setItem(STORAGE_KEY, JSON.stringify(initial));
    const winner = new AppStore(storage, T0, null);
    const stale = new AppStore(storage, T0, null);

    winner.update((draft) => { draft.projects[0].title = "Winner"; }, T1);
    assert.equal(winner.getState().meta.revision, Number.MAX_SAFE_INTEGER);
    assert.throws(
      () => stale.update((draft) => { draft.projects[0].title = "Stale"; }, T1),
      /另一个标签页刚刚更新了数据/u
    );
    assert.equal(stale.getState().projects[0].title, "Winner");
    assert.equal(stale.getState().meta.revision, Number.MAX_SAFE_INTEGER);
    assert.throws(
      () => stale.update((draft) => { draft.projects[0].title = "Retry"; }, T2),
      /修订号已达到安全上限/u
    );
    assert.equal(persisted(storage).projects[0].title, "Winner");
  });
});
