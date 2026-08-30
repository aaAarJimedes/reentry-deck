import { compactText, createEmptyState, isCanonicalSnapshotChecksum, isoAtOrAfter, makeId, normalizeState, validateImportCandidate, validateState } from "./model.js";
import { buildImportPreview, checksumSerializedSnapshotData, readImportSnapshot } from "./import-preview.js";
import { safeDiagnosticMessage } from "./diagnostic.js";

export const STORAGE_KEY = "reentry-deck/state/v1";
export const APP_VERSION = "0.250.0";
export const STORAGE_REFERENCE_BYTES = 5 * 1024 * 1024;
const PREVIOUS_KEY = `${STORAGE_KEY}/previous`;
export const PREVIOUS_BINDING_KEY = `${PREVIOUS_KEY}/binding`;
export const PREVIOUS_BINDING_FORMAT_KEY = `${PREVIOUS_KEY}/binding-format`;
export const PREVIOUS_BINDING_FORMAT = "1";
export const WRITE_LOCK_KEY = `${STORAGE_KEY}/write-lock`;
const WRITE_LOCK_TTL_MS = 5_000;
const WRITE_LOCK_RENEWAL_MARGIN_MS = 500;
const STORAGE_ENTRY_SCAN_LIMIT = 10_000;
export const STORE_NOTICE_LIMIT = 8;
const MAX_STORE_NOTICE_LENGTH = 500;
const LEGACY_PREVIOUS_BINDING_VALUE = "legacy";
const LEGACY_PREVIOUS_BINDING = Symbol("legacy-previous-binding");
const INVALID_PREVIOUS_BINDING = Symbol("invalid-previous-binding");

export class AppStore {
  #storage;
  #state;
  #persistedRaw = null;
  #serializedState = "";
  #listeners = new Set();
  #failedListeners = new WeakSet();
  #storageListener = null;
  #eventTarget = null;
  #skipNextPreviousWrite = false;
  #startupRecoveryRaw = undefined;
  #rejectedRaw = null;
  #hasRejectedRaw = false;
  #unavailablePreviousRaw = undefined;
  #activeWriteLock = null;

  constructor(storage = undefined, now = Date.now(), eventTarget = globalThis.window) {
    this.notices = [];
    try {
      this.#storage = storage === undefined ? globalThis.localStorage ?? null : storage;
      this.#persistedRaw = this.#storage?.getItem(STORAGE_KEY) ?? null;
    } catch (error) {
      this.#storage = null;
      this.#addNotice(`浏览器本地存储不可访问，已用临时空白工作区启动：${safeDiagnosticMessage(error, "访问被拒绝")}`);
    }
    this.#state = freezeState(this.#load(now, this.#persistedRaw));
    this.#serializedState = JSON.stringify(this.#state);
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

  #addNotice(message) {
    this.notices.push(compactText(message, MAX_STORE_NOTICE_LENGTH));
    if (this.notices.length > STORE_NOTICE_LIMIT) this.notices.splice(0, this.notices.length - STORE_NOTICE_LIMIT);
  }

