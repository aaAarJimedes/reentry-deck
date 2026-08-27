import { createEmptyState, isoAtOrAfter, normalizeState, validateImportCandidate, validateState } from "./model.js";
import { buildImportPreview, checksumSnapshotData, readImportSnapshot } from "./import-preview.js";

export const STORAGE_KEY = "reentry-deck/state/v1";
export const APP_VERSION = "0.53.0";
export const STORAGE_REFERENCE_BYTES = 5 * 1024 * 1024;
const PREVIOUS_KEY = `${STORAGE_KEY}/previous`;

export class AppStore {
  #storage;
  #state;
  #persistedRaw = null;
  #listeners = new Set();
  #storageListener = null;
  #eventTarget = null;
  #skipNextPreviousWrite = false;
  #rejectedRaw = null;
  #hasRejectedRaw = false;

  constructor(storage = globalThis.localStorage, now = Date.now(), eventTarget = globalThis.window) {
    this.#storage = storage;
    this.notices = [];
    this.#persistedRaw = this.#storage?.getItem(STORAGE_KEY) ?? null;
    this.#state = this.#load(now, this.#persistedRaw);
    if (eventTarget?.addEventListener) {
      this.#eventTarget = eventTarget;
      this.#storageListener = (event) => {
        const belongsToStorage = !event.storageArea || event.storageArea === this.#storage;
        if (belongsToStorage && (event.key === STORAGE_KEY || event.key === null)) {
          this.refreshFromStorage();
        }
      };
      eventTarget.addEventListener("storage", this.#storageListener);
    }
  }

  getState() {
    return this.#state;
  }

