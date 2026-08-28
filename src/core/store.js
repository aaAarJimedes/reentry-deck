import { createEmptyState, isoAtOrAfter, normalizeState, validateImportCandidate, validateState } from "./model.js";
import { buildImportPreview, checksumSnapshotData, readImportSnapshot } from "./import-preview.js";

export const STORAGE_KEY = "reentry-deck/state/v1";
export const APP_VERSION = "0.100.0";
export const STORAGE_REFERENCE_BYTES = 5 * 1024 * 1024;
const PREVIOUS_KEY = `${STORAGE_KEY}/previous`;
export const WRITE_LOCK_KEY = `${STORAGE_KEY}/write-lock`;
const WRITE_LOCK_TTL_MS = 5_000;

export class AppStore {
  #storage;
  #state;
  #persistedRaw = null;
  #listeners = new Set();
  #failedListeners = new WeakSet();
  #storageListener = null;
  #eventTarget = null;
  #skipNextPreviousWrite = false;
  #rejectedRaw = null;
  #hasRejectedRaw = false;
  #activeWriteLock = null;

  constructor(storage = undefined, now = Date.now(), eventTarget = globalThis.window) {
    this.notices = [];
    try {
      this.#storage = storage === undefined ? globalThis.localStorage ?? null : storage;
      this.#persistedRaw = this.#storage?.getItem(STORAGE_KEY) ?? null;
    } catch (error) {
      this.#storage = null;
      this.notices.push(`浏览器本地存储不可访问，已用临时空白工作区启动：${errorMessage(error)}`);
    }
    this.#state = freezeState(this.#load(now, this.#persistedRaw));
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
    if (typeof listener !== "function") throw new TypeError("状态订阅者必须是函数。 ");
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
    this.#failedListeners = new WeakSet();
  }

  drainNotices() {
    return this.notices.splice(0);
  }

  refreshFromStorage(now = Date.now()) {
    let current;
    try {
      current = this.#storage?.getItem(STORAGE_KEY) ?? null;
    } catch (error) {
      this.notices.push(`无法读取另一个标签页的更新，当前页面保持不变：${errorMessage(error)}`);
      this.#emit("external");
      return false;
    }
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
      this.#state = freezeState(next);
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
    this.#state = freezeState(next);
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
    this.#state = freezeState(next);
    this.#emit();
    return next;
  }

  reset(now = Date.now()) {
    const next = createEmptyState(isoAtOrAfter(now, this.#state.meta.updatedAt));
    next.meta.revision = this.#state.meta.revision + 1;
    this.#persist(next);
    this.#state = freezeState(next);
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
    this.#state = freezeState(restored);
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
      let previous = null;
      try {
        previous = this.#storage?.getItem(PREVIOUS_KEY) ?? null;
      } catch {
        // The primary read already failed validation; an inaccessible rollback
        // copy cannot safely participate in recovery.
      }
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
    const releaseWriteLock = this.#acquireWriteLock();
    try {
      this.#persistWithLock(next);
    } finally {
      releaseWriteLock();
    }
  }

  #persistWithLock(next) {
    let current;
    try {
      current = this.#storage.getItem(STORAGE_KEY);
    } catch (error) {
      throw new Error(`本地保存失败，无法核对现有数据：${errorMessage(error)}`);
    }
    if (current !== this.#persistedRaw) {
      this.refreshFromStorage();
      throw new Error("检测到另一个标签页刚刚更新了数据；已阻止覆盖，请重试刚才的操作。 ");
    }
    const serialized = JSON.stringify(next);
    let releasedPrevious = false;
    try {
      this.#assertWriteLock();
      this.#storage.setItem(STORAGE_KEY, serialized);
    } catch (error) {
      let previous = null;
      try {
        previous = this.#storage.getItem(PREVIOUS_KEY);
      } catch {
        // Without a readable rollback value there is nothing safe to reclaim.
      }
      if (!isQuotaExceeded(error) || previous === null) {
        throw new Error(`本地保存失败，原数据仍然保留：${error.message}`);
      }
      try {
        this.#assertWriteLock();
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

  #acquireWriteLock(now = Date.now()) {
    const owner = globalThis.crypto?.randomUUID?.() ?? `${now}-${Math.random().toString(36).slice(2)}`;
    const token = JSON.stringify({ owner, expiresAt: now + WRITE_LOCK_TTL_MS });
    try {
      const existing = this.#storage.getItem(WRITE_LOCK_KEY);
      if (isActiveWriteLock(existing, now)) {
        throw new Error("另一个标签页正在保存，请立即重试。 ");
      }
      this.#storage.setItem(WRITE_LOCK_KEY, token);
      if (this.#storage.getItem(WRITE_LOCK_KEY) !== token) {
        throw new Error("另一个标签页同时取得了保存权，请立即重试。 ");
      }
    } catch (error) {
      if (/另一个标签页/u.test(error?.message ?? "")) throw error;
      throw new Error(`本地保存失败，无法取得安全写入租约：${errorMessage(error)}`);
    }
    this.#activeWriteLock = token;
    return () => {
      try {
        if (this.#storage.getItem(WRITE_LOCK_KEY) === token) this.#storage.removeItem(WRITE_LOCK_KEY);
      } catch {
        // The short lease expires on its own; never misreport an already committed write.
      } finally {
        if (this.#activeWriteLock === token) this.#activeWriteLock = null;
      }
    };
  }

  #assertWriteLock() {
    const persistedLock = this.#storage.getItem(WRITE_LOCK_KEY);
    if (!this.#activeWriteLock
      || persistedLock !== this.#activeWriteLock
      || !isActiveWriteLock(persistedLock, Date.now())) {
      throw new Error("另一个标签页同时取得了保存权，请立即重试。 ");
    }
  }

  #emit(source = "local") {
    const event = Object.freeze({ source });
    for (const listener of [...this.#listeners]) {
      try {
        listener(this.#state, event);
      } catch (error) {
        if (this.#failedListeners.has(listener)) continue;
        this.#failedListeners.add(listener);
        this.notices.push(`工作区状态已处理，但一个界面订阅未能响应：${errorMessage(error)}`);
      }
    }
  }
}

function errorMessage(error) {
  return typeof error?.message === "string" && error.message.trim() ? error.message : "访问被拒绝";
}

function freezeState(state) {
  for (const name of ["projects", "sessions", "crumbs", "checkpoints"]) {
    for (const record of state[name]) {
      if (record && typeof record === "object") Object.freeze(record);
    }
    Object.freeze(state[name]);
  }
  Object.freeze(state.meta);
  Object.freeze(state.settings);
  Object.freeze(state.ui);
  return Object.freeze(state);
}

function isQuotaExceeded(error) {
  return Boolean(error) && (
    error.name === "QuotaExceededError"
    || error.code === 22
    || error.code === 1014
  );
}

function isActiveWriteLock(raw, now) {
  if (typeof raw !== "string" || !raw) return false;
  try {
    const value = JSON.parse(raw);
    return typeof value?.owner === "string"
      && value.owner.length > 0
      && Number.isFinite(value.expiresAt)
      && value.expiresAt > now
      && value.expiresAt <= now + WRITE_LOCK_TTL_MS;
  } catch {
    return false;
  }
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