  refreshFromStorage(now = Date.now()) {
    let current;
    try {
      current = this.#storage?.getItem(STORAGE_KEY) ?? null;
    } catch (error) {
      this.#addNotice(`无法读取另一个标签页的更新，当前页面保持不变：${safeDiagnosticMessage(error, "访问被拒绝")}`);
      this.#emit("external");
      return false;
    }
    if (current === this.#persistedRaw) return false;
    if (this.#hasRejectedRaw && current === this.#rejectedRaw) return false;
    try {
      let next;
      let sameRevisionCollision = false;
      if (current !== null) {
        next = parseSavedState(current, now);
        if (next.meta.revision < this.#state.meta.revision) {
          throw new Error(`外部修订号倒退（当前 ${this.#state.meta.revision}，收到 ${next.meta.revision}）`);
        }
        if (Date.parse(next.meta.updatedAt) < Date.parse(this.#state.meta.updatedAt)) {
          throw new Error(`外部更新时间倒退（当前 ${this.#state.meta.updatedAt}，收到 ${next.meta.updatedAt}）`);
        }
        sameRevisionCollision = next.meta.revision === this.#state.meta.revision;
      } else {
        if (this.#state.meta.revision === Number.MAX_SAFE_INTEGER) {
          this.#rejectedRaw = current;
          this.#hasRejectedRaw = true;
          this.#addNotice("检测到本地数据已被清空，但当前修订号已达到安全上限，无法安全生成空白后继；本页仍保留清空前的内存状态。请立即导出完整备份，再刷新确认实际存储状态。 ");
          this.#emit("external");
          return false;
        }
        next = createEmptyState(isoAtOrAfter(now, this.#state.meta.updatedAt));
        next.meta.revision = nextSafeRevision(this.#state.meta.revision);
      }
      const serializedNext = JSON.stringify(next);
      if (serializedNext === this.#serializedState) {
        this.#persistedRaw = current;
        this.#rejectedRaw = null;
        this.#hasRejectedRaw = false;
        this.#acceptValidatedPrimary(current);
        return false;
      }
      this.#persistedRaw = current;
      this.#serializedState = serializedNext;
      this.#rejectedRaw = null;
      this.#hasRejectedRaw = false;
      this.#state = freezeState(next);
      this.#acceptValidatedPrimary(current);
      if (sameRevisionCollision) {
        this.#addNotice(next.meta.revision === Number.MAX_SAFE_INTEGER
          ? "检测到另一个标签页写入了相同修订号的不同内容；已采用实际持久化版本，但修订号已达到安全上限。请立即导出完整备份。 "
          : "检测到另一个标签页写入了相同修订号的不同内容；已采用实际持久化版本，下一次保存将继续递增修订号。 ");
      }
      this.#emit("external");
      return true;
    } catch (error) {
      this.#rejectedRaw = current;
      this.#hasRejectedRaw = true;
      this.#addNotice(`另一个标签页写入的数据无法安全采用，当前页面未采用它：${safeDiagnosticMessage(error, "访问被拒绝")}`);
      this.#emit("external");
      return false;
    }
  }

  update(recipe, now = Date.now()) {
    const next = structuredClone(this.#state);
    recipe(next);
    const errors = validateImportCandidate(next);
    if (errors.length) throw new Error(`无法保存：${errors.join("；")}`);
    next.meta.updatedAt = isoAtOrAfter(now, this.#state.meta.updatedAt);
    next.meta.revision = nextSafeRevision(next.meta.revision, this.#state.meta.revision);
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
    next.meta.revision = nextSafeRevision(next.meta.revision, this.#state.meta.revision);
    this.#persist(next);
    this.#state = freezeState(next);
    this.#emit();
    return next;
  }

  reset(now = Date.now()) {
    const next = createEmptyState(isoAtOrAfter(now, this.#state.meta.updatedAt));
    next.meta.revision = nextSafeRevision(this.#state.meta.revision);
    this.#persist(next);
    this.#state = freezeState(next);
    this.#emit();
  }

  getSnapshotExportTimestamp(now = Date.now()) {
    return Date.parse(isoAtOrAfter(now, this.#state.meta.updatedAt));
  }

  exportSnapshot(now = Date.now()) {
    const data = JSON.parse(this.#serializedState);
    return {
      format: "reentry-deck-backup",
      exportedAt: new Date(this.getSnapshotExportTimestamp(now)).toISOString(),
      appVersion: APP_VERSION,
      checksum: checksumSerializedSnapshotData(this.#serializedState),
      data
    };
  }

  exportSnapshotText(now = Date.now()) {
    const serializedData = this.#serializedState;
    const metadata = JSON.stringify({
      format: "reentry-deck-backup",
      exportedAt: new Date(this.getSnapshotExportTimestamp(now)).toISOString(),
      appVersion: APP_VERSION,
      checksum: checksumSerializedSnapshotData(serializedData)
    });
    return `${metadata.slice(0, -1)},"data":${serializedData}}`;
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
    restored.meta.revision = nextSafeRevision(this.#state.meta.revision, restored.meta.revision);
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
    if (current === null) return createEmptyState(now);
    try {
      return parseSavedState(current, now);
    } catch (error) {
      this.#skipNextPreviousWrite = true;
      let previousBinding = this.#readPreviousBinding(current);
      let previous = null;
      try {
        previous = this.#storage?.getItem(PREVIOUS_KEY) ?? null;
      } catch {
        // The primary read already failed validation; an inaccessible rollback
        // copy cannot safely participate in recovery.
      }
      if (previous && previousBinding === INVALID_PREVIOUS_BINDING) {
        previousBinding = this.#readRecoveryBinding(current, previous);
      }
      const explicitBindingMatch = Boolean(previous && typeof previousBinding === "string"
        && checksumSerializedSnapshotData(previous) === previousBinding);
      const previousMatchesBinding = previous && (previousBinding === LEGACY_PREVIOUS_BINDING || explicitBindingMatch);
      let previousCandidateInvalid = false;
      if (previousMatchesBinding) {
        try {
          const recovered = parseSavedState(previous, now);
          this.#startupRecoveryRaw = previous;
          this.#markPreviousUnavailable(previous);
          this.#addNotice("主数据损坏，已自动恢复到上一个可用版本。请尽快导出备份。");
          return recovered;
        } catch {
          previousCandidateInvalid = true;
          // Fall through to a clean state while preserving the unreadable strings in storage.
        }
      }
      const diagnostic = previousCandidateInvalid
        ? explicitBindingMatch
          ? "滚动撤销快照的来源标记已通过，但副本内容损坏或结构无效，已拒绝恢复"
          : "旧格式兼容候选滚动快照的内容损坏或结构无效，已拒绝恢复"
        : previous && previousBinding !== LEGACY_PREVIOUS_BINDING
          ? "滚动撤销快照未受损坏主数据的校验标记信任，已拒绝恢复该旧副本"
          : safeDiagnosticMessage(error, "访问被拒绝");
      this.#addNotice(`本地数据无法读取，已用空白工作区启动：${diagnostic}`);
      return createEmptyState(now);
    }
  }

  #acceptValidatedPrimary(primaryRaw) {
    this.#skipNextPreviousWrite = false;
    this.#startupRecoveryRaw = undefined;
    const binding = this.#readPreviousBinding(primaryRaw);
    if (binding !== LEGACY_PREVIOUS_BINDING && binding !== INVALID_PREVIOUS_BINDING) {
      this.#unavailablePreviousRaw = undefined;
    }
  }

  #readPrevious(now) {
    if (this.#persistedRaw === null) throw new Error("当前工作区没有可信的滚动撤销快照。 ");
    const raw = this.#storage?.getItem(PREVIOUS_KEY);
    if (this.#unavailablePreviousRaw === null || this.#unavailablePreviousRaw === raw) {
      throw new Error("滚动撤销快照不可用；请先完成一次新的保存。 ");
    }
    if (!raw) throw new Error("没有可恢复的上一次保存。 ");
    const expectedChecksum = this.#readPreviousBinding(this.#persistedRaw);
    if (expectedChecksum === INVALID_PREVIOUS_BINDING) {
      throw new Error("滚动撤销快照的来源记录不可用，已拒绝恢复。 ");
    }
    if (expectedChecksum === null) {
      throw new Error("当前工作区没有可信的滚动撤销快照。 ");
    }
    if (typeof expectedChecksum === "string" && checksumSerializedSnapshotData(raw) !== expectedChecksum) {
      throw new Error("滚动撤销快照不属于当前工作区，已拒绝恢复。 ");
    }
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
    const serialized = JSON.stringify(next);
    const releaseWriteLock = this.#acquireWriteLock();
    try {
      this.#persistWithLock(serialized);
    } finally {
      releaseWriteLock();
    }
  }

  #persistWithLock(serialized) {
    let current;
    try {
      current = this.#storage.getItem(STORAGE_KEY);
    } catch (error) {
      throw new Error(`本地保存失败，无法核对现有数据：${safeDiagnosticMessage(error, "访问被拒绝")}`);
    }
    if (current !== this.#persistedRaw) {
      this.refreshFromStorage();
      throw new Error("检测到另一个标签页刚刚更新了数据；已阻止覆盖，请重试刚才的操作。 ");
    }
    const wantsPreviousSnapshot = current !== null && !this.#skipNextPreviousWrite;
    const provenanceBeforeWrite = this.#readPreviousProvenanceForWrite(current);
    const currentPreviousBinding = current !== null
      ? typeof this.#startupRecoveryRaw === "string"
        ? checksumSerializedSnapshotData(this.#startupRecoveryRaw)
        : provenanceBeforeWrite.binding
      : null;
    const confirmedRecoveryRaw = this.#skipNextPreviousWrite
      ? this.#startupRecoveryRaw ?? null
      : current;
    let previousBeforeWrite;
    let previousBeforeWriteKnown = false;
    try {
      previousBeforeWrite = this.#storage.getItem(PREVIOUS_KEY);
      previousBeforeWriteKnown = true;
    } catch {
      // A primary save can still succeed, but an unknown old rollback value
      // must never be deleted as if its identity had been verified.
    }
    const nextPreviousRaw = wantsPreviousSnapshot
      ? current
      : typeof this.#startupRecoveryRaw === "string"
          && previousBeforeWriteKnown
          && previousBeforeWrite === this.#startupRecoveryRaw
        ? this.#startupRecoveryRaw
        : null;
    const standardBindingRaw = serializePreviousBinding(
      current,
      currentPreviousBinding,
      serialized,
      nextPreviousRaw
    );
    const reclaimedBindingRaw = nextPreviousRaw === null
      ? standardBindingRaw
      : serializePreviousBinding(current, currentPreviousBinding, serialized, null);
    let releasedPrevious = false;
    let quotaRemovalAttempted = false;
    let expectedBindingRaw = standardBindingRaw;
    try {
      this.#renewWriteLock();
      this.#assertWritePreconditions(current);
      this.#writePreviousBinding(expectedBindingRaw);
      this.#assertWritePreconditions(current);
      this.#assertPreviousBinding(expectedBindingRaw);
      this.#renewWriteLock();
      this.#assertWritePreconditions(current);
      this.#writePrimary(serialized, expectedBindingRaw);
    } catch (error) {
      let previous = null;
      try {
        previous = this.#storage.getItem(PREVIOUS_KEY);
      } catch {
        // Without a readable rollback value there is nothing safe to reclaim.
      }
      if (previous === null && confirmedRecoveryRaw !== null) {
        this.#restoreRejectedPrimaryRecovery(serialized, confirmedRecoveryRaw);
      }
      if (!isQuotaExceeded(error) || previous === null) {
        if (this.#repairDisplacedWinnerRollback(
          current,
          serialized,
          current,
          [standardBindingRaw, reclaimedBindingRaw],
          previousBeforeWriteKnown ? previousBeforeWrite : undefined
        )) {
          this.refreshFromStorage();
        }
        throw this.#persistenceFailure(error, current);
      }
      if (this.#skipNextPreviousWrite) {
        throw this.#persistenceFailure(
          new Error("当前工作区依赖滚动撤销快照完成损坏恢复；为避免删除唯一有效副本，已停止配额重试。请先导出备份或释放浏览器空间。 "),
          current
        );
      }
      if (!previousBeforeWriteKnown || previous !== previousBeforeWrite) {
        throw this.#persistenceFailure(
          new Error("检测到滚动撤销快照在配额失败前后发生变化；已保留该副本并停止重试。 "),
          current
        );
      }
      try {
        this.#assertQuotaReclaimPreconditions(current, previous);
        quotaRemovalAttempted = true;
        this.#storage.removeItem(PREVIOUS_KEY);
        this.#renewWriteLock();
        this.#assertWritePreconditions(current);
        expectedBindingRaw = reclaimedBindingRaw;
        this.#writePreviousBinding(expectedBindingRaw);
        this.#assertWritePreconditions(current);
        this.#assertPreviousBinding(expectedBindingRaw);
        this.#renewWriteLock();
        this.#assertWritePreconditions(current);
        this.#writePrimary(serialized, expectedBindingRaw);
        releasedPrevious = true;
        this.#unavailablePreviousRaw = undefined;
        this.#addNotice("浏览器存储空间接近上限，已释放可再生的滚动撤销快照以完成本次保存；请尽快导出完整备份。 ");
      } catch (retryError) {
        const provenanceRestoreAttempt = {
          bindingMutationAttempted: false,
          formatMutationAttempted: false
        };
        let recoveryPreviousWriteAttempted = null;
        try {
          if (!this.#ensureRecoveryWriteLock()) {
            throw new Error("无法重新取得仅用于恢复滚动撤销快照的写入租约。 ");
          }
          this.#assertWriteLock();
          const retryPrimary = this.#storage.getItem(STORAGE_KEY);
          const retryPrevious = this.#storage.getItem(PREVIOUS_KEY);
          const recoveryRaw = retryPrimary === current
            ? previous
            : confirmedRecoveryRaw !== null
                && this.#rejectedPrimaryCanRecoverFrom(retryPrimary, confirmedRecoveryRaw)
              ? confirmedRecoveryRaw
              : null;
          if (recoveryRaw !== null && retryPrevious === null) {
            if (retryPrimary === current) {
              this.#restorePreviousProvenance(
                current,
                [standardBindingRaw, reclaimedBindingRaw],
                provenanceBeforeWrite,
                provenanceRestoreAttempt
              );
            }
            this.#renewWriteLock();
            this.#assertWriteLock();
            const recoveryPrimary = this.#storage.getItem(STORAGE_KEY);
            const recoveryPrevious = this.#storage.getItem(PREVIOUS_KEY);
            if (recoveryPrimary === retryPrimary && recoveryPrevious === null) {
              if (!this.#ensureRecoveryWriteLock()) {
                throw new Error("恢复滚动撤销快照前无法重新取得写入租约。 ");
              }
              if (this.#storage.getItem(STORAGE_KEY) !== retryPrimary
                || this.#storage.getItem(PREVIOUS_KEY) !== null) {
                throw new Error("恢复滚动撤销快照前存储事实已变化。 ");
              }
              recoveryPreviousWriteAttempted = recoveryRaw;
              this.#storage.setItem(PREVIOUS_KEY, recoveryRaw);
            }
          }
        } catch {
          // Best effort only: never overwrite a rollback value another tab created.
          // A rejected replacement uses the last confirmed primary as startup recovery.
        }
        const repairedRecoveryOverwrite = typeof recoveryPreviousWriteAttempted === "string"
          && this.#repairDisplacedWinnerRollback(
            current,
            current,
            recoveryPreviousWriteAttempted,
            []
          );
        const repairedQuotaRemoval = quotaRemovalAttempted
          && typeof current === "string"
          && this.#repairDisplacedWinnerRollback(current, current, null, []);
        const repairedFormatMutation = provenanceRestoreAttempt.formatMutationAttempted
          && this.#repairDisplacedWinnerFormat(current, serialized, provenanceBeforeWrite.format);
        const repairedLocalMutation = this.#repairDisplacedWinnerRollback(
          current,
          serialized,
          current,
          provenanceRestoreAttempt.bindingMutationAttempted
            ? [standardBindingRaw, reclaimedBindingRaw, provenanceBeforeWrite.serialized]
            : [standardBindingRaw, reclaimedBindingRaw],
          previousBeforeWriteKnown ? previousBeforeWrite : undefined
        );
        if (repairedRecoveryOverwrite
          || repairedQuotaRemoval
          || repairedFormatMutation
          || repairedLocalMutation) {
          this.refreshFromStorage();
        }
        throw this.#persistenceFailure(retryError, current);
      }
    }
    const shouldSavePrevious = wantsPreviousSnapshot && !releasedPrevious;
    if (shouldSavePrevious) {
      this.#savePreviousAfterCommit(
        current,
        serialized,
        expectedBindingRaw,
        previousBeforeWrite,
        previousBeforeWriteKnown
      );
    } else {
      try {
        this.#verifyAcceptedBinding(serialized, expectedBindingRaw);
      } catch (error) {
        if (typeof nextPreviousRaw === "string") {
          this.#restoreRejectedPrimaryRecovery(serialized, nextPreviousRaw);
        }
        throw error;
      }
    }
    this.#skipNextPreviousWrite = false;
    this.#startupRecoveryRaw = undefined;
    this.#persistedRaw = serialized;
    this.#serializedState = serialized;
  }

  #readPreviousBinding(primaryRaw) {
    try {
      const format = this.#storage?.getItem(PREVIOUS_BINDING_FORMAT_KEY) ?? null;
      const serialized = this.#storage?.getItem(PREVIOUS_BINDING_KEY) ?? null;
      return parsePreviousBinding(format, serialized, primaryRaw);
    } catch {
      return INVALID_PREVIOUS_BINDING;
    }
  }

  #readRecoveryBinding(primaryRaw, previousRaw) {
    try {
      const format = this.#storage?.getItem(PREVIOUS_BINDING_FORMAT_KEY) ?? null;
      const serialized = this.#storage?.getItem(PREVIOUS_BINDING_KEY) ?? null;
      const exact = parsePreviousBinding(format, serialized, primaryRaw);
      return exact === INVALID_PREVIOUS_BINDING
        ? parseRecoveryPreviousBinding(format, serialized, previousRaw)
        : exact;
    } catch {
      return INVALID_PREVIOUS_BINDING;
    }
  }

  #readPreviousProvenanceForWrite(primaryRaw) {
    try {
      const format = this.#storage.getItem(PREVIOUS_BINDING_FORMAT_KEY);
      const serialized = this.#storage.getItem(PREVIOUS_BINDING_KEY);
      return {
        binding: primaryRaw === null ? null : parsePreviousBinding(format, serialized, primaryRaw),
        format,
        serialized
      };
    } catch (error) {
      throw new Error(`本地保存失败，无法读取滚动撤销快照的来源记录：${safeDiagnosticMessage(error, "访问被拒绝")}`);
    }
  }

  #writePreviousBinding(serialized) {
    this.#storage.setItem(PREVIOUS_BINDING_KEY, serialized);
    if (this.#storage.getItem(PREVIOUS_BINDING_KEY) !== serialized) {
      throw new Error("滚动撤销快照的来源记录未能可靠写入。 ");
    }
    if (this.#storage.getItem(PREVIOUS_BINDING_FORMAT_KEY) !== PREVIOUS_BINDING_FORMAT) {
      this.#storage.setItem(PREVIOUS_BINDING_FORMAT_KEY, PREVIOUS_BINDING_FORMAT);
      if (this.#storage.getItem(PREVIOUS_BINDING_FORMAT_KEY) !== PREVIOUS_BINDING_FORMAT) {
        throw new Error("滚动撤销快照的来源格式标记未能可靠写入。 ");
      }
    }
  }

  #writePrimary(serialized, expectedBinding) {
    let writeReportedFailure = false;
    let writeError;
    try {
      this.#storage.setItem(STORAGE_KEY, serialized);
    } catch (error) {
      writeReportedFailure = true;
      writeError = error;
    }
    if (writeReportedFailure) {
      let committed = false;
      try {
        if (this.#ensureRecoveryWriteLock()) {
          this.#assertWriteLock();
          const factsMatch = this.#storage.getItem(STORAGE_KEY) === serialized
            && this.#storage.getItem(PREVIOUS_BINDING_KEY) === expectedBinding
            && this.#storage.getItem(PREVIOUS_BINDING_FORMAT_KEY) === PREVIOUS_BINDING_FORMAT;
          if (factsMatch && this.#ensureRecoveryWriteLock()) {
            committed = this.#storage.getItem(STORAGE_KEY) === serialized
              && this.#storage.getItem(PREVIOUS_BINDING_KEY) === expectedBinding
              && this.#storage.getItem(PREVIOUS_BINDING_FORMAT_KEY) === PREVIOUS_BINDING_FORMAT;
          }
        }
      } catch {
        // A reported failure is accepted only from two exact renewed fact reads.
      }
      if (!committed) throw writeError;
    }
    this.#verifyPrimaryWrite(serialized);
  }

  #assertPreviousBinding(expected) {
    this.#assertWriteLock();
    if (this.#storage.getItem(PREVIOUS_BINDING_FORMAT_KEY) !== PREVIOUS_BINDING_FORMAT
      || this.#storage.getItem(PREVIOUS_BINDING_KEY) !== expected) {
      throw new Error("滚动撤销快照的来源记录在主数据提交前发生变化。 ");
    }
  }

  #verifyAcceptedBinding(expectedPrimary, expectedBinding, expectedPrevious = undefined) {
    this.#verifyPrimaryWrite(expectedPrimary);
    let accepted = false;
    try {
      if (!this.#ensureRecoveryWriteLock()) {
        throw new Error("确认滚动撤销快照前无法重新取得写入租约。 ");
      }
      this.#assertWriteLock();
      const factsMatch = this.#storage.getItem(STORAGE_KEY) === expectedPrimary
        && (expectedPrevious === undefined
          || this.#storage.getItem(PREVIOUS_KEY) === expectedPrevious)
        && this.#storage.getItem(PREVIOUS_BINDING_KEY) === expectedBinding
        && this.#storage.getItem(PREVIOUS_BINDING_FORMAT_KEY) === PREVIOUS_BINDING_FORMAT;
      if (factsMatch && this.#ensureRecoveryWriteLock()) {
        accepted = this.#storage.getItem(STORAGE_KEY) === expectedPrimary
          && (expectedPrevious === undefined
            || this.#storage.getItem(PREVIOUS_KEY) === expectedPrevious)
          && this.#storage.getItem(PREVIOUS_BINDING_KEY) === expectedBinding
          && this.#storage.getItem(PREVIOUS_BINDING_FORMAT_KEY) === PREVIOUS_BINDING_FORMAT;
      }
    } catch {
      // The primary write is already accepted. Missing provenance fails closed below.
    }
    if (accepted) {
      this.#unavailablePreviousRaw = undefined;
      return true;
    }
    this.#verifyPrimaryWrite(expectedPrimary);
    this.#markPreviousUnavailable(null);
    this.#addNotice("本次主数据已保存，但滚动撤销快照的来源记录不可用；已禁用本次撤销，请尽快导出完整备份。 ");
    return false;
  }

  #assertQuotaReclaimPreconditions(expectedPrimary, expectedPrevious) {
    this.#renewWriteLock();
    this.#assertWriteLock();
    let latestPrimary;
    let latestPrevious;
    try {
      latestPrimary = this.#storage.getItem(STORAGE_KEY);
      latestPrevious = this.#storage.getItem(PREVIOUS_KEY);
    } catch (error) {
      throw new Error(`本地保存失败，释放滚动撤销快照前无法复核存储：${safeDiagnosticMessage(error, "访问被拒绝")}`);
    }
    if (latestPrimary !== expectedPrimary) {
      this.refreshFromStorage();
      throw new Error("检测到另一个标签页在本次保存期间更新了数据；已停止释放滚动撤销快照。 ");
    }
    if (latestPrevious !== expectedPrevious) {
      throw new Error("检测到另一个标签页更新了滚动撤销快照；已保留该副本并停止配额重试。 ");
    }
    this.#assertWritePreconditions(expectedPrimary);
    let finalPrevious;
    try {
      finalPrevious = this.#storage.getItem(PREVIOUS_KEY);
    } catch (error) {
      throw new Error(`本地保存失败，释放滚动撤销快照前无法最终复核副本：${safeDiagnosticMessage(error, "访问被拒绝")}`);
    }
    if (finalPrevious !== expectedPrevious) {
      throw new Error("检测到另一个标签页更新了滚动撤销快照；已保留该副本并停止配额重试。 ");
    }
  }

  #rejectedPrimaryCanRecoverFrom(serializedPrimary, recoveryRaw) {
    if (typeof serializedPrimary !== "string") return false;
    try {
      parseSavedState(serializedPrimary, Date.now());
      const binding = this.#readPreviousBinding(serializedPrimary);
      return typeof binding === "string"
        && binding === checksumSerializedSnapshotData(recoveryRaw);
    } catch {
      const binding = this.#readRecoveryBinding(serializedPrimary, recoveryRaw);
      return binding === LEGACY_PREVIOUS_BINDING
        || (typeof binding === "string" && binding === checksumSerializedSnapshotData(recoveryRaw));
    }
  }

  #persistenceFailure(error, expectedOriginal) {
    let originalStillPresent = false;
    try {
      originalStillPresent = this.#storage.getItem(STORAGE_KEY) === expectedOriginal;
    } catch {
      // The conservative wording below asks the user to verify actual storage.
    }
    const prefix = originalStillPresent
      ? "本地保存失败，原数据仍然保留"
      : "本地保存未完成，请刷新核对实际存储状态";
    return new Error(`${prefix}：${safeDiagnosticMessage(error, "访问被拒绝")}`);
  }

  #savePreviousAfterCommit(current, serialized, expectedBinding, previousBeforeWrite, previousBeforeWriteKnown) {
    let previousWriteSucceeded = false;
    try {
      this.#renewWriteLock();
      this.#assertWritePreconditions(serialized);
      if (previousBeforeWriteKnown && this.#storage.getItem(PREVIOUS_KEY) !== previousBeforeWrite) {
        throw new Error("滚动撤销快照在写入前发生变化。 ");
      }
      this.#storage.setItem(PREVIOUS_KEY, current);
      previousWriteSucceeded = true;
    } catch {
      // The primary write already succeeded. Continue only with identity-checked
      // rollback repair, and never turn a cleanup failure into a false save failure.
    }
    if (previousWriteSucceeded) {
      this.#verifyAcceptedPrevious(serialized, current, expectedBinding);
      return;
    }

    let primaryStillCurrent = false;
    try {
      if (!this.#ensureRecoveryWriteLock()) {
        throw new Error("确认已提交主数据前无法重新取得写入租约。 ");
      }
      this.#assertWriteLock();
      primaryStillCurrent = this.#storage.getItem(STORAGE_KEY) === serialized
        && this.#storage.getItem(PREVIOUS_BINDING_KEY) === expectedBinding
        && this.#storage.getItem(PREVIOUS_BINDING_FORMAT_KEY) === PREVIOUS_BINDING_FORMAT;
    } catch {
      // Verification below keeps its existing fail-safe behavior for denied reads.
    }
    if (!primaryStillCurrent) {
      this.#restoreRejectedPrimaryRecovery(serialized, current);
      this.#markPreviousUnavailable(null);
      try {
        this.#verifyPrimaryWrite(serialized);
      } catch (error) {
        if (error?.[ADOPTED_EXTERNAL_REPLACEMENT] && this.#currentPrimaryDeclaresNoPrevious()) {
          this.#discardPreviousAfterPrimaryDisplacement(serialized, current);
        }
        throw error;
      }
      this.#addNotice("本次主数据已保存，但滚动撤销快照不可用；已屏蔽无法确认的旧副本，避免它冒充上一次保存。请尽快导出完整备份。 ");
      return;
    }

    let observedPrevious;
    let observedPreviousKnown = false;
    try {
      observedPrevious = this.#storage.getItem(PREVIOUS_KEY);
      observedPreviousKnown = true;
    } catch {
      // Preserve the last known identity and block it in memory if access returns.
    }
    if (observedPreviousKnown && observedPrevious === current) {
      this.#verifyAcceptedPrevious(serialized, current, expectedBinding);
      return;
    }

    let reclaimed = false;
    let cleanupRemovalAttempted = false;
    let cleanupRecreationAttempted = false;
    if (observedPreviousKnown && previousBeforeWriteKnown && observedPrevious === previousBeforeWrite) {
      try {
        this.#renewWriteLock();
        this.#assertWriteLock();
        const latestPrimary = this.#storage.getItem(STORAGE_KEY);
        const latestPrevious = this.#storage.getItem(PREVIOUS_KEY);
        if (latestPrimary === serialized && latestPrevious === previousBeforeWrite) {
          if (!this.#ensureRecoveryWriteLock()) {
            throw new Error("清理滚动撤销快照前无法重新取得写入租约。 ");
          }
          if (this.#storage.getItem(STORAGE_KEY) !== serialized
            || this.#storage.getItem(PREVIOUS_KEY) !== previousBeforeWrite) {
            throw new Error("清理滚动撤销快照前存储事实已变化。 ");
          }
          cleanupRemovalAttempted = true;
          this.#storage.removeItem(PREVIOUS_KEY);
          reclaimed = this.#storage.getItem(PREVIOUS_KEY) === null;
        } else {
          observedPrevious = latestPrevious;
        }
      } catch {
        // A failed cleanup leaves the known raw value blocked below.
      }
    }
    if (!reclaimed && cleanupRemovalAttempted) {
      try {
        if (this.#ensureRecoveryWriteLock()
          && this.#storage.getItem(STORAGE_KEY) === serialized
          && this.#storage.getItem(PREVIOUS_KEY) === null
          && this.#storage.getItem(PREVIOUS_BINDING_KEY) === expectedBinding
          && this.#storage.getItem(PREVIOUS_BINDING_FORMAT_KEY) === PREVIOUS_BINDING_FORMAT) {
          reclaimed = true;
        }
      } catch {
        // A committed removal is recognized only from exact renewed facts.
      }
    }
    if (reclaimed) {
      try {
        if (!this.#ensureRecoveryWriteLock()) {
          throw new Error("重建滚动撤销快照前无法重新取得写入租约。 ");
        }
        this.#assertWriteLock();
        const recreationPrimary = this.#storage.getItem(STORAGE_KEY);
        const recreationPrevious = this.#storage.getItem(PREVIOUS_KEY);
        if (recreationPrimary === serialized
          && recreationPrevious === null
          && this.#storage.getItem(PREVIOUS_BINDING_KEY) === expectedBinding
          && this.#storage.getItem(PREVIOUS_BINDING_FORMAT_KEY) === PREVIOUS_BINDING_FORMAT) {
          if (!this.#ensureRecoveryWriteLock()) {
            throw new Error("重建滚动撤销快照前无法重新取得写入租约。 ");
          }
          if (this.#storage.getItem(STORAGE_KEY) !== serialized
            || this.#storage.getItem(PREVIOUS_KEY) !== null
            || this.#storage.getItem(PREVIOUS_BINDING_KEY) !== expectedBinding
            || this.#storage.getItem(PREVIOUS_BINDING_FORMAT_KEY) !== PREVIOUS_BINDING_FORMAT) {
            throw new Error("重建滚动撤销快照前存储事实已变化。 ");
          }
          cleanupRecreationAttempted = true;
          this.#storage.setItem(PREVIOUS_KEY, current);
        }
      } catch {
        // A missing copy is safe; a stale copy is not. Re-read before deciding.
      }
      try {
        observedPrevious = this.#storage.getItem(PREVIOUS_KEY);
        observedPreviousKnown = true;
      } catch {
        observedPreviousKnown = false;
      }
      if (observedPreviousKnown && observedPrevious === current) {
        this.#verifyAcceptedPrevious(serialized, current, expectedBinding);
        return;
      }
    }

    if (!observedPreviousKnown || observedPrevious !== current) {
      this.#restoreRejectedPrimaryRecovery(serialized, current);
      try {
        observedPrevious = this.#storage.getItem(PREVIOUS_KEY);
        observedPreviousKnown = true;
      } catch {
        observedPreviousKnown = false;
      }
    }

    const rejectedRaw = observedPreviousKnown
      ? observedPrevious
      : previousBeforeWriteKnown
        ? previousBeforeWrite
        : null;
    this.#markPreviousUnavailable(rejectedRaw);
    try {
      this.#verifyPrimaryWrite(serialized);
    } catch (error) {
      if (error?.[ADOPTED_EXTERNAL_REPLACEMENT]) {
        if (cleanupRemovalAttempted) {
          this.#repairDisplacedWinnerRollback(current, serialized, null, [expectedBinding]);
        }
        if (cleanupRecreationAttempted) {
          this.#repairDisplacedWinnerRollback(current, serialized, current, [expectedBinding]);
        }
      }
      throw error;
    }
    this.#addNotice("本次主数据已保存，但滚动撤销快照不可用；已清理或屏蔽无法确认的旧副本，避免它冒充上一次保存。请尽快导出完整备份。 ");
  }