  getStorageUsage(referenceBytes = STORAGE_REFERENCE_BYTES) {
    return inspectStorageUsage(this.#storage, referenceBytes);
  }

  subscribe(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  destroy() {
    if (this.#storageListener && this.#eventTarget?.removeEventListener) {
      this.#eventTarget.removeEventListener("storage", this.#storageListener);
    }
    this.#storageListener = null;
    this.#eventTarget = null;
    this.#listeners.clear();
  }

  drainNotices() {
    return this.notices.splice(0);
  }

  refreshFromStorage(now = Date.now()) {
    const current = this.#storage?.getItem(STORAGE_KEY) ?? null;
    if (current === this.#persistedRaw) return false;
    if (this.#hasRejectedRaw && current === this.#rejectedRaw) return false;
    try {
      let next;
      if (current) {
        next = parseSavedState(current, now);
        if (next.meta.revision <= this.#state.meta.revision) {
          throw new Error(`外部修订号未前进（当前 ${this.#state.meta.revision}，收到 ${next.meta.revision}）`);
        }
        if (Date.parse(next.meta.updatedAt) < Date.parse(this.#state.meta.updatedAt)) {
          throw new Error(`外部更新时间倒退（当前 ${this.#state.meta.updatedAt}，收到 ${next.meta.updatedAt}）`);
        }
      } else {
        next = createEmptyState(isoAtOrAfter(now, this.#state.meta.updatedAt));
        next.meta.revision = this.#state.meta.revision + 1;
      }
      this.#persistedRaw = current;
      this.#rejectedRaw = null;
      this.#hasRejectedRaw = false;
      this.#state = next;
      this.#emit("external");
      return true;
    } catch (error) {
      this.#rejectedRaw = current;
      this.#hasRejectedRaw = true;
      this.notices.push(`另一个标签页写入的数据无法安全采用，当前页面未采用它：${error.message}`);
      this.#emit("external");
      return false;
    }
  }

  update(recipe, now = Date.now()) {
    const next = structuredClone(this.#state);
    recipe(next);
    next.meta.updatedAt = isoAtOrAfter(now, this.#state.meta.updatedAt);
    next.meta.revision = Math.max(next.meta.revision, this.#state.meta.revision) + 1;
    const errors = validateImportCandidate(next);
    if (errors.length) throw new Error(`无法保存：${errors.join("；")}`);
    this.#persist(next);
    this.#state = next;
    this.#emit();
    return next;
  }

  replace(value, now = Date.now()) {
    const candidateErrors = validateImportCandidate(value);
    if (candidateErrors.length) throw new Error(`导入失败：${candidateErrors.join("；")}`);
    const next = normalizeState(value, now);
    const errors = validateState(next);
    if (errors.length) throw new Error(`导入失败：${errors.join("；")}`);
    next.meta.updatedAt = isoAtOrAfter(now, this.#state.meta.updatedAt, next.meta.updatedAt);
    next.meta.revision = Math.max(next.meta.revision, this.#state.meta.revision) + 1;
    this.#persist(next);
    this.#state = next;
    this.#emit();
    return next;
  }

  reset(now = Date.now()) {
    const next = createEmptyState(isoAtOrAfter(now, this.#state.meta.updatedAt));
    next.meta.revision = this.#state.meta.revision + 1;
    this.#persist(next);
    this.#state = next;
    this.#emit();
  }

  exportSnapshot() {
    const data = structuredClone(this.#state);
    return {
      format: "reentry-deck-backup",
      exportedAt: isoAtOrAfter(Date.now(), this.#state.meta.updatedAt),
      appVersion: APP_VERSION,
      checksum: checksumSnapshotData(data),
      data
    };
  }

  hasPreviousSnapshot(now = Date.now()) {
    try {
      this.#readPrevious(now);
      return true;
    } catch {
      return false;
    }
  }

  restorePrevious(now = Date.now()) {
    const restored = this.#readPrevious(now);
    restored.meta.updatedAt = isoAtOrAfter(now, this.#state.meta.updatedAt, restored.meta.updatedAt);
    restored.meta.revision = this.#state.meta.revision + 1;
    this.#persist(restored);
    this.#state = restored;
    this.#emit();
    return restored;
  }

  importSnapshot(value, now = Date.now()) {
    return this.replace(readImportSnapshot(value, now).state, now);
  }

  previewImport(value, now = Date.now()) {
    return buildImportPreview(value, this.#state, now);
  }

  #load(now, current) {
    if (!current) return createEmptyState(now);
    try {
      return parseSavedState(current, now);
    } catch (error) {
      this.#skipNextPreviousWrite = true;
      const previous = this.#storage?.getItem(PREVIOUS_KEY);
      if (previous) {
        try {
          const recovered = parseSavedState(previous, now);
          this.notices.push("主数据损坏，已自动恢复到上一个可用版本。请尽快导出备份。");
          return recovered;
        } catch {
          // Fall through to a clean state while preserving the unreadable strings in storage.
        }
      }
      this.notices.push(`本地数据无法读取，已用空白工作区启动：${error.message}`);
      return createEmptyState(now);
    }
  }

  #readPrevious(now) {
    const raw = this.#storage?.getItem(PREVIOUS_KEY);
    if (!raw) throw new Error("没有可恢复的上一次保存。 ");
    let value;
    try {
      value = JSON.parse(raw);
    } catch {
      throw new Error("上一次保存已损坏，无法安全恢复。 ");
    }
    const candidateErrors = validateImportCandidate(value);
    if (candidateErrors.length) throw new Error(`上一次保存无效：${candidateErrors.join("；")}`);
    const restored = normalizeState(value, now);
    const errors = validateState(restored);
    if (errors.length) throw new Error(`上一次保存无效：${errors.join("；")}`);
    return restored;
  }

  #persist(next) {
    if (!this.#storage) throw new Error("浏览器没有提供可用的本地存储。 ");
    const current = this.#storage.getItem(STORAGE_KEY);
    if (current !== this.#persistedRaw) {
      this.refreshFromStorage();
      throw new Error("检测到另一个标签页刚刚更新了数据；已阻止覆盖，请重试刚才的操作。 ");
    }
    const serialized = JSON.stringify(next);
    let releasedPrevious = false;
    try {
      this.#storage.setItem(STORAGE_KEY, serialized);
    } catch (error) {
      const previous = this.#storage.getItem(PREVIOUS_KEY);
      if (!isQuotaExceeded(error) || previous === null) {
        throw new Error(`本地保存失败，原数据仍然保留：${error.message}`);
      }
      try {
        this.#storage.removeItem(PREVIOUS_KEY);
        this.#storage.setItem(STORAGE_KEY, serialized);
        releasedPrevious = true;
        this.notices.push("浏览器存储空间接近上限，已释放可再生的滚动撤销快照以完成本次保存；请尽快导出完整备份。 ");
      } catch (retryError) {
        try {
          this.#storage.setItem(PREVIOUS_KEY, previous);
        } catch {
          // Best effort only: the primary value was never committed.
        }
        throw new Error(`本地保存失败，原数据仍然保留：${retryError.message}`);
      }
    }
    this.#persistedRaw = serialized;
    const shouldSavePrevious = current && !this.#skipNextPreviousWrite && !releasedPrevious;
    this.#skipNextPreviousWrite = false;
    if (shouldSavePrevious) {
      try {
        this.#storage.setItem(PREVIOUS_KEY, current);
      } catch {
        // The current write already succeeded. A missing rollback copy is safer
        // than rejecting all future edits near the browser's quota limit.
      }
    }
  }

  #emit(source = "local") {
    const event = Object.freeze({ source });
    for (const listener of this.#listeners) listener(this.#state, event);
  }
}

function isQuotaExceeded(error) {
  return Boolean(error) && (
    error.name === "QuotaExceededError"
    || error.code === 22
    || error.code === 1014
  );
}

function parseSavedState(raw, now) {
  const value = JSON.parse(raw);
  const candidateErrors = validateImportCandidate(value);
  if (candidateErrors.length) throw new Error(candidateErrors.join("；"));
  const state = normalizeState(value, now);
  const errors = validateState(state);
  if (errors.length) throw new Error(errors.join("；"));
  return state;
}

export class MemoryStorage {
  #values = new Map();

  get length() {
    return this.#values.size;
  }

  key(index) {
    return [...this.#values.keys()][index] ?? null;
  }

  getItem(key) {
    return this.#values.has(key) ? this.#values.get(key) : null;
  }

  setItem(key, value) {
    this.#values.set(key, String(value));
  }

  removeItem(key) {
    this.#values.delete(key);
  }

  clear() {
    this.#values.clear();
  }
}

export function inspectStorageUsage(storage, referenceBytes = STORAGE_REFERENCE_BYTES) {
  const unavailable = Object.freeze({
    available: false,
    appBytes: 0,
    totalBytes: 0,
    referenceBytes: STORAGE_REFERENCE_BYTES,
    ratio: 0,
    status: "unavailable"
  });
  if (!storage || !Number.isSafeInteger(storage.length) || typeof storage.key !== "function") return unavailable;
  if (!Number.isSafeInteger(referenceBytes) || referenceBytes <= 0) return unavailable;
  try {
    let appBytes = 0;
    let totalBytes = 0;
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (typeof key !== "string") continue;
      const value = storage.getItem(key);
      if (value === null) continue;
      const bytes = (key.length + value.length) * 2;
      totalBytes += bytes;
      if (key.startsWith("reentry-deck/")) appBytes += bytes;
    }
    const ratio = totalBytes / referenceBytes;
    return Object.freeze({
      available: true,
      appBytes,
      totalBytes,
      referenceBytes,
      ratio,
      status: ratio >= 1 ? "critical" : ratio >= 0.8 ? "warning" : "ok"
    });
  } catch {
    return unavailable;
  }
}
