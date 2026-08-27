import { createEmptyState, isoNow, normalizeState, validateImportCandidate, validateState } from "./model.js";

export const STORAGE_KEY = "reentry-deck/state/v1";
export const APP_VERSION = "0.2.0";
const PREVIOUS_KEY = `${STORAGE_KEY}/previous`;

export class AppStore {
  #storage;
  #state;
  #persistedRaw = null;
  #listeners = new Set();
  #storageListener = null;

  constructor(storage = globalThis.localStorage, now = Date.now(), eventTarget = globalThis.window) {
    this.#storage = storage;
    this.notices = [];
    this.#persistedRaw = this.#storage?.getItem(STORAGE_KEY) ?? null;
    this.#state = this.#load(now, this.#persistedRaw);
    if (eventTarget?.addEventListener) {
      this.#storageListener = (event) => {
        if (event.key === STORAGE_KEY) this.refreshFromStorage();
      };
      eventTarget.addEventListener("storage", this.#storageListener);
    }
  }

  getState() {
    return this.#state;
  }

  subscribe(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  refreshFromStorage(now = Date.now()) {
    const current = this.#storage?.getItem(STORAGE_KEY) ?? null;
    if (current === this.#persistedRaw) return false;
    try {
      const next = current ? normalizeState(JSON.parse(current), now) : createEmptyState(now);
      const errors = validateState(next);
      if (errors.length) throw new Error(errors.join("；"));
      this.#persistedRaw = current;
      this.#state = next;
      this.#emit();
      return true;
    } catch (error) {
      this.notices.push(`另一个标签页写入的数据无法读取，当前页面未采用它：${error.message}`);
      return false;
    }
  }

  update(recipe, now = Date.now()) {
    const next = structuredClone(this.#state);
    recipe(next);
    next.meta.updatedAt = isoNow(now);
    next.meta.revision += 1;
    const errors = validateState(next);
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
    next.meta.updatedAt = isoNow(now);
    next.meta.revision += 1;
    this.#persist(next);
    this.#state = next;
    this.#emit();
    return next;
  }

  reset(now = Date.now()) {
    const next = createEmptyState(now);
    this.#persist(next);
    this.#state = next;
    this.#emit();
  }

  exportSnapshot() {
    return {
      format: "reentry-deck-backup",
      exportedAt: isoNow(),
      appVersion: APP_VERSION,
      data: structuredClone(this.#state)
    };
  }

  importSnapshot(value, now = Date.now()) {
    if (value && typeof value === "object" && "format" in value) {
      if (value.format !== "reentry-deck-backup") throw new Error("导入失败：无法识别这份备份的格式。 ");
      if (!value.data || typeof value.data !== "object") throw new Error("导入失败：备份信封缺少数据内容。 ");
      return this.replace(value.data, now);
    }
    return this.replace(value, now);
  }

  #load(now, current) {
    if (!current) return createEmptyState(now);
    try {
      return normalizeState(JSON.parse(current), now);
    } catch (error) {
      const previous = this.#storage?.getItem(PREVIOUS_KEY);
      if (previous) {
        try {
          const recovered = normalizeState(JSON.parse(previous), now);
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

  #persist(next) {
    if (!this.#storage) throw new Error("浏览器没有提供可用的本地存储。 ");
    const current = this.#storage.getItem(STORAGE_KEY);
    if (current !== this.#persistedRaw) {
      this.refreshFromStorage();
      throw new Error("检测到另一个标签页刚刚更新了数据；已阻止覆盖，请重试刚才的操作。 ");
    }
    const serialized = JSON.stringify(next);
    try {
      this.#storage.setItem(STORAGE_KEY, serialized);
    } catch (error) {
      throw new Error(`本地保存失败，原数据仍然保留：${error.message}`);
    }
    this.#persistedRaw = serialized;
    if (current) {
      try {
        this.#storage.setItem(PREVIOUS_KEY, current);
      } catch {
        // The current write already succeeded. A missing rollback copy is safer
        // than rejecting all future edits near the browser's quota limit.
      }
    }
  }

  #emit() {
    for (const listener of this.#listeners) listener(this.#state);
  }
}

export class MemoryStorage {
  #values = new Map();

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
