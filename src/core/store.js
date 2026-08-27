import { createEmptyState, isoNow, normalizeState, validateState } from "./model.js";

export const STORAGE_KEY = "reentry-deck/state/v1";
const PREVIOUS_KEY = `${STORAGE_KEY}/previous`;

export class AppStore {
  #storage;
  #state;
  #listeners = new Set();

  constructor(storage = globalThis.localStorage, now = Date.now()) {
    this.#storage = storage;
    this.notices = [];
    this.#state = this.#load(now);
  }

  getState() {
    return this.#state;
  }

  subscribe(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
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
      appVersion: "0.1.0",
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

  #load(now) {
    const current = this.#storage?.getItem(STORAGE_KEY);
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
    if (current) this.#storage.setItem(PREVIOUS_KEY, current);
    try {
      this.#storage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch (error) {
      if (current) this.#storage.setItem(STORAGE_KEY, current);
      throw new Error(`本地保存失败，原数据仍然保留：${error.message}`);
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