  #restoreRejectedPrimaryRecovery(expectedLocalPrimary, confirmedRaw) {
    let recoveryWriteAttempted = false;
    try {
      if (!this.#ensureRecoveryWriteLock()) return false;
      this.#assertWriteLock();
      const rejectedPrimary = this.#storage.getItem(STORAGE_KEY);
      if (rejectedPrimary === expectedLocalPrimary
        || this.#storage.getItem(PREVIOUS_KEY) !== null
        || !this.#rejectedPrimaryCanRecoverFrom(rejectedPrimary, confirmedRaw)) return false;
      this.#assertWriteLock();
      if (this.#storage.getItem(STORAGE_KEY) !== rejectedPrimary
        || this.#storage.getItem(PREVIOUS_KEY) !== null) return false;
      this.#renewWriteLock();
      if (this.#storage.getItem(STORAGE_KEY) !== rejectedPrimary
        || this.#storage.getItem(PREVIOUS_KEY) !== null) return false;
      recoveryWriteAttempted = true;
      this.#storage.setItem(PREVIOUS_KEY, confirmedRaw);
      const restored = this.#storage.getItem(STORAGE_KEY) === rejectedPrimary
        && this.#storage.getItem(PREVIOUS_KEY) === confirmedRaw;
      if (!restored) {
        this.#repairDisplacedWinnerRollback(
          confirmedRaw,
          expectedLocalPrimary,
          confirmedRaw,
          []
        );
      }
      return restored;
    } catch {
      if (recoveryWriteAttempted) {
        this.#repairDisplacedWinnerRollback(
          confirmedRaw,
          expectedLocalPrimary,
          confirmedRaw,
          []
        );
      }
      return false;
    }
  }

  #restorePreviousProvenance(expectedPrimary, ownedBindingRaws, original, attempt) {
    try {
      this.#renewWriteLock();
      if (this.#storage.getItem(STORAGE_KEY) !== expectedPrimary
        || this.#storage.getItem(PREVIOUS_KEY) !== null) return false;
      const latestBinding = this.#storage.getItem(PREVIOUS_BINDING_KEY);
      const latestFormat = this.#storage.getItem(PREVIOUS_BINDING_FORMAT_KEY);
      if (!ownedBindingRaws.includes(latestBinding)
        || (latestFormat !== PREVIOUS_BINDING_FORMAT && latestFormat !== original.format)) return false;
      if (!this.#ensureRecoveryWriteLock()) return false;
      if (this.#storage.getItem(STORAGE_KEY) !== expectedPrimary
        || this.#storage.getItem(PREVIOUS_KEY) !== null
        || this.#storage.getItem(PREVIOUS_BINDING_KEY) !== latestBinding
        || this.#storage.getItem(PREVIOUS_BINDING_FORMAT_KEY) !== latestFormat) return false;
      try {
        attempt.formatMutationAttempted = true;
        if (original.format === null) this.#storage.removeItem(PREVIOUS_BINDING_FORMAT_KEY);
        else this.#storage.setItem(PREVIOUS_BINDING_FORMAT_KEY, original.format);
      } catch {
        // A storage mutation can commit before reporting failure; verify facts below.
      }
      if (this.#storage.getItem(STORAGE_KEY) !== expectedPrimary
        || this.#storage.getItem(PREVIOUS_KEY) !== null
        || this.#storage.getItem(PREVIOUS_BINDING_FORMAT_KEY) !== original.format
        || this.#storage.getItem(PREVIOUS_BINDING_KEY) !== latestBinding) return false;
      if (!this.#ensureRecoveryWriteLock()) return false;
      if (this.#storage.getItem(STORAGE_KEY) !== expectedPrimary
        || this.#storage.getItem(PREVIOUS_KEY) !== null
        || this.#storage.getItem(PREVIOUS_BINDING_FORMAT_KEY) !== original.format
        || this.#storage.getItem(PREVIOUS_BINDING_KEY) !== latestBinding) return false;
      try {
        attempt.bindingMutationAttempted = true;
        if (original.serialized === null) this.#storage.removeItem(PREVIOUS_BINDING_KEY);
        else this.#storage.setItem(PREVIOUS_BINDING_KEY, original.serialized);
      } catch {
        // Verify commit-then-throw behavior below before deciding restoration failed.
      }
      if (this.#storage.getItem(STORAGE_KEY) !== expectedPrimary
        || this.#storage.getItem(PREVIOUS_KEY) !== null
        || this.#storage.getItem(PREVIOUS_BINDING_KEY) !== original.serialized
        || this.#storage.getItem(PREVIOUS_BINDING_FORMAT_KEY) !== original.format) return false;
      if (!this.#ensureRecoveryWriteLock()) return false;
      return this.#storage.getItem(STORAGE_KEY) === expectedPrimary
        && this.#storage.getItem(PREVIOUS_KEY) === null
        && this.#storage.getItem(PREVIOUS_BINDING_KEY) === original.serialized
        && this.#storage.getItem(PREVIOUS_BINDING_FORMAT_KEY) === original.format;
    } catch {
      return false;
    }
  }

  #repairDisplacedWinnerFormat(expectedOriginal, localCandidate, ownedFormat) {
    try {
      if (ownedFormat === PREVIOUS_BINDING_FORMAT) return false;
      const observedWinner = this.#storage.getItem(STORAGE_KEY);
      if (typeof observedWinner !== "string"
        || observedWinner === expectedOriginal
        || observedWinner === localCandidate) return false;
      if (!this.#ensureRecoveryWriteLock()) return false;
      const winnerRaw = this.#storage.getItem(STORAGE_KEY);
      const previousRaw = this.#storage.getItem(PREVIOUS_KEY);
      const bindingRaw = this.#storage.getItem(PREVIOUS_BINDING_KEY);
      const format = this.#storage.getItem(PREVIOUS_BINDING_FORMAT_KEY);
      if (winnerRaw !== observedWinner || format !== ownedFormat) return false;
      parseSavedState(winnerRaw, Date.now());
      const expectedPrevious = parsePreviousBinding(PREVIOUS_BINDING_FORMAT, bindingRaw, winnerRaw);
      const previousMatches = expectedPrevious === null
        ? previousRaw === null
        : typeof expectedPrevious === "string"
          && typeof previousRaw === "string"
          && checksumSerializedSnapshotData(previousRaw) === expectedPrevious;
      if (!previousMatches) return false;
      if (typeof previousRaw === "string") parseSavedState(previousRaw, Date.now());
      this.#renewWriteLock();
      if (this.#storage.getItem(STORAGE_KEY) !== winnerRaw
        || this.#storage.getItem(PREVIOUS_KEY) !== previousRaw
        || this.#storage.getItem(PREVIOUS_BINDING_KEY) !== bindingRaw
        || this.#storage.getItem(PREVIOUS_BINDING_FORMAT_KEY) !== format) return false;
      this.#storage.setItem(PREVIOUS_BINDING_FORMAT_KEY, PREVIOUS_BINDING_FORMAT);
      return this.#storage.getItem(STORAGE_KEY) === winnerRaw
        && this.#storage.getItem(PREVIOUS_KEY) === previousRaw
        && this.#storage.getItem(PREVIOUS_BINDING_KEY) === bindingRaw
        && this.#storage.getItem(PREVIOUS_BINDING_FORMAT_KEY) === PREVIOUS_BINDING_FORMAT;
    } catch {
      return false;
    }
  }

  #repairDisplacedWinnerRollback(
    expectedOriginal,
    localCandidate,
    ownedPrevious,
    ownedBindingRaws,
    previousBeforeWrite = undefined
  ) {
    try {
      const observedWinner = this.#storage.getItem(STORAGE_KEY);
      if (typeof observedWinner !== "string"
        || observedWinner === expectedOriginal
        || observedWinner === localCandidate) return false;
      const localCandidateChecksum = checksumSerializedSnapshotData(localCandidate);
      if (!this.#ensureRecoveryWriteLock()) return false;
      const winnerRaw = this.#storage.getItem(STORAGE_KEY);
      const previousRaw = this.#storage.getItem(PREVIOUS_KEY);
      const bindingRaw = this.#storage.getItem(PREVIOUS_BINDING_KEY);
      const format = this.#storage.getItem(PREVIOUS_BINDING_FORMAT_KEY);
      if (typeof winnerRaw !== "string"
        || winnerRaw === expectedOriginal
        || winnerRaw === localCandidate) return false;
      const winner = parseSavedState(winnerRaw, Date.now());

      const winnerBinding = parsePreviousBinding(format, bindingRaw, winnerRaw);
      if (typeof winnerBinding === "string"
        && previousRaw === ownedPrevious
        && localCandidateChecksum === winnerBinding) {
        parseSavedState(localCandidate, Date.now());
        this.#renewWriteLock();
        if (this.#storage.getItem(STORAGE_KEY) !== winnerRaw
          || this.#storage.getItem(PREVIOUS_KEY) !== previousRaw
          || this.#storage.getItem(PREVIOUS_BINDING_KEY) !== bindingRaw
          || this.#storage.getItem(PREVIOUS_BINDING_FORMAT_KEY) !== format) return false;
        this.#storage.setItem(PREVIOUS_KEY, localCandidate);
        return this.#storage.getItem(STORAGE_KEY) === winnerRaw
          && this.#storage.getItem(PREVIOUS_KEY) === localCandidate
          && this.#storage.getItem(PREVIOUS_BINDING_KEY) === bindingRaw
          && this.#storage.getItem(PREVIOUS_BINDING_FORMAT_KEY) === format;
      }

      if (winnerBinding !== INVALID_PREVIOUS_BINDING
        || previousRaw !== expectedOriginal
        || previousBeforeWrite === undefined
        || previousRaw === previousBeforeWrite
        || format !== PREVIOUS_BINDING_FORMAT
        || !ownedBindingRaws.includes(bindingRaw)) return false;
      const previous = parseSavedState(previousRaw, Date.now());
      if (winner.meta.revision !== previous.meta.revision + 1
        || Date.parse(winner.meta.updatedAt) < Date.parse(previous.meta.updatedAt)) return false;
      const repairedBinding = serializePreviousBinding(null, null, winnerRaw, previousRaw);
      this.#renewWriteLock();
      if (this.#storage.getItem(STORAGE_KEY) !== winnerRaw
        || this.#storage.getItem(PREVIOUS_KEY) !== previousRaw
        || this.#storage.getItem(PREVIOUS_BINDING_KEY) !== bindingRaw
        || this.#storage.getItem(PREVIOUS_BINDING_FORMAT_KEY) !== format) return false;
      this.#writePreviousBinding(repairedBinding);
      return this.#storage.getItem(STORAGE_KEY) === winnerRaw
        && this.#storage.getItem(PREVIOUS_KEY) === previousRaw
        && this.#storage.getItem(PREVIOUS_BINDING_KEY) === repairedBinding
        && this.#storage.getItem(PREVIOUS_BINDING_FORMAT_KEY) === PREVIOUS_BINDING_FORMAT;
    } catch {
      return false;
    }
  }

  #verifyAcceptedPrevious(expectedPrimary, acceptedPrevious, expectedBinding) {
    this.#markPreviousUnavailable(acceptedPrevious);
    try {
      if (this.#verifyAcceptedBinding(expectedPrimary, expectedBinding, acceptedPrevious)) {
        this.#unavailablePreviousRaw = undefined;
      }
    } catch (error) {
      this.#restoreRejectedPrimaryRecovery(expectedPrimary, acceptedPrevious);
      if (error?.[ADOPTED_EXTERNAL_REPLACEMENT]) {
        this.#repairDisplacedWinnerRollback(
          acceptedPrevious,
          expectedPrimary,
          acceptedPrevious,
          [expectedBinding]
        );
      }
      if (error?.[ADOPTED_EXTERNAL_REPLACEMENT] && this.#currentPrimaryDeclaresNoPrevious()) {
        this.#discardPreviousAfterPrimaryDisplacement(expectedPrimary, acceptedPrevious);
      }
      throw error;
    }
  }

  #currentPrimaryDeclaresNoPrevious() {
    return this.#persistedRaw !== null && this.#readPreviousBinding(this.#persistedRaw) === null;
  }

  #discardPreviousAfterPrimaryDisplacement(expectedPrimary, localPrevious) {
    let displacedPrimary = null;
    let removalAttempted = false;
    try {
      this.#renewWriteLock();
      this.#assertWriteLock();
      const observedPrimary = this.#storage.getItem(STORAGE_KEY);
      const observedPrevious = this.#storage.getItem(PREVIOUS_KEY);
      if (observedPrimary === expectedPrimary || observedPrevious !== localPrevious) return;
      displacedPrimary = observedPrimary;
      this.#assertWriteLock();
      if (this.#storage.getItem(STORAGE_KEY) === displacedPrimary
        && this.#storage.getItem(PREVIOUS_KEY) === localPrevious) {
        this.#renewWriteLock();
        const finalPrimary = this.#storage.getItem(STORAGE_KEY);
        const finalPrevious = this.#storage.getItem(PREVIOUS_KEY);
        if (finalPrimary !== displacedPrimary || finalPrevious !== localPrevious) return;
        if (!this.#ensureRecoveryWriteLock()) return;
        if (this.#storage.getItem(STORAGE_KEY) !== displacedPrimary
          || this.#storage.getItem(PREVIOUS_KEY) !== localPrevious) return;
        removalAttempted = true;
        this.#storage.removeItem(PREVIOUS_KEY);
      }
    } catch {
      // Web Storage has no compare-and-swap. The in-memory marker still blocks
      // the local copy when an identity-checked cleanup cannot be completed.
    }
    if (removalAttempted && typeof displacedPrimary === "string") {
      this.#repairDisplacedWinnerRollback(
        expectedPrimary,
        displacedPrimary,
        null,
        []
      );
    }
  }

  #markPreviousUnavailable(raw) {
    this.#unavailablePreviousRaw = typeof raw === "string" ? raw : null;
  }

  #acquireWriteLock(now = Date.now()) {
    const owner = makeId("lease");
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
      throw new Error(`本地保存失败，无法取得安全写入租约：${safeDiagnosticMessage(error, "访问被拒绝")}`);
    }
    this.#activeWriteLock = token;
    return () => {
      const activeToken = this.#activeWriteLock;
      const activeLease = parseWriteLock(activeToken);
      try {
        if (activeLease?.owner === owner
          && isSafelyReleasableWriteLock(activeToken, Date.now())
          && this.#storage.getItem(WRITE_LOCK_KEY) === activeToken
          && isSafelyReleasableWriteLock(activeToken, Date.now())) {
          this.#storage.removeItem(WRITE_LOCK_KEY);
        }
      } catch {
        // The short lease expires on its own; never misreport an already committed write.
      } finally {
        if (parseWriteLock(this.#activeWriteLock)?.owner === owner) this.#activeWriteLock = null;
      }
    };
  }

  #ensureRecoveryWriteLock(now = Date.now()) {
    try {
      this.#renewWriteLock(now);
      return true;
    } catch {
      // An expired owner may only reacquire for fact-checked rollback repair.
    }
    const owner = parseWriteLock(this.#activeWriteLock)?.owner ?? makeId("lease-recovery");
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const recoveryNow = Date.now();
      const token = JSON.stringify({ owner, expiresAt: recoveryNow + WRITE_LOCK_TTL_MS });
      let tokenWriteAttempted = false;
      try {
        const existing = this.#storage.getItem(WRITE_LOCK_KEY);
        const existingNow = Date.now();
        if (isActiveWriteLock(existing, existingNow)) {
          if (parseWriteLock(existing)?.owner !== owner) return false;
          this.#activeWriteLock = existing;
          if (isSafelyReleasableWriteLock(existing, existingNow)) return true;
        }
        tokenWriteAttempted = true;
        this.#storage.setItem(WRITE_LOCK_KEY, token);
        if (this.#storage.getItem(WRITE_LOCK_KEY) === token
          && isSafelyReleasableWriteLock(token, Date.now())) {
          this.#activeWriteLock = token;
          return true;
        }
      } catch {
        if (tokenWriteAttempted) {
          try {
            if (this.#storage.getItem(WRITE_LOCK_KEY) === token
              && isSafelyReleasableWriteLock(token, Date.now())) {
              this.#activeWriteLock = token;
              return true;
            }
          } catch {
            // Retry once with a freshly timed token before failing closed.
          }
        }
      }
    }
    return false;
  }

  #renewWriteLock(now = Date.now()) {
    let persistedLock;
    let currentLease;
    try {
      persistedLock = this.#storage.getItem(WRITE_LOCK_KEY);
      currentLease = JSON.parse(this.#activeWriteLock);
    } catch (error) {
      throw new Error(`本地保存失败，无法续期安全写入租约：${safeDiagnosticMessage(error, "访问被拒绝")}`);
    }
    if (!this.#activeWriteLock
      || persistedLock !== this.#activeWriteLock
      || typeof currentLease?.owner !== "string"
      || !Number.isFinite(currentLease.expiresAt)
      || currentLease.expiresAt - now <= WRITE_LOCK_RENEWAL_MARGIN_MS
      || currentLease.expiresAt > now + WRITE_LOCK_TTL_MS) {
      throw new Error("另一个标签页同时取得了保存权，请立即重试。 ");
    }
    const renewedToken = JSON.stringify({
      owner: currentLease.owner,
      expiresAt: now + WRITE_LOCK_TTL_MS
    });
    try {
      this.#storage.setItem(WRITE_LOCK_KEY, renewedToken);
      if (this.#storage.getItem(WRITE_LOCK_KEY) !== renewedToken
        || !isSafelyReleasableWriteLock(renewedToken, Date.now())) {
        throw new Error("另一个标签页同时取得了保存权，请立即重试。 ");
      }
    } catch (error) {
      try {
        if (this.#storage.getItem(WRITE_LOCK_KEY) === renewedToken
          && isSafelyReleasableWriteLock(renewedToken, Date.now())) {
          this.#activeWriteLock = renewedToken;
          return;
        }
      } catch {
        // Fall through to the stable renewal diagnostic below.
      }
      if (/另一个标签页/u.test(error?.message ?? "")) throw error;
      throw new Error(`本地保存失败，无法续期安全写入租约：${safeDiagnosticMessage(error, "访问被拒绝")}`);
    }
    this.#activeWriteLock = renewedToken;
  }

  #assertWriteLock() {
    const persistedLock = this.#storage.getItem(WRITE_LOCK_KEY);
    if (!this.#activeWriteLock
      || persistedLock !== this.#activeWriteLock
      || !isActiveWriteLock(persistedLock, Date.now())) {
      throw new Error("另一个标签页同时取得了保存权，请立即重试。 ");
    }
  }

  #assertWritePreconditions(expectedCurrent) {
    this.#assertWriteLock();
    let latest;
    try {
      latest = this.#storage.getItem(STORAGE_KEY);
    } catch (error) {
      throw new Error(`本地保存失败，提交前无法复核现有数据：${safeDiagnosticMessage(error, "访问被拒绝")}`);
    }
    if (latest === expectedCurrent) return;
    this.refreshFromStorage();
    throw new Error("检测到另一个标签页在本次保存期间更新了数据；已阻止覆盖，请重试刚才的操作。 ");
  }

  #verifyPrimaryWrite(expected) {
    let latest;
    try {
      latest = this.#storage.getItem(STORAGE_KEY);
    } catch (error) {
      this.#addNotice(`本地数据已写入，但无法立即复核提交结果：${safeDiagnosticMessage(error, "访问被拒绝")}`);
      return;
    }
    if (latest === expected) return;
    const adopted = this.refreshFromStorage();
    const error = new Error(adopted
      ? "检测到另一个标签页在本次保存完成时替换了数据；已采用外部更新，请重试刚才的操作。 "
      : "检测到本次保存的主数据未保留；本页仍保持最后确认的状态，请重试并刷新核对实际存储。 ");
    error[ADOPTED_EXTERNAL_REPLACEMENT] = adopted;
    throw error;
  }

  #emit(source = "local") {
    const event = Object.freeze({ source });
    for (const listener of [...this.#listeners]) {
      try {
        listener(this.#state, event);
      } catch (error) {
        if (this.#failedListeners.has(listener)) continue;
        this.#failedListeners.add(listener);
        this.#addNotice(`工作区状态已处理，但一个界面订阅未能响应：${safeDiagnosticMessage(error, "访问被拒绝")}`);
      }
    }
  }
}

const ADOPTED_EXTERNAL_REPLACEMENT = Symbol("adopted-external-replacement");

function parsePreviousBinding(format, serialized, primaryRaw) {
  const entries = parsePreviousBindingEntries(format, serialized);
  if (!Array.isArray(entries)) return entries;
  if (typeof primaryRaw !== "string") return INVALID_PREVIOUS_BINDING;
  const primaryChecksum = checksumSerializedSnapshotData(primaryRaw);
  const entry = entries.find((candidate) => candidate.primaryChecksum === primaryChecksum);
  if (!entry) return INVALID_PREVIOUS_BINDING;
  return entry.previousChecksum === LEGACY_PREVIOUS_BINDING_VALUE
    ? LEGACY_PREVIOUS_BINDING
    : entry.previousChecksum;
}

function parseRecoveryPreviousBinding(format, serialized, previousRaw) {
  const entries = parsePreviousBindingEntries(format, serialized);
  if (!Array.isArray(entries)) return entries;
  if (typeof previousRaw !== "string") return INVALID_PREVIOUS_BINDING;
  const previousChecksum = checksumSerializedSnapshotData(previousRaw);
  let previousMatches = 0;
  let primaryMatches = 0;
  for (const entry of entries) {
    if (entry.previousChecksum === previousChecksum) previousMatches += 1;
    if (entry.primaryChecksum === previousChecksum) primaryMatches += 1;
  }
  return previousMatches >= 1 || (previousMatches === 0 && primaryMatches === 1)
    ? previousChecksum
    : INVALID_PREVIOUS_BINDING;
}

function parsePreviousBindingEntries(format, serialized) {
  if (format === null && serialized === null) return LEGACY_PREVIOUS_BINDING;
  if ((format !== null && format !== PREVIOUS_BINDING_FORMAT) || typeof serialized !== "string") {
    return INVALID_PREVIOUS_BINDING;
  }
  try {
    const ledger = JSON.parse(serialized);
    if (!isExactRecord(ledger, ["entries"]) || !Array.isArray(ledger.entries)
      || ledger.entries.length < 1 || ledger.entries.length > 2) {
      return INVALID_PREVIOUS_BINDING;
    }
    const seen = new Set();
    for (const entry of ledger.entries) {
      if (!isExactRecord(entry, ["primaryChecksum", "previousChecksum"])
        || !isCanonicalSnapshotChecksum(entry.primaryChecksum)
        || !(entry.previousChecksum === null
          || entry.previousChecksum === LEGACY_PREVIOUS_BINDING_VALUE
          || isCanonicalSnapshotChecksum(entry.previousChecksum))
        || seen.has(entry.primaryChecksum)) {
        return INVALID_PREVIOUS_BINDING;
      }
      seen.add(entry.primaryChecksum);
    }
    return ledger.entries;
  } catch {
    return INVALID_PREVIOUS_BINDING;
  }
}

function serializePreviousBinding(currentRaw, currentBinding, nextRaw, nextPreviousRaw) {
  const nextChecksum = checksumSerializedSnapshotData(nextRaw);
  const entries = [];
  if (typeof currentRaw === "string") {
    const currentChecksum = checksumSerializedSnapshotData(currentRaw);
    if (currentChecksum === nextChecksum && currentRaw !== nextRaw) {
      throw new Error("滚动撤销快照的来源校验发生冲突，已停止本次保存。 ");
    }
    if (currentChecksum !== nextChecksum) {
      entries.push({
        primaryChecksum: currentChecksum,
        previousChecksum: currentBinding === LEGACY_PREVIOUS_BINDING
          ? LEGACY_PREVIOUS_BINDING_VALUE
          : typeof currentBinding === "string" || currentBinding === null
            ? currentBinding
            : null
      });
    }
  }
  entries.push({
    primaryChecksum: nextChecksum,
    previousChecksum: typeof nextPreviousRaw === "string"
      ? checksumSerializedSnapshotData(nextPreviousRaw)
      : null
  });
  return JSON.stringify({ entries });
}

function isExactRecord(value, fields) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.length === fields.length && fields.every((field) => Object.prototype.hasOwnProperty.call(value, field));
}

function nextSafeRevision(...revisions) {
  let highest = -1;
  for (const revision of revisions) {
    if (!Number.isSafeInteger(revision) || revision < 0) {
      throw new Error("修订号无效，无法安全提交这次操作。 ");
    }
    if (revision > highest) highest = revision;
  }
  if (highest < 0) throw new Error("缺少可用修订号，无法安全提交这次操作。 ");
  if (highest === Number.MAX_SAFE_INTEGER) {
    throw new Error("当前修订号已达到安全上限，无法安全提交这次操作。请先导出完整备份。 ");
  }
  return highest + 1;
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

function parseWriteLock(raw) {
  if (typeof raw !== "string" || !raw) return null;
  try {
    const value = JSON.parse(raw);
    return typeof value?.owner === "string"
      && value.owner.length > 0
      && Number.isFinite(value.expiresAt)
      ? value
      : null;
  } catch {
    return null;
  }
}

function isActiveWriteLock(raw, now) {
  const value = parseWriteLock(raw);
  return value !== null
    && value.expiresAt > now
    && value.expiresAt <= now + WRITE_LOCK_TTL_MS;
}

function isSafelyReleasableWriteLock(raw, now) {
  const value = parseWriteLock(raw);
  return value !== null
    && value.expiresAt - now > WRITE_LOCK_RENEWAL_MARGIN_MS
    && value.expiresAt <= now + WRITE_LOCK_TTL_MS;
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
  if (!storage || typeof storage.key !== "function" || typeof storage.getItem !== "function") return unavailable;
  if (!Number.isSafeInteger(referenceBytes) || referenceBytes <= 0) return unavailable;
  try {
    const entryCount = storage.length;
    if (!Number.isSafeInteger(entryCount) || entryCount < 0 || entryCount > STORAGE_ENTRY_SCAN_LIMIT) return unavailable;
    let appBytes = 0;
    let totalBytes = 0;
    for (let index = 0; index < entryCount; index += 1) {
      const key = storage.key(index);
      if (typeof key !== "string") continue;
      const value = storage.getItem(key);
      if (value === null) continue;
      if (typeof value !== "string") return unavailable;
      const bytes = (key.length + value.length) * 2;
      if (!Number.isSafeInteger(bytes) || !Number.isSafeInteger(totalBytes + bytes)) return unavailable;
      totalBytes += bytes;
      if (key.startsWith("reentry-deck/")) {
        if (!Number.isSafeInteger(appBytes + bytes)) return unavailable;
        appBytes += bytes;
      }
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
