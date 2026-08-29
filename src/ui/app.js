import {
  IMPORT_LIMITS,
  compactText,
  containsUnsafeIdControl,
  createCheckpoint,
  createCrumb,
  createProject,
  createSession,
  isoAtOrAfter
} from "../core/model.js";
import { QUICK_CAPTURE_QUERY_LIMIT, buildQuickCaptureProjectWindow, prepareQuickCapture, projectNextActionFromCrumb } from "../core/capture.js";
import { createLatestRequestGate, readBackupFile } from "../core/backup-file.js";
import { triggerBlobDownload } from "../core/download.js";
import { safeDiagnosticMessage } from "../core/diagnostic.js";
import { buildWorkspaceCounts, buildWorkspaceFrame, buildWorkspaceOverview } from "../core/insights.js";
import { buildReentryCard, buildReentryCards, buildReentryCardWithStats, prepareProjectArchive, prepareProjectEdit, prepareProjectRestore, prepareProjectStatusChange, prepareProjectTemplate, prepareSessionDialog, prepareSessionStart } from "../core/reentry.js";
import { WORKSPACE_HANDOFF_PROJECT_LIMIT, buildReentryBrief, buildWorkspaceHandoff, copyPlainText } from "../core/share.js";
import { SEARCH_QUERY_LIMIT, buildWorkspaceSearchIndex, getProjectResources, searchWorkspaceIndexWindow } from "../core/search.js";
import { QUICK_DOCK_NOT_RECORDED, inspectSession, locateActiveSessionContext, prepareQuickCheckpointReview, prepareQuickDock } from "../core/session.js";
import { STORAGE_DURABILITY_STATUS, inspectPersistentStorage, requestPersistentStorage } from "../core/storage-durability.js";
import { STORE_NOTICE_LIMIT } from "../core/store.js";
import {
  COLLECTION_PAGE_SIZE,
  TIMELINE_PAGE_SIZE,
  buildCollectionWindow,
  buildProjectCollectionWindow,
  buildTimelineWindow
} from "../core/timeline.js";
import { elapsedSeconds, formatDateTime, formatDuration, formatRelative } from "../core/time.js";

const PROJECT_STATUS_LABELS = {
  active: "推进中",
  paused: "暂泊",
  blocked: "受阻",
  archived: "已归档"
};

const CRUMB_LABELS = {
  note: "随记",
  discovery: "发现",
  decision: "决定",
  question: "问题",
  blocker: "阻塞",
  next: "下一步"
};

const COLOR_LABELS = {
  fern: "松绿",
  amber: "琥珀",
  clay: "陶土",
  sky: "雾蓝",
  plum: "梅紫",
  slate: "岩灰"
};

const MAX_VISIBLE_TOASTS = 4;
const STORAGE_DURABILITY_DETAILS = Object.freeze({
  checking: Object.freeze({ message: "正在检查浏览器是否已保护当前来源；不会弹出权限请求。", action: "正在检查" }),
  [STORAGE_DURABILITY_STATUS.GRANTED]: Object.freeze({ message: "浏览器已确认对当前来源使用持久存储保护。", action: "已受保护" }),
  [STORAGE_DURABILITY_STATUS.DENIED]: Object.freeze({ message: "浏览器尚未授予持久保护；请定期导出 JSON 备份。", action: "重新请求保护" }),
  [STORAGE_DURABILITY_STATUS.UNKNOWN]: Object.freeze({ message: "浏览器无法自动确认保护状态；仍可主动请求，并请保留 JSON 备份。", action: "主动请求保护" }),
  [STORAGE_DURABILITY_STATUS.UNSUPPORTED]: Object.freeze({ message: "当前浏览器不支持持久存储请求；请依靠 JSON 备份恢复。", action: "浏览器不支持" }),
  [STORAGE_DURABILITY_STATUS.ERROR]: Object.freeze({ message: "无法检查浏览器保护状态；请稍后重试并保留 JSON 备份。", action: "重新检查" })
});
const MAX_TOAST_MESSAGE_LENGTH = 500;
const MAX_REMEMBERED_TIMELINES = 24;
export const MAX_TRANSIENT_CONTROL_VALUE_LENGTH = 2_400;

export function boundTransientControlValue(value, maxLength = -1) {
  const declaredLimit = Number.isSafeInteger(maxLength) && maxLength >= 0
    ? maxLength
    : MAX_TRANSIENT_CONTROL_VALUE_LENGTH;
  const text = String(value ?? "");
  const limit = Math.min(declaredLimit, MAX_TRANSIENT_CONTROL_VALUE_LENGTH);
  const bounded = text.slice(0, limit);
  if (text.length <= limit || !bounded) return bounded;
  const last = bounded.charCodeAt(bounded.length - 1);
  const next = text.charCodeAt(bounded.length);
  return last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff
    ? bounded.slice(0, -1)
    : bounded;
}

export function normalizeTransientSelection(value, start, end) {
  if (!Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(end) || end < 0) return null;
  const length = String(value ?? "").length;
  const first = Math.min(start, length);
  const second = Math.min(end, length);
  return first <= second ? [first, second] : [second, first];
}

export function resolveThemeAppearance(theme, prefersDark = false) {
  const dark = theme === "dark" || (theme === "system" && prefersDark);
  return Object.freeze({ dark, themeColor: dark ? "#111a19" : "#f4efe6" });
}

export function userFacingErrorMessage(error, fallback = "操作未完成，请根据最新状态重试。 ") {
  return safeDiagnosticMessage(error, fallback);
}

export const IMPORT_FILE_NAME_LIMIT = 160;

export function importFileLabel(file) {
  return compactText(file?.name, IMPORT_FILE_NAME_LIMIT) || "未命名备份.json";
}

const ICONS = {
  home: '<path d="m3 11 9-8 9 8"/><path d="M5 10v10h14V10M9 20v-6h6v6"/>',
  archive: '<path d="M4 7h16v13H4zM3 3h18v4H3zM9 11h6"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1a1.7 1.7 0 0 0 1.9.3A1.7 1.7 0 0 0 10 3v-.2h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1Z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  lock: '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
  arrow: '<path d="M5 12h14m-5-5 5 5-5 5"/>',
  play: '<path d="m8 5 11 7-11 7Z"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
  edit: '<path d="m4 20 4.2-1 10.9-10.9a2.1 2.1 0 0 0-3-3L5.2 16Z"/><path d="m14.8 6.4 3 3"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  spark: '<path d="m12 3 1.2 4.4L17 9l-3.8 1.6L12 15l-1.2-4.4L7 9l3.8-1.6ZM5 15l.7 2.3L8 18l-2.3.7L5 21l-.7-2.3L2 18l2.3-.7Z"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  compass: '<circle cx="12" cy="12" r="9"/><path d="m15 9-2 4-4 2 2-4Z"/>',
  trail: '<path d="M4 18c2-6 4-9 7-9s4 6 7 6c1.4 0 2.3-.8 3-2"/><circle cx="4" cy="18" r="1.5"/><circle cx="21" cy="13" r="1.5"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  download: '<path d="M12 3v12m-4-4 4 4 4-4M4 19h16"/>',
  upload: '<path d="M12 15V3m-4 4 4-4 4 4M4 19h16"/>',
  shield: '<path d="M12 3 5 6v5c0 4.7 2.8 8 7 10 4.2-2 7-5.3 7-10V6Z"/><path d="m9 12 2 2 4-4"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
  alert: '<path d="M12 3 2.8 20h18.4Z"/><path d="M12 9v4m0 3h.01"/>',
  pin: '<path d="m9 4 6 0 1 5 3 3v1H5v-1l3-3ZM12 13v8"/>',
  external: '<path d="M14 4h6v6M20 4l-9 9"/><path d="M18 13v6H5V6h6"/>',
  box: '<path d="M4 7 12 3l8 4v10l-8 4-8-4Z"/><path d="m4 7 8 4 8-4M12 11v10"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m16 16 5 5"/>',
  undo: '<path d="M9 7 4 12l5 5"/><path d="M5 12h8a6 6 0 0 1 6 6"/>',
  copy: '<rect x="8" y="8" width="11" height="11" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>'
};

export class ReentryApp {
  #root;
  #store;
  #timerId;
  #focusSelector = null;
  #workspaceCounts = null;
  #activeSession = null;
  #noticeQueue = [];
  #acknowledgedStaleSessionId = null;
  #pendingImport = null;
  #pendingProjectEdit = null;
  #newProjectTemplate = null;
  #pendingCheckpointSessionId = null;
  #importRequestGate = createLatestRequestGate();
  #importReadController = null;
  #clipboardRequestGate = createLatestRequestGate();
  #storageDurabilityRequestGate = createLatestRequestGate();
  #timelineLimits = new Map();
  #collectionLimits = new Map();
  #workspaceCreatedAt = null;
  #searchIndexState = null;
  #searchIndex = null;
  #toasts = [];
  #toastSequence = 0;
  #pendingArchiveId = null;
  #backupSizeState = null;
  #backupSizeLabel = "0 B";
  #storageDurabilityStatus = "checking";
  #eventController = new AbortController();
  #unsubscribeStore = null;
  #toastTimers = new Map();
  #colorSchemeQuery = null;
  #colorSchemeListener = null;
  #sessionHealthSignature = "none";
  #calendarDaySignature = "invalid";
  #renderSequence = 0;
  #destroyed = false;

  constructor(root, store) {
    this.#root = root;
    this.#store = store;
    try {
      this.#noticeQueue = store.drainNotices().slice(-STORE_NOTICE_LIMIT);
      const listenerOptions = { signal: this.#eventController.signal };

      this.#root.addEventListener("click", (event) => this.#runUserAction(() => this.#onClick(event)), listenerOptions);
      this.#root.addEventListener("submit", (event) => this.#onSubmit(event), listenerOptions);
      this.#root.addEventListener("change", (event) => this.#runUserAction(() => this.#onChange(event)), listenerOptions);
      this.#root.addEventListener("input", (event) => this.#onInput(event), listenerOptions);
      this.#root.addEventListener("cancel", (event) => {
        if (event.target.id === "import-preview-dialog") this.#pendingImport = null;
        if (event.target.id === "archive-confirm-dialog") this.#pendingArchiveId = null;
        if (event.target.id === "edit-project-dialog") this.#pendingProjectEdit = null;
        if (event.target.id === "new-project-dialog") this.#clearNewProjectTemplate(event.target);
        if (event.target.id === "checkpoint-dialog") this.#pendingCheckpointSessionId = null;
      }, { ...listenerOptions, capture: true });
      window.addEventListener("hashchange", () => {
        this.#focusSelector = "#main-content";
        this.render();
      }, listenerOptions);
      window.addEventListener("keydown", (event) => this.#runUserAction(() => this.#onKeydown(event)), listenerOptions);
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState !== "visible") return;
        this.#refreshAfterResume();
      }, listenerOptions);
      window.addEventListener("pageshow", (event) => {
        if (event.persisted) this.#refreshAfterResume();
      }, listenerOptions);
      this.#colorSchemeQuery = window.matchMedia?.("(prefers-color-scheme: dark)") ?? null;
      this.#colorSchemeListener = () => {
        if (this.#colorSchemeQuery) this.#syncThemeColor();
      };
      this.#colorSchemeQuery?.addEventListener?.("change", this.#colorSchemeListener);
      this.#unsubscribeStore = this.#store.subscribe((_state, event) => this.render({ preserveDialog: event?.source === "external" }));

      this.#timerId = window.setInterval(() => this.#refreshTimers(), 1000);
      this.render();
      this.#inspectPersistentStorage();
    } catch (error) {
      try {
        this.destroy();
      } catch {
        // Cleanup is best-effort here; preserve the initialization failure that explains the recovery screen.
      }
      throw error;
    }
  }

  destroy() {
    if (this.#destroyed) return;
    this.#destroyed = true;
    this.#renderSequence += 1;
    window.clearInterval(this.#timerId);
    this.#importRequestGate.invalidate();
    this.#importReadController?.abort();
    this.#importReadController = null;
    this.#clipboardRequestGate.invalidate();
    this.#storageDurabilityRequestGate.invalidate();
    this.#pendingImport = null;
    this.#pendingProjectEdit = null;
    this.#newProjectTemplate = null;
    this.#pendingCheckpointSessionId = null;
    this.#activeSession = null;
    this.#acknowledgedStaleSessionId = null;
    this.#timelineLimits.clear();
    this.#collectionLimits.clear();
    this.#workspaceCreatedAt = null;
    this.#searchIndexState = null;
    this.#searchIndex = null;
    this.#eventController.abort();
    this.#colorSchemeQuery?.removeEventListener?.("change", this.#colorSchemeListener);
    this.#colorSchemeQuery = null;
    this.#colorSchemeListener = null;
    this.#unsubscribeStore?.();
    this.#unsubscribeStore = null;
    for (const timerId of this.#toastTimers.values()) window.clearTimeout(timerId);
    this.#toastTimers.clear();
    this.#toasts = [];
    this.#store?.destroy?.();
  }

  render({ preserveDialog = false } = {}) {
    if (this.#destroyed) return;
    const renderSequence = ++this.#renderSequence;
    const transientDialog = preserveDialog ? this.#captureTransientDialog() : null;
    const captureDraft = preserveDialog ? this.#captureInlineCaptureDraft() : null;
    this.#noticeQueue.push(...this.#store.drainNotices());
    if (this.#noticeQueue.length > STORE_NOTICE_LIMIT) {
      this.#noticeQueue.splice(0, this.#noticeQueue.length - STORE_NOTICE_LIMIT);
    }
    const state = this.#store.getState();
    if (this.#workspaceCreatedAt !== state.meta.createdAt) {
      this.#workspaceCreatedAt = state.meta.createdAt;
      this.#timelineLimits.clear();
      this.#collectionLimits.clear();
    }
    const now = Date.now();
    const reopenImportPreview = Boolean(this.#root.querySelector("#import-preview-dialog")?.open && this.#pendingImport);
    if (this.#pendingImport && this.#pendingImport.baseState !== state) {
      this.#pendingImport.preview = {
        ...this.#store.previewImport(this.#pendingImport.value),
        source: this.#pendingImport.source
      };
      this.#pendingImport.value = this.#pendingImport.preview.normalizedSnapshot;
      this.#pendingImport.baseState = state;
      this.#pendingImport.refreshed = true;
    }
    const route = parseRoute(location.hash);
    const frame = buildWorkspaceFrame(state, route.name === "project" ? route.id : null, now);
    const { counts: workspaceCounts, currentProject, activeSession, activeProject } = frame;
    this.#workspaceCounts = workspaceCounts;
    this.#activeSession = activeSession;
    if (!activeSession || this.#acknowledgedStaleSessionId !== activeSession.id) this.#acknowledgedStaleSessionId = null;
    const currentReentryCard = currentProject
      ? currentProject.status === "archived"
        ? buildReentryCard(state, currentProject.id, now)
        : buildReentryCardWithStats(state, currentProject.id, now)
      : null;
    const theme = state.settings.theme ?? "system";
    this.#sessionHealthSignature = sessionHealthSignature(
      activeSession,
      Boolean(activeSession && activeSession.id === this.#acknowledgedStaleSessionId),
      now
    );
    this.#calendarDaySignature = localDaySignature(now);

    document.documentElement.dataset.theme = theme;
    document.documentElement.dataset.reducedMotion = state.settings.reducedMotion ? "reduce" : "system";
    this.#syncThemeColor(theme);
    document.title = `${currentProject?.title ?? routeTitle(route)} · 复航台`;

    this.#root.innerHTML = `
      <div class="app-shell">
        ${this.#renderSidebar(route, workspaceCounts)}
        <div class="content-column">
          ${this.#renderTopbar(route, currentProject, activeSession, workspaceCounts)}
          <main class="main-content" id="main-content" tabindex="-1">
            ${this.#renderSessionInvariantNotice(workspaceCounts, activeSession, activeProject)}
            ${this.#renderNotices()}
            ${this.#renderRoute(route, state, currentProject, activeSession, workspaceCounts, currentReentryCard, now)}
          </main>
        </div>
      </div>
      ${activeSession && activeProject && !(route.name === "project" && route.id === activeProject.id) ? this.#renderSessionDock(activeSession, activeProject) : ""}
      ${this.#renderDialogs(currentProject, activeSession, currentReentryCard)}
      <div class="toast-region" id="toast-region" aria-live="polite" aria-atomic="false">${this.#renderToasts()}</div>
      <div class="sr-only" id="live-region" aria-live="polite"></div>
    `;
    this.#noticeQueue = [];
    this.#root.setAttribute("aria-busy", "false");
    if (captureDraft) this.#restoreInlineCaptureDraft(captureDraft, activeSession);
    this.#refreshTimers();

    if (reopenImportPreview && this.#pendingImport) {
      requestAnimationFrame(() => {
        if (this.#destroyed || renderSequence !== this.#renderSequence) return;
        if (transientDialog?.id === "import-preview-dialog") this.#restoreTransientDialog(transientDialog);
        else this.#openDialog("import-preview-dialog");
      });
    } else if (transientDialog) {
      requestAnimationFrame(() => {
        if (this.#destroyed || renderSequence !== this.#renderSequence) return;
        this.#restoreTransientDialog(transientDialog);
      });
    }

    if (this.#focusSelector) {
      const selector = this.#focusSelector;
      this.#focusSelector = null;
      window.setTimeout(() => {
        if (this.#destroyed || renderSequence !== this.#renderSequence) return;
        this.#root.querySelector(selector)?.focus();
      }, 0);
    }
  }

  #captureTransientDialog() {
    const dialog = this.#root.querySelector("dialog[open]");
    if (!dialog?.id) return null;
    const controls = [...dialog.querySelectorAll("input, select, textarea")]
      .filter((control) => control.type !== "file" && control.type !== "hidden");
    const focusables = [...dialog.querySelectorAll("button, input, select, textarea")]
      .filter((control) => control.type !== "hidden");
    const activeControlIndex = controls.indexOf(document.activeElement);
    const activeFocusableIndex = focusables.indexOf(document.activeElement);
    return {
      id: dialog.id,
      contextKey: this.#dialogContextKey(dialog),
      activeControlIndex,
      activeFocusableIndex,
      controls: controls.map((control) => {
        const value = boundTransientControlValue(control.value, control.maxLength);
        const selection = normalizeTransientSelection(value, control.selectionStart, control.selectionEnd);
        return {
          tag: control.tagName,
          type: control.type,
          value,
          checked: control.checked,
          selectionStart: selection?.[0] ?? null,
          selectionEnd: selection?.[1] ?? null
        };
      })
    };
  }

  #dialogContextKey(dialog) {
    const value = (name) => dialog.querySelector(`[name="${name}"]`)?.value ?? "";
    if (dialog.id === "start-session-dialog") return `${dialog.id}:${value("projectId")}`;
    if (dialog.id === "checkpoint-dialog") return `${dialog.id}:${dialog.dataset.contextId ?? ""}`;
    if (dialog.id === "quick-review-dialog") return `${dialog.id}:${value("projectId")}:${value("sourceCheckpointId")}`;
    if (dialog.id === "edit-project-dialog") return `${dialog.id}:${value("projectId")}`;
    if (dialog.id === "archive-confirm-dialog") return `${dialog.id}:${dialog.dataset.contextId ?? ""}`;
    return dialog.id;
  }

  #captureInlineCaptureDraft() {
    if (this.#root.querySelector("dialog[open]")) return null;
    const form = this.#root.querySelector('[data-form="capture-crumb"]');
    const text = form?.elements?.text;
    const type = form?.elements?.type;
    const sessionId = this.#activeSession?.id;
    if (!text || !type || !sessionId) return null;
    const focused = document.activeElement === text || document.activeElement === type;
    if (!focused && !text.value) return null;
    return {
      sessionId,
      text: text.value,
      type: type.value,
      focus: document.activeElement === type ? "type" : document.activeElement === text ? "text" : null,
      selectionStart: typeof text.selectionStart === "number" ? text.selectionStart : null,
      selectionEnd: typeof text.selectionEnd === "number" ? text.selectionEnd : null
    };
  }

  #restoreInlineCaptureDraft(snapshot, activeSession) {
    if (!snapshot || activeSession?.id !== snapshot.sessionId) return;
    const form = this.#root.querySelector('[data-form="capture-crumb"]');
    const text = form?.elements?.text;
    const type = form?.elements?.type;
    if (!text || !type) return;
    text.value = boundTransientControlValue(snapshot.text, IMPORT_LIMITS.crumbText);
    if (Object.hasOwn(CRUMB_LABELS, snapshot.type)) type.value = snapshot.type;
    const focusTarget = snapshot.focus === "type" ? type : snapshot.focus === "text" ? text : null;
    focusTarget?.focus();
    if (focusTarget === text && snapshot.selectionStart !== null && snapshot.selectionEnd !== null && typeof text.setSelectionRange === "function") {
      const end = text.value.length;
      text.setSelectionRange(Math.min(snapshot.selectionStart, end), Math.min(snapshot.selectionEnd, end));
    }
  }

  #restoreTransientDialog(snapshot) {
    const dialog = this.#root.querySelector(`#${CSS.escape(snapshot.id)}`);
    if (!dialog) return;
    if (!this.#validateTransientDialogContext(snapshot, dialog)) return;
    const controls = [...dialog.querySelectorAll("input, select, textarea")]
      .filter((control) => control.type !== "file" && control.type !== "hidden");
    const focusables = [...dialog.querySelectorAll("button, input, select, textarea")]
      .filter((control) => control.type !== "hidden");
    snapshot.controls.forEach((saved, index) => {
      const control = controls[index];
      if (!control || control.tagName !== saved.tag || control.type !== saved.type) return;
      const value = boundTransientControlValue(saved.value, control.maxLength);
      if (control.type === "checkbox" || control.type === "radio") {
        control.checked = saved.checked;
      } else if (control.tagName !== "SELECT" || [...control.options].some((option) => option.value === value)) {
        control.value = value;
      }
    });
    dialog.showModal();
    const active = focusables[snapshot.activeFocusableIndex];
    if (!active || active.disabled) return;
    active.focus();
    const saved = snapshot.controls[snapshot.activeControlIndex];
    const selection = normalizeTransientSelection(active.value, saved?.selectionStart, saved?.selectionEnd);
    if (active === controls[snapshot.activeControlIndex]
      && selection
      && typeof active.setSelectionRange === "function") {
      active.setSelectionRange(...selection);
    }
  }

  #validateTransientDialogContext(snapshot, dialog) {
    try {
      if (snapshot.id === "start-session-dialog") {
        const projectId = dialog.querySelector('[name="projectId"]')?.value;
        const plan = prepareSessionDialog(this.#store.getState(), projectId);
        if (plan.activeSession) throw new Error("已有活动会话");
      }
      if (snapshot.id === "edit-project-dialog") {
        const pending = this.#pendingProjectEdit;
        if (!pending) return false;
        prepareProjectEdit(this.#store.getState(), pending.projectId, pending.editToken);
      }
      if (snapshot.id === "archive-confirm-dialog") {
        if (!this.#pendingArchiveId) return false;
        prepareProjectArchive(this.#store.getState(), this.#pendingArchiveId);
      }
      if (snapshot.contextKey === this.#dialogContextKey(dialog)) return true;
    } catch {
      // The record changed while another tab owned the latest state.
    }
    if (snapshot.id === "edit-project-dialog") this.#pendingProjectEdit = null;
    if (snapshot.id === "checkpoint-dialog") this.#pendingCheckpointSessionId = null;
    if (snapshot.id === "archive-confirm-dialog") this.#pendingArchiveId = null;
    this.#toast("工作区变化使原对话框失效，请重新打开。", "error");
    return false;
  }

  #renderSidebar(route, workspaceCounts) {
    const activeCount = workspaceCounts.unarchivedProjects;
    const archivedCount = workspaceCounts.archivedProjects;
    return `
      <aside class="sidebar" aria-label="主导航">
        <a class="brand" href="#/" aria-label="复航台首页">
          ${brandMark()}
          <span class="brand-copy"><span class="brand-name">复航台</span><span class="brand-subtitle">REENTRY</span></span>
        </a>
        <nav class="side-nav">
          <a href="#/" aria-label="项目舰桥，${activeCount} 个未归档项目" ${route.name === "home" || route.name === "project" ? 'aria-current="page"' : ""}>${icon("home")}<span>项目舰桥</span><span class="nav-count">${activeCount}</span></a>
          <a href="#/archive" aria-label="归档舱${archivedCount ? `，${archivedCount} 个项目` : ""}" ${route.name === "archive" ? 'aria-current="page"' : ""}>${icon("archive")}<span>归档舱</span>${archivedCount ? `<span class="nav-count">${archivedCount}</span>` : ""}</a>
          <a href="#/settings" aria-label="数据保险箱" ${route.name === "settings" ? 'aria-current="page"' : ""}>${icon("settings")}<span>数据保险箱</span></a>
        </nav>
        <div class="sidebar-bottom">
          <div class="privacy-note">${icon("lock")}<span>所有工作轨迹只保存在这个浏览器中</span></div>
          <button class="new-project-button" type="button" data-action="open-new-project" aria-label="建立新项目">${icon("plus")}<span>建立新项目</span></button>
        </div>
      </aside>`;
  }

  #renderTopbar(route, project, activeSession, workspaceCounts) {
    const context = project ? "项目现场" : route.name === "archive" ? "历史项目" : route.name === "settings" ? "隐私与迁移" : "本地工作区";
    const title = project?.title ?? routeTitle(route);
    const canUndo = this.#store.hasPreviousSnapshot();
    const canCapture = workspaceCounts.unarchivedProjects > 0;
    return `
      <header class="topbar">
        <div class="topbar-context"><span class="topbar-eyebrow">${escapeHTML(context)}</span><span class="topbar-title">${escapeHTML(title)}</span></div>
        <div class="topbar-actions">
          ${activeSession ? `<span class="soft-pill"><span class="dock-pulse"></span> 会话中</span>` : ""}
          <button class="ghost-button quick-capture-trigger" type="button" data-action="open-quick-capture" aria-label="跨项目快捷记录" title="跨项目快捷记录（Ctrl/⌘ Shift C）" ${canCapture ? "" : "disabled"}>${icon("trail")}<span>记录</span></button>
          <button class="ghost-button search-trigger" type="button" data-action="open-search" aria-label="搜索所有工作现场">${icon("search")}<span>搜索</span><kbd>Ctrl K</kbd></button>
          <button class="icon-button" type="button" data-action="undo-last" data-undo-context="topbar" aria-label="撤销上一次保存" title="撤销上一次保存（Ctrl/⌘ Z）" ${canUndo ? "" : "disabled"}>${icon("undo")}</button>
          <button class="ghost-button" type="button" data-action="open-new-project">${icon("plus")}<span>新项目</span></button>
        </div>
      </header>`;
  }

  #renderRoute(route, state, project, activeSession, workspaceCounts, reentryCard, now) {
    if (route.name === "archive") return this.#renderArchive(state);
    if (route.name === "settings") return this.#renderSettings(state);
    if (route.name === "notFound") return this.#renderNotFound();
    if (route.name === "project") return project ? (project.status === "archived" ? this.#renderArchivedProject(state, project, reentryCard) : this.#renderProject(state, project, activeSession, reentryCard)) : this.#renderNotFound();
    return this.#renderDashboard(state, activeSession, workspaceCounts, now);
  }

  #renderDashboard(state, activeSession, workspaceCounts, now) {
    if (!workspaceCounts.unarchivedProjects) return this.#renderEmptyDashboard();
    const rankedLimit = this.#collectionLimits.get("home") ?? COLLECTION_PAGE_SIZE;
    const { rankedProjects: ranked, rankedTotal, weeklyReview, attentionDeck, attentionTotal } = buildWorkspaceOverview(state, now, { rankedLimit });
    const projectWindow = buildCollectionWindow(ranked, rankedLimit, rankedTotal);
    const lead = ranked[0];
    const activeProjects = workspaceCounts.activeProjects;
    const blockedProjects = workspaceCounts.blockedProjects;

    return `
      <section class="page-heading">
        <div>
          <p class="eyebrow">${greeting()}</p>
          <h1>从清楚的地方，重新开始。</h1>
          <p class="lede">这里不催促你做更多，只帮你找回上次离开时已经想清楚的东西。</p>
        </div>
        <button class="secondary-button" type="button" data-action="copy-workspace-handoff" aria-label="复制工作区交接清单">${icon("copy")} 复制交接清单</button>
      </section>
      ${lead ? this.#renderHero(lead, activeSession) : ""}
      <section class="metrics-grid" aria-label="工作区概览">
        ${metric("航行中", activeProjects, `${workspaceCounts.unarchivedProjects} 个未归档项目`)}
        ${metric("今日轨迹", workspaceCounts.crumbsToday, "条面包屑")}
        ${metric("可靠检查点", workspaceCounts.checkpoints, "次可恢复现场")}
        ${metric("受阻项目", blockedProjects, blockedProjects ? "需要一次澄清" : "目前航路通畅")}
      </section>
      ${this.#renderWorkspacePulse(weeklyReview, attentionDeck, attentionTotal)}
      <section>
        <div class="section-heading"><div><h2>项目舰桥</h2><p>按当前最值得复航的顺序排列</p></div><button class="secondary-button" type="button" data-action="open-new-project">${icon("plus")} 建立项目</button></div>
        <div class="project-grid" id="project-window-home" data-project-window="home">${projectWindow.items.map((card, index) => this.#renderProjectCard(card, index)).join("")}</div>
        ${this.#renderCollectionMore(projectWindow, "home", "项目")}
      </section>`;
  }

  #renderWorkspacePulse(review, attentionDeck, attentionTotal) {
    const dockCount = review.quickDocks + review.interruptions;
    const completeAttentionTotal = Number.isSafeInteger(attentionTotal)
      ? Math.max(attentionDeck.length, attentionTotal)
      : attentionDeck.length;
    const attentionRemaining = completeAttentionTotal - attentionDeck.length;
    return `
      <section class="panel workspace-pulse" aria-labelledby="pulse-heading">
        <div class="panel-header inline-between"><div><h2 id="pulse-heading">七日航迹</h2><p>只根据本机已有时间戳整理；单次异常长会话最多计 12 小时。</p></div><span class="soft-pill">${icon("trail")} 最近 ${review.windowDays} 天</span></div>
        <div class="panel-body pulse-layout">
          <div>
            <div class="pulse-metrics">
              ${pulseMetric(formatInsightDuration(review.focusedMinutes), "可计会话时长", review.cappedSessions ? `${review.cappedSessions} 段已封顶` : "按窗口内相交时长")}
              ${pulseMetric(review.sessions, "会话窗口", `${review.records} 条轨迹`)}
              ${pulseMetric(review.nearbySwitches, "近距项目切换", "4 小时内转到另一项目")}
              ${pulseMetric(`${review.recoverability}%`, "平均复航完整度", "未归档项目")}
            </div>
            <p class="pulse-summary">${review.topProject ? `投入最多：${escapeHTML(review.topProject.title)}（${formatInsightDuration(review.topProject.minutes)}）` : "本周还没有可计会话。"}${dockCount ? ` · ${dockCount} 次应急停靠或中断` : ""}${review.resolvedSignals ? ` · 闭合 ${review.resolvedSignals} 个问题` : ""}</p>
          </div>
          <div class="attention-deck">
            <div class="attention-heading"><strong>值得核对</strong><span>按现场缺口排序，不评价产出</span></div>
            ${attentionDeck.length ? `<ul>${attentionDeck.map((item) => `<li><a href="#/project/${encodeURIComponent(item.project.id)}"><span class="attention-level" data-level="${attr(item.level)}" aria-hidden="true"></span><span><strong>${escapeHTML(item.project.title)}</strong><small>${escapeHTML(item.reasons.join(" · "))}</small></span>${icon("arrow")}</a></li>`).join("")}</ul>${attentionRemaining ? `<p class="attention-overflow">另有 ${attentionRemaining} 个项目未列出，请在项目舰桥中核对。</p>` : ""}` : '<p class="attention-empty">当前没有明显的现场缺口。</p>'}
          </div>
        </div>
      </section>`;
  }

  #renderHero(card, activeSession) {
    const isRunning = activeSession?.projectId === card.project.id;
    return `
      <section class="reentry-hero" aria-labelledby="recommended-heading">
        <div>
          <p class="eyebrow">${isRunning ? "正在进行" : card.project.status === "blocked" ? "值得先解阻" : "建议复航"} · ${escapeHTML(card.recommendationReason || "现场可恢复")}</p>
          <h2 id="recommended-heading">${escapeHTML(card.project.title)}</h2>
          <p class="hero-summary">${escapeHTML(card.summary)}</p>
          <p class="hero-action-label">回来后的第一动作</p>
          <p class="hero-next">${escapeHTML(card.nextAction)}</p>
          <div class="hero-buttons">
            <a class="primary-button" href="#/project/${encodeURIComponent(card.project.id)}">${isRunning ? icon("trail") : icon("compass")} ${isRunning ? "返回工作现场" : "打开 60 秒复航卡"}</a>
            ${!isRunning && !activeSession ? `<button class="secondary-button" type="button" data-action="start-session" data-project-id="${attr(card.project.id)}">${icon("play")} 直接开始会话</button>` : ""}
          </div>
        </div>
        <div class="hero-gauge" aria-label="复航信息完整度 ${card.completeness}%">
          <div class="gauge-ring"><svg class="gauge-chart" viewBox="0 0 36 36" aria-hidden="true"><circle class="gauge-track" cx="18" cy="18" r="15.9155" pathLength="100"></circle><circle class="gauge-progress" cx="18" cy="18" r="15.9155" pathLength="100" stroke-dasharray="${card.completeness} 100"></circle></svg><span class="gauge-value">${card.completeness}%</span></div>
          <span class="gauge-label">复航信息完整度<br>${awayLabel(card.awayDays)}</span>
        </div>
      </section>`;
  }

  #renderProjectCard(card, index) {
    return `
      <a class="project-card" data-project-window-item="${index}" data-color="${attr(card.project.color)}" href="#/project/${encodeURIComponent(card.project.id)}">
        <div>
          <div class="project-card-header"><span class="status-pill" data-status="${attr(card.project.status)}">${PROJECT_STATUS_LABELS[card.project.status]}</span><span class="muted">${formatRelative(card.lastActivityAt)}</span></div>
          <h3>${escapeHTML(card.project.title)}</h3>
          <p class="project-description">${escapeHTML(card.project.description || card.summary)}</p>
          <p class="project-next"><span>下一动作</span>${escapeHTML(card.nextAction)}</p>
        </div>
        <div class="project-card-footer"><span>${card.checkpoint ? `检查点 ${formatRelative(card.checkpoint.createdAt)}` : "尚未建立检查点"}</span><span class="open-link">进入 ${icon("arrow")}</span></div>
      </a>`;
  }

  #renderEmptyDashboard() {
    return `
      <section class="page-heading">
        <div><p class="eyebrow">欢迎登台</p><h1>下一次离开，不必再从头想起。</h1><p class="lede">先建立一个需要多次推进的项目。复航台会替你保存离开时的认知现场。</p></div>
      </section>
      <section class="empty-state">
        <div class="empty-illustration" aria-hidden="true"><span></span><span></span><span></span></div>
        <h2>建立第一个工作现场</h2>
        <p>适合研究、写作、编程、设计等容易被打断、又需要保留思路的工作。</p>
        <div class="empty-actions"><button class="primary-button" type="button" data-action="open-new-project">${icon("plus")} 建立项目</button><button class="secondary-button" type="button" data-action="load-sample">${icon("spark")} 载入示例现场</button></div>
      </section>`;
  }

  #renderProject(state, project, activeSession, card) {
    const stats = card.stats;
    const isRunning = activeSession?.projectId === project.id;
    const anotherRunning = activeSession && !isRunning;
    const timeline = buildTimelineWindow(state.crumbs, project.id, this.#timelineLimits.get(project.id));

    return `
      <section class="project-header">
        <div>
          <p class="eyebrow">${PROJECT_STATUS_LABELS[project.status]}</p>
          <h1>${escapeHTML(project.title)}</h1>
          <p class="lede">${escapeHTML(project.description || "这个项目还没有目的说明。")}</p>
          <div class="project-meta"><span>建立于 ${formatDateTime(project.createdAt)}</span><span class="separator">•</span><span>${awayLabel(card.awayDays)}</span>${card.checkpoint ? `<span class="separator">•</span><span>检查点完整度 ${card.completeness}%</span>` : ""}</div>
        </div>
        <div class="project-header-actions">
          <button class="secondary-button" type="button" data-action="edit-project">${icon("edit")} 编辑</button>
          <button class="secondary-button" type="button" data-action="use-project-template" data-project-id="${attr(project.id)}" aria-label="以当前项目为模板建立新现场：${attr(controlContext(project.title))}">${icon("copy")} 复用为新项目</button>
          ${isRunning ? `<button class="secondary-button" type="button" data-action="quick-dock" data-session-id="${attr(activeSession.id)}" aria-label="快速停靠：${attr(controlContext(project.title))}" title="快速停靠（Ctrl/⌘ Shift S）">${icon("archive")} 快速停靠</button><button class="primary-button" type="button" data-action="open-checkpoint">${icon("stop")} 留下检查点</button>` : anotherRunning ? `<a class="secondary-button" href="#/project/${encodeURIComponent(activeSession.projectId)}">先处理活动会话</a>` : `<button class="primary-button" type="button" data-action="start-session" data-project-id="${attr(project.id)}">${icon("play")} 开始会话</button>`}
        </div>
      </section>
      <div class="workspace-grid">
        ${isRunning ? this.#renderFocusPanel(project, activeSession) : this.#renderReentryPanel(card, anotherRunning)}
        <aside class="side-stack">
          ${this.#renderProjectControls(project)}
          ${this.#renderResourcesPanel(state, project.id)}
          ${this.#renderStatsPanel(stats)}
        </aside>
      </div>
      <section class="panel spaced-panel">
        <div class="panel-header inline-between"><div><h2>工作轨迹</h2><p>最近的记录在上方；每一条都可以成为下次复航的线索。</p></div><span class="soft-pill">${timeline.total} 条</span></div>
        <div class="panel-body">${this.#renderTimeline(timeline, project.id, true, "还没有轨迹。开始会话后，随手留下第一个发现或决定。")}</div>
      </section>`;
  }

  #renderReentryPanel(card, anotherRunning) {
    const checkpointLabel = card.checkpoint
      ? `${card.checkpoint.captureMode === "quick" ? "快速停靠，需复核" : "可靠检查点"} · ${formatDateTime(card.checkpoint.createdAt)}`
      : "尚无检查点";
    const pinnedTotal = Number.isSafeInteger(card.pinnedTotal)
      ? Math.max(card.pinnedCrumbs.length, card.pinnedTotal)
      : card.pinnedCrumbs.length;
    const pinnedRemaining = pinnedTotal - card.pinnedCrumbs.length;
    const changeTotal = Number.isSafeInteger(card.changesSinceCheckpointTotal)
      ? Math.max(card.changesSinceCheckpoint.length, card.changesSinceCheckpointTotal)
      : card.changesSinceCheckpoint.length;
    const changeRemaining = changeTotal - card.changesSinceCheckpoint.length;
    const decisionTotal = Number.isSafeInteger(card.decisionTotal)
      ? Math.max(card.decisions.length, card.decisionTotal)
      : card.decisions.length;
    const decisionRemaining = decisionTotal - card.decisions.length;
    return `
      <section class="panel reentry-card" aria-labelledby="reentry-card-heading">
        <div class="panel-header inline-between"><div><h2 id="reentry-card-heading">60 秒复航卡</h2><p>${card.checkpoint ? (card.checkpoint.captureMode === "quick" ? `快速停靠 · ${formatDateTime(card.checkpoint.createdAt)} · 请先复核` : `来自 ${formatDateTime(card.checkpoint.createdAt)} 的可靠检查点`) : "信息不足时，从三问校准开始"}</p></div><div class="reentry-card-tools"><button class="ghost-button" type="button" data-action="copy-reentry-brief" data-project-id="${attr(card.project.id)}" aria-label="复制复航简报：${attr(controlContext(card.project.title))}">${icon("copy")} 复制简报</button><span class="soft-pill">${icon("compass")} ${card.completeness}%</span></div></div>
        <div class="panel-body">
          ${card.contextGapSessions.length ? `<div class="evidence-warning" role="status">${icon("alert")} 检查点之后还有 ${card.contextGapSessions.length} 段未收拢或中断的会话，完整度已下调；请先核对现场。</div>` : ""}
          ${card.readinessGaps.length ? `<div class="reentry-gaps" role="note"><strong>${icon("compass")} 复航缺口</strong><ul>${card.readinessGaps.map((gap) => `<li>${escapeHTML(gap)}</li>`).join("")}</ul>${card.checkpoint?.captureMode === "quick" ? '<button class="secondary-button" type="button" data-action="review-quick-checkpoint">复核并升级检查点</button>' : ""}</div>` : ""}
          <div class="reentry-section"><span class="reentry-label">${icon("trail")} 01 · 可靠检查点</span><p class="reentry-value">${textBlock(card.checkpoint?.summary || "还没有可靠检查点；以下内容来自零散证据。")}</p><p class="evidence-source">${escapeHTML(checkpointLabel)}</p></div>
          ${card.pinnedCrumbs.length ? `<div class="reentry-section pinned-evidence"><span class="reentry-label">${icon("pin")} 置顶航标</span>${this.#renderEvidenceList(card.pinnedCrumbs, "")}${pinnedRemaining ? `<p class="reentry-value muted">另有 ${pinnedRemaining} 个置顶航标，请在完整轨迹中核对。</p>` : ""}</div>` : ""}
          <div class="reentry-section"><span class="reentry-label">${icon("spark")} 02 · 检查点后发生了什么</span>${this.#renderEvidenceList(card.changesSinceCheckpoint, "检查点之后没有新的状态、决定或下一步记录。")}${changeRemaining ? `<p class="reentry-value muted">另有 ${changeRemaining} 条检查点后变化，请在完整轨迹中核对。</p>` : ""}</div>
          <div class="reentry-section"><span class="reentry-label">${icon("check")} 03 · 最近决定</span>${this.#renderEvidenceList(card.decisions, "还没有记录明确决定。")}${decisionRemaining ? `<p class="reentry-value muted">另有 ${decisionRemaining} 条较早决定，请在完整轨迹中核对。</p>` : ""}</div>
          <div class="reentry-section"><span class="reentry-label">${icon("alert")} 04 · 仍未解决</span>${this.#renderOpenLoops(card)}</div>
          <div class="reentry-section"><span class="reentry-label">${icon("arrow")} 05 · 第一物理动作</span><p class="reentry-value next-action">${textBlock(card.nextAction)}</p><p class="evidence-source">来源：${escapeHTML(card.nextActionEvidence?.label || "引导建议")} ${card.nextActionEvidence?.createdAt ? `· ${formatDateTime(card.nextActionEvidence.createdAt)}` : ""}</p></div>
          <div class="reentry-section"><span class="reentry-label">${icon("compass")} 复航提示</span><p class="reentry-value">${textBlock(card.returnHint)}</p></div>
          <div class="reentry-section">
            <ol class="reentry-steps"><li>读完上次状态，不急着打开所有材料。</li><li>确认未决事项现在是否仍成立。</li><li>用上面的具体动作开始一段短会话。</li></ol>
          </div>
          ${anotherRunning ? `<p class="notice-banner">${icon("info")} 另一个项目仍有活动会话，请先为它留下检查点。</p>` : `<button class="primary-button" type="button" data-action="start-session" data-project-id="${attr(card.project.id)}">${icon("play")} 我已复航，开始会话</button>`}
        </div>
      </section>`;
  }

  #renderFocusPanel(project, session) {
    const health = inspectSession(session);
    const showStaleWarning = health.stale && session.id !== this.#acknowledgedStaleSessionId;
    return `
      <section class="panel focus-panel" aria-labelledby="focus-heading">
        <div class="panel-header inline-between"><div><h2 id="focus-heading">工作现场已展开</h2><p>计时以开始时间为准，关闭页面也不会失真。</p></div><span class="status-pill" data-status="active">会话中</span></div>
        <div class="panel-body">
          ${showStaleWarning ? this.#renderStaleSessionWarning(project, session, health) : ""}
          <div class="session-timer js-session-timer" role="timer" aria-label="本次会话用时" data-started-at="${attr(session.startedAt)}">${formatDuration(elapsedSeconds(session.startedAt))}</div>
          <p class="session-intention"><span class="muted">本次意图：</span> <strong>${escapeHTML(session.intention || project.nextAction || "先推进一个清楚的下一步")}</strong></p>
          <form class="capture-form" data-form="capture-crumb" autocomplete="off">
            <label class="field"><span>留下工作面包屑</span><textarea name="text" rows="3" maxlength="${IMPORT_LIMITS.crumbText}" placeholder="一句话就够：刚发现了什么、做了什么决定、卡在哪里…" required></textarea></label>
            <div class="capture-row">
              <label class="field"><span class="sr-only">记录类型</span><select name="type" aria-label="记录类型">${Object.entries(CRUMB_LABELS).map(([value, label]) => `<option value="${value}">${label}</option>`).join("")}</select></label>
              <span class="muted capture-shortcut-hint">快捷键 C 可随时回到输入框</span>
              <button class="primary-button" type="submit">${icon("plus")} 记录</button>
            </div>
          </form>
        </div>
      </section>`;
  }

  #renderStaleSessionWarning(project, session, health) {
    const reason = health.staleReasons.includes("calendar-day")
      ? "它跨过了自然日"
      : health.staleReasons.includes("invalid-started-at")
        ? "开始时间无法确认"
        : `它已经持续 ${formatDuration(Math.floor((health.ageMs ?? 0) / 1000), { compact: true })}`;
    return `
      <div class="stale-session-alert" role="status">
        <div class="stale-session-icon">${icon("alert")}</div>
        <div><strong>上次会话可能没有收拢</strong><p>${reason}。复航台不会擅自停止计时，请选择最符合实际情况的处理方式。</p>
          <div class="button-row">
            <button class="ghost-button" type="button" data-action="continue-session" data-session-id="${attr(session.id)}" aria-label="继续原会话：${attr(controlContext(project.title))}">继续原会话</button>
            <button class="secondary-button" type="button" data-action="open-checkpoint" aria-label="补完整检查点：${attr(controlContext(project.title))}">补完整检查点</button>
            <button class="secondary-button" type="button" data-action="quick-dock" data-session-id="${attr(session.id)}" aria-label="快速停靠：${attr(controlContext(project.title))}" title="快速停靠（Ctrl/⌘ Shift S）">快速停靠</button>
            <button class="primary-button" type="button" data-action="interrupt-and-continue" data-session-id="${attr(session.id)}" aria-label="中断并接续：${attr(controlContext(project.title))}">中断并接续</button>
          </div>
        </div>
      </div>`;
  }

  #renderProjectControls(project) {
    return `
      <section class="panel">
        <div class="panel-header"><h2>航行状态</h2><p>状态只帮助筛选，不评价进度。</p></div>
        <div class="panel-body">
          <label class="field"><span>项目状态</span><select data-control="project-status" data-project-id="${attr(project.id)}">
            ${["active", "paused", "blocked"].map((status) => `<option value="${status}" ${project.status === status ? "selected" : ""}>${PROJECT_STATUS_LABELS[status]}</option>`).join("")}
          </select></label>
          <div class="button-row project-archive-actions"><button class="ghost-button danger-text" type="button" data-action="archive-project" data-project-id="${attr(project.id)}">${icon("archive")} 移入归档</button></div>
        </div>
      </section>`;
  }

  #renderStatsPanel(stats) {
    return `
      <section class="panel">
        <div class="panel-header"><h2>现场密度</h2><p>记录越准确，复航成本越低。</p></div>
        <div class="panel-body"><div class="mini-stats">
          ${miniStat(stats.completedSessions, "完成会话")}${miniStat(stats.checkpoints, "检查点")}${miniStat(stats.decisions, "决定")}${miniStat(stats.crumbs, "总轨迹")}
        </div></div>
      </section>`;
  }

  #renderResourcesPanel(state, projectId) {
    const resources = getProjectResources(state, projectId);
    if (!resources.length) return "";
    const sourceLabels = { project: "项目说明", crumb: "工作轨迹", checkpoint: "检查点" };
    return `
      <section class="panel resource-panel">
        <div class="panel-header"><h2>复航资源</h2><p>从现有记录中识别，只打开 HTTP(S) 链接。</p></div>
        <div class="panel-body"><ul>${resources.map((resource) => `<li><a href="${attr(resource.url)}" target="_blank" rel="noopener noreferrer" aria-label="在新标签页打开 ${attr(resource.label)}">${icon("external")}<span><strong>${escapeHTML(resource.label)}</strong><small>${escapeHTML(sourceLabels[resource.sourceType] ?? "记录")} · ${formatDateTime(resource.createdAt)}</small></span></a></li>`).join("")}</ul></div>
      </section>`;
  }

  #renderCrumb(crumb, interactive = true) {
    const signal = ["question", "blocker"].includes(crumb.type);
    return `
      <article class="timeline-item" data-resolved="${Boolean(crumb.resolvedAt)}" data-crumb-id="${attr(crumb.id)}" tabindex="-1">
        <span class="timeline-dot" data-type="${attr(crumb.type)}" aria-hidden="true"></span>
        <div class="timeline-content">
          <div class="timeline-meta"><span class="crumb-type">${CRUMB_LABELS[crumb.type] ?? "记录"}</span><time datetime="${attr(crumb.createdAt)}">${formatRelative(crumb.createdAt)} · ${formatDateTime(crumb.createdAt)}</time>${crumb.resolvedAt ? `<span class="resolved-pill">已解决 · ${formatRelative(crumb.resolvedAt)}</span>` : ""}${crumb.pinned ? `<span class="pinned-pill" title="已置顶">${icon("pin")} 航标</span>` : ""}</div>
          <p class="timeline-text">${textBlock(crumb.text)}</p>
          ${interactive ? `<div class="crumb-actions">${signal ? `<button class="crumb-resolution" type="button" data-action="toggle-crumb-resolution" data-resolution-context="timeline" data-crumb-id="${attr(crumb.id)}" aria-pressed="${Boolean(crumb.resolvedAt)}" aria-label="${crumb.resolvedAt ? "重新打开" : "标记已解决"}：${attr(controlContext(crumb.text))}">${crumb.resolvedAt ? "重新打开" : "标记已解决"}</button>` : ""}<button class="crumb-pin" type="button" data-action="toggle-crumb-pin" data-crumb-id="${attr(crumb.id)}" aria-pressed="${Boolean(crumb.pinned)}" aria-label="${crumb.pinned ? "取消置顶" : "设为航标"}：${attr(controlContext(crumb.text))}">${icon("pin")} ${crumb.pinned ? "取消置顶" : "设为航标"}</button></div>` : ""}
        </div>
      </article>`;
  }

  #renderTimeline(timeline, projectId, interactive, emptyText) {
    if (!timeline.total) return `<div class="timeline-empty">${escapeHTML(emptyText)}</div>`;
    const timelineId = `timeline-${encodeURIComponent(projectId)}`;
    return `<div class="timeline-window"><div class="timeline" id="${attr(timelineId)}">${timeline.items.map((crumb) => this.#renderCrumb(crumb, interactive)).join("")}</div>${timeline.remaining ? `<div class="timeline-more"><p>已显示 ${timeline.shown} / ${timeline.total} 条，较早记录按需载入。</p><button class="secondary-button" type="button" data-action="show-more-timeline" data-project-id="${attr(projectId)}" aria-controls="${attr(timelineId)}">再显示 ${Math.min(TIMELINE_PAGE_SIZE, timeline.remaining)} 条<span class="sr-only">，还剩 ${timeline.remaining} 条未显示</span></button></div>` : ""}</div>`;
  }

  #renderEvidenceList(items, emptyText, resolvable = false) {
    if (!items.length) return `<p class="reentry-value muted">${escapeHTML(emptyText)}</p>`;
    return `<ul class="evidence-list">${items.map((item) => `<li><span>${textBlock(item.text)}</span><small>${escapeHTML(CRUMB_LABELS[item.type] ?? "记录")} · ${formatDateTime(item.createdAt)}</small>${resolvable ? `<button type="button" data-action="toggle-crumb-resolution" data-resolution-context="reentry" data-crumb-id="${attr(item.id)}" aria-label="标记已解决：${attr(controlContext(item.text))}">标记已解决</button>` : ""}</li>`).join("")}</ul>`;
  }

  #renderOpenLoops(card) {
    if (card.unresolvedSignals.length) {
      const total = Number.isSafeInteger(card.unresolvedSummary?.total)
        ? Math.max(card.unresolvedSignals.length, card.unresolvedSummary.total)
        : card.unresolvedSignals.length;
      const remaining = total - card.unresolvedSignals.length;
      return `${this.#renderEvidenceList(card.unresolvedSignals, "", true)}${remaining ? `<p class="reentry-value muted">另有 ${remaining} 条未决事项，请在完整轨迹中核对。</p>` : ""}`;
    }
    if (card.historicalOpenLoops) {
      return `<p class="reentry-value muted"><strong>检查点曾记录（待确认）：</strong><br>${textBlock(card.historicalOpenLoops)}</p>`;
    }
    return '<p class="reentry-value muted">当前没有未解决的问题或阻塞。</p>';
  }

  #renderArchive(state) {
    const projectWindow = buildProjectCollectionWindow(state.projects, "archive", this.#collectionLimits.get("archive"));
    const visibleIds = new Set(projectWindow.items.map((project) => project.id));
    const cards = new Map(buildReentryCards(state, [...visibleIds]).map((card) => [card.project.id, card]));
    const crumbCounts = new Map([...visibleIds].map((projectId) => [projectId, 0]));
    for (const crumb of state.crumbs) {
      if (visibleIds.has(crumb.projectId)) crumbCounts.set(crumb.projectId, (crumbCounts.get(crumb.projectId) ?? 0) + 1);
    }
    return `
      <section class="page-heading"><div><p class="eyebrow">归档舱</p><h1>结束的航程，也保留来路。</h1><p class="lede">归档不会删除任何会话、决定或检查点；需要时可以随时恢复。</p></div></section>
      ${projectWindow.total ? `<div class="project-grid" id="project-window-archive" data-project-window="archive">${projectWindow.items.map((project, index) => {
        const card = cards.get(project.id);
        return `<article class="project-card" data-project-window-item="${index}" tabindex="-1" data-color="${attr(project.color)}"><div><div class="project-card-header"><span class="status-pill" data-status="archived">已归档</span><span class="muted">${formatRelative(project.archivedAt ?? project.updatedAt)}</span></div><h3>${escapeHTML(project.title)}</h3><p class="project-description">${escapeHTML(project.description || card?.summary || "还没有留下状态摘要。")}</p></div><div class="project-card-footer"><span>${crumbCounts.get(project.id) ?? 0} 条轨迹</span><div class="project-card-actions"><a class="ghost-button" href="#/project/${encodeURIComponent(project.id)}" aria-label="查看归档项目：${attr(controlContext(project.title))}">查看现场</a><button class="ghost-button" type="button" data-action="restore-project" data-project-id="${attr(project.id)}" aria-label="恢复项目：${attr(controlContext(project.title))}">恢复项目</button></div></div></article>`;
      }).join("")}</div>${this.#renderCollectionMore(projectWindow, "archive", "归档项目")}` : `<section class="empty-state"><div class="empty-illustration" aria-hidden="true"><span></span><span></span><span></span></div><h2>归档舱还是空的</h2><p>完成或暂时不再关注的项目，可以从项目页移到这里。</p><a class="primary-button" href="#/">返回舰桥</a></section>`}`;
  }

  #renderCollectionMore(window, scope, label) {
    if (!window.remaining) return "";
    return `<div class="collection-more"><p>已显示 ${window.shown} / ${window.total} 个${label}，其余按需载入。</p><button class="secondary-button" type="button" data-action="show-more-projects" data-scope="${scope}" aria-controls="project-window-${scope}">再显示 ${Math.min(COLLECTION_PAGE_SIZE, window.remaining)} 个<span class="sr-only">，还剩 ${window.remaining} 个未显示</span></button></div>`;
  }

  #renderArchivedProject(state, project, card) {
    const timeline = buildTimelineWindow(state.crumbs, project.id, this.#timelineLimits.get(project.id));
    return `
      <section class="project-header">
        <div><p class="eyebrow">已归档</p><h1>${escapeHTML(project.title)}</h1><p class="lede">${escapeHTML(project.description || card.summary)}</p><div class="project-meta"><span>归档于 ${formatDateTime(project.archivedAt ?? project.updatedAt)}</span><span class="separator">•</span><span>所有历史记录保持只读</span></div></div>
        <div class="project-header-actions"><button class="secondary-button" type="button" data-action="use-project-template" data-project-id="${attr(project.id)}" aria-label="以归档项目为模板建立新现场：${attr(controlContext(project.title))}">${icon("copy")} 复用为新项目</button><button class="primary-button" type="button" data-action="restore-project" data-project-id="${attr(project.id)}" aria-label="恢复到暂泊状态：${attr(controlContext(project.title))}">恢复到暂泊状态</button></div>
      </section>
      <section class="panel reentry-card"><div class="panel-header"><h2>最后的复航现场</h2><p>恢复项目后可从这个检查点继续。</p></div><div class="panel-body"><div class="reentry-section"><span class="reentry-label">最后状态</span><p class="reentry-value">${textBlock(card.summary)}</p></div><div class="reentry-section"><span class="reentry-label">下一动作</span><p class="reentry-value next-action">${textBlock(card.nextAction)}</p></div></div></section>
      <section class="panel spaced-panel"><div class="panel-header inline-between"><div><h2>历史轨迹</h2><p>归档项目不会接受新的会话或记录。</p></div><span class="soft-pill">${timeline.total} 条</span></div><div class="panel-body">${this.#renderTimeline(timeline, project.id, false, "没有历史轨迹。")}</div></section>`;
  }

  #renderSettings(state) {
    const size = this.#getBackupSize(state);
    const storageUsage = this.#store.getStorageUsage();
    const theme = state.settings.theme;
    const staleOptions = [...new Set([1, 3, 7, 14, 30, 90, state.settings.staleAfterDays])].sort((a, b) => a - b);
    const storagePressure = storageUsage.status === "critical"
      ? "已达到 5 MiB 保守参考线，请立即导出备份并减少浏览器内数据。"
      : storageUsage.status === "warning"
        ? "已超过 5 MiB 保守参考线的 80%，建议现在导出备份。"
        : "低于 5 MiB 保守参考线；浏览器实际配额可能不同。";
    const storageSummary = storageUsage.available
      ? `本应用约 ${formatBytes(storageUsage.appBytes)} · 此来源合计约 ${formatBytes(storageUsage.totalBytes)}`
      : "浏览器未开放可用的本地占用信息";
    const durability = STORAGE_DURABILITY_DETAILS[this.#storageDurabilityStatus] ?? STORAGE_DURABILITY_DETAILS.checking;
    const durabilityUnavailable = this.#storageDurabilityStatus === STORAGE_DURABILITY_STATUS.GRANTED
      || this.#storageDurabilityStatus === STORAGE_DURABILITY_STATUS.UNSUPPORTED
      || this.#storageDurabilityStatus === "checking";
    return `
      <section class="page-heading"><div><p class="eyebrow">数据保险箱</p><h1>你的工作轨迹，只属于你。</h1><p class="lede">复航台没有账户和云端数据库。请主动导出备份，尤其是在清理浏览器数据之前。</p></div></section>
      <div class="settings-grid">
        <section class="panel"><div class="panel-header"><h2>外观与数据</h2><p>设置同样只保存在当前浏览器。</p></div><div class="panel-body">
          <div class="setting-row"><div class="setting-copy"><h3>界面主题</h3><p>跟随系统，或固定使用明亮/深色外观。</p></div><div class="segmented-control" role="group" aria-label="界面主题">${[["system", "跟随系统"], ["light", "明亮"], ["dark", "深色"]].map(([value, label]) => `<button type="button" data-action="set-theme" data-theme="${value}" aria-pressed="${theme === value}">${label}</button>`).join("")}</div></div>
          <div class="setting-row"><div class="setting-copy"><h3>动态效果</h3><p>默认跟随系统辅助功能偏好，也可以在复航台内始终减少动画与平滑滚动。</p></div><div class="segmented-control" role="group" aria-label="动态效果">${[["system", "跟随系统"], ["reduce", "减少动效"]].map(([value, label]) => `<button type="button" data-action="set-motion" data-reduced-motion="${value}" aria-pressed="${state.settings.reducedMotion === (value === "reduce")}">${label}</button>`).join("")}</div></div>
          <div class="setting-row"><div class="setting-copy"><h3>离开提醒阈值</h3><p>项目超过这段时间没有新现场时，关注清单会提示核对。</p></div><label class="field"><span class="sr-only">离开提醒阈值</span><select data-control="stale-days" aria-label="离开提醒阈值">${staleOptions.map((days) => `<option value="${days}" ${days === state.settings.staleAfterDays ? "selected" : ""}>${days} 天</option>`).join("")}</select></label></div>
          <div class="setting-row"><div class="setting-copy"><h3>本机数据保护</h3><p id="storage-durability-status" role="status">${durability.message}</p></div><button class="secondary-button" type="button" data-action="request-persistent-storage" aria-describedby="storage-durability-status" ${durabilityUnavailable ? "disabled" : ""}>${icon("shield")} ${durability.action}</button></div>
          <div class="setting-row"><div class="setting-copy"><h3>导出完整备份</h3><p>包含项目、会话、轨迹、检查点和设置。当前约 ${size}。</p></div><button class="secondary-button" type="button" data-action="export-data">${icon("download")} 导出 JSON</button></div>
          <div class="setting-row"><div class="setting-copy"><h3>从备份恢复</h3><p>文件会先在本机校验；有效备份将替换当前工作区。</p></div><button class="secondary-button" type="button" data-action="choose-import">${icon("upload")} 选择文件</button><input class="sr-only" id="import-file" type="file" accept="application/json,.json" data-control="import-file" aria-label="选择 JSON 备份文件" /></div>
          <div class="setting-row"><div class="setting-copy"><h3>滚动安全快照</h3><p>只保留上一次保存；恢复后再次切换可返回当前版本。重要历史仍应导出备份。</p></div><button class="secondary-button" type="button" data-action="undo-last" data-undo-context="settings" ${this.#store.hasPreviousSnapshot() ? "" : "disabled"}>${icon("undo")} 回到上次保存</button></div>
        </div></section>
        <aside class="panel storage-visual" data-pressure="${attr(storageUsage.status)}">${brandMark()}<strong>本地优先</strong><p>${state.projects.length} 个项目 · ${state.crumbs.length} 条轨迹<br>${escapeHTML(storageSummary)}<br>${escapeHTML(storagePressure)}<br>没有任何数据被发送到外部服务。</p></aside>
      </div>`;
  }

  #getBackupSize(state) {
    if (this.#backupSizeState !== state) {
      const snapshot = this.#store.exportSnapshotText();
      this.#backupSizeLabel = formatBytes(new Blob([snapshot]).size);
      this.#backupSizeState = state;
    }
    return this.#backupSizeLabel;
  }

  #renderNotFound() {
    return `<section class="empty-state"><h1>这个项目不在舰桥上</h1><p>它可能来自旧链接、已经被移除，或备份尚未恢复。</p><a class="primary-button" href="#/">返回项目舰桥</a></section>`;
  }

  #renderSessionDock(session, project) {
    const stale = inspectSession(session).stale;
    return `<div class="active-session-dock" data-stale="${stale}"><a class="dock-main" href="#/project/${encodeURIComponent(project.id)}" aria-label="返回活动会话：${attr(project.title)}"><span class="dock-pulse"></span><span class="dock-copy"><small>${stale ? "可能未收拢" : "活动会话"}</small><strong>${escapeHTML(project.title)}</strong></span><span class="dock-time js-session-timer" data-started-at="${attr(session.startedAt)}">${formatDuration(elapsedSeconds(session.startedAt))}</span>${icon("arrow")}</a><button class="dock-quick" type="button" data-action="quick-dock" data-session-id="${attr(session.id)}" aria-label="快速停靠：${attr(controlContext(project.title))}" title="快速停靠（Ctrl/⌘ Shift S）">快速停靠</button></div>`;
  }

  #renderDialogs(project, activeSession, reentryCard) {
    const state = this.#store.getState();
    const projectTemplate = this.#newProjectTemplate;
    const templateColor = projectTemplate && Object.hasOwn(COLOR_LABELS, projectTemplate.color) ? projectTemplate.color : "fern";
    const pendingArchiveProject = project?.id === this.#pendingArchiveId ? project : null;
    const reviewCheckpoint = reentryCard?.checkpoint ?? null;
    const captureWindow = buildQuickCaptureProjectWindow(state, {
      preferredIds: [project?.id, activeSession?.projectId, state.ui.selectedProjectId]
    });
    const captureProjectId = captureWindow.items[0]?.id;
    const captureProjectOptions = renderQuickCaptureProjectOptions(captureWindow.items, captureProjectId, activeSession?.projectId);
    return `
      <dialog id="new-project-dialog" data-template-source-id="${attr(projectTemplate?.sourceProjectId ?? "")}" aria-labelledby="new-project-title" aria-describedby="new-project-description">
        <div class="dialog-header"><div><h2 id="new-project-title">${projectTemplate ? "从现有项目建立新现场" : "建立工作现场"}</h2><p id="new-project-description">${projectTemplate ? "已带入名称、目的、下一动作和识别颜色；会话、轨迹与检查点不会复制。" : "只需一个清楚的名字；其他信息以后再补也可以。"}</p></div><button class="icon-button dialog-close" type="button" data-action="close-dialog" aria-label="关闭">${icon("close")}</button></div>
        <form class="dialog-body" data-form="new-project">
          <label class="field"><span class="required">项目名称</span><input name="title" value="${attr(projectTemplate?.title ?? "")}" maxlength="${IMPORT_LIMITS.projectTitle}" placeholder="例如：重构论文结果图" required autofocus /></label>
          <label class="field"><span>为什么要做</span><textarea name="description" maxlength="${IMPORT_LIMITS.projectDescription}" placeholder="一句话说明目的，帮助未来的自己快速校准。">${escapeHTML(projectTemplate?.description ?? "")}</textarea></label>
          <label class="field"><span>已知的第一动作</span><input name="nextAction" value="${attr(projectTemplate?.nextAction ?? "")}" maxlength="${IMPORT_LIMITS.nextAction}" placeholder="例如：打开 figure_03.ipynb，核对配色映射" /></label>
          <fieldset class="field-group color-fieldset"><legend class="field-label">识别颜色</legend><div class="color-options">${Object.keys(COLOR_LABELS).map((name) => `<label class="color-choice" title="${COLOR_LABELS[name]}"><input type="radio" name="color" value="${name}" aria-label="${COLOR_LABELS[name]}" ${name === templateColor ? "checked" : ""}/><span class="color-swatch color-swatch-${name}"></span></label>`).join("")}</div></fieldset>
          <div class="dialog-actions"><button class="ghost-button" type="button" data-action="close-dialog">取消</button><button class="primary-button" type="submit">建立项目</button></div>
        </form>
      </dialog>
      <dialog id="quick-capture-dialog" aria-labelledby="quick-capture-title">
        <div class="dialog-header"><div><h2 id="quick-capture-title">跨项目快捷记录</h2><p>不离开当前页面，把刚出现的证据放回正确现场。</p></div><button class="icon-button dialog-close" type="button" data-action="close-dialog" aria-label="关闭">${icon("close")}</button></div>
        <form class="dialog-body" data-form="quick-capture" autocomplete="off">
          <label class="field"><span>筛选目标项目</span><input type="search" data-control="quick-project-filter" maxlength="${QUICK_CAPTURE_QUERY_LIMIT}" placeholder="输入项目名称、说明或下一步" aria-describedby="quick-project-filter-status" /></label>
          <p class="field-hint" id="quick-project-filter-status" data-quick-project-status aria-live="polite">${escapeHTML(quickCaptureProjectStatus(captureWindow))}</p>
          <label class="field"><span class="required">目标项目</span><select name="projectId" required ${captureWindow.items.length ? "" : "disabled"}>${captureProjectOptions}</select></label>
          <label class="field"><span class="required">证据类型</span><select name="type">${Object.entries(CRUMB_LABELS).map(([value, label]) => `<option value="${value}">${label}</option>`).join("")}</select></label>
          <label class="field"><span class="required">刚刚发生了什么</span><textarea name="text" maxlength="${IMPORT_LIMITS.crumbText}" placeholder="一句话即可；它会保留真实记录时间。" required autofocus></textarea></label>
          <label class="check-row"><input type="checkbox" name="pinned" /><span><strong>同时设为置顶航标</strong><small>适合长期约束、关键决定或回来时必须先看的线索。</small></span></label>
          <div class="dialog-actions"><button class="ghost-button" type="button" data-action="close-dialog">取消</button><button class="primary-button" type="submit">${icon("plus")} 保存轨迹</button></div>
        </form>
      </dialog>
      <dialog id="start-session-dialog" aria-labelledby="start-session-title">
        <div class="dialog-header"><div><h2 id="start-session-title">开始一次有意图的会话</h2><p>意图不是结果承诺，只是这段时间的方向。</p></div><button class="icon-button dialog-close" type="button" data-action="close-dialog" aria-label="关闭">${icon("close")}</button></div>
        <form class="dialog-body" data-form="start-session">
          <input type="hidden" name="projectId" value="${attr(project?.id ?? "")}" />
          <label class="field"><span class="required">这次准备推进什么</span><textarea name="intention" maxlength="${IMPORT_LIMITS.sessionIntention}" placeholder="例如：先验证图例排序是否与正文一致" required>${escapeHTML(project?.nextAction ?? "")}</textarea></label>
          <div class="dialog-actions"><button class="ghost-button" type="button" data-action="close-dialog">取消</button><button class="primary-button" type="submit">${icon("play")} 开始计时</button></div>
        </form>
      </dialog>
      <dialog id="checkpoint-dialog" data-context-id="${attr(activeSession?.id ?? "")}" aria-labelledby="checkpoint-title">
        <div class="dialog-header"><div><h2 id="checkpoint-title">留下可靠检查点</h2><p>给下次回来的自己一条短而清楚的路。</p></div><button class="icon-button dialog-close" type="button" data-action="close-dialog" aria-label="关闭">${icon("close")}</button></div>
        <form class="dialog-body" data-form="checkpoint">
          <label class="field"><span class="required">现在停在哪里</span><textarea name="summary" maxlength="${IMPORT_LIMITS.checkpointSummary}" placeholder="已经完成什么、当前看到什么结果？" required></textarea></label>
          <label class="field"><span class="required">回来后的第一物理动作</span><textarea name="nextAction" maxlength="${IMPORT_LIMITS.nextAction}" placeholder="避免‘继续做’，写成能直接动手的动作。" required>${escapeHTML(project?.nextAction ?? "")}</textarea></label>
          <label class="field"><span>仍未闭合的事项</span><textarea name="openLoops" maxlength="${IMPORT_LIMITS.openLoops}" placeholder="问题、依赖、需要确认的人或材料。"></textarea></label>
          <label class="field"><span>复航提示</span><input name="returnHint" maxlength="${IMPORT_LIMITS.returnHint}" placeholder="例如：先看 README 的实验 4 小节，不必重跑前两组" /></label>
          <div class="dialog-actions"><button class="ghost-button" type="button" data-action="close-dialog">继续工作</button><button class="primary-button" type="submit">${icon("check")} 保存并结束会话</button></div>
        </form>
      </dialog>
      ${reviewCheckpoint?.captureMode === "quick" ? `
      <dialog id="quick-review-dialog" aria-labelledby="quick-review-title" aria-describedby="quick-review-description">
        <div class="dialog-header"><div><h2 id="quick-review-title">复核快速停靠检查点</h2><p id="quick-review-description">确认当时留下的线索，补成一份新的可靠检查点；原记录仍会保留。</p></div><button class="icon-button dialog-close" type="button" data-action="close-dialog" aria-label="取消复核并关闭">${icon("close")}</button></div>
        <form class="dialog-body" data-form="quick-review">
          <input type="hidden" name="projectId" value="${attr(project.id)}" />
          <input type="hidden" name="sourceCheckpointId" value="${attr(reviewCheckpoint.id)}" />
          <label class="field"><span class="required">确认后的当前状态</span><textarea name="summary" maxlength="${IMPORT_LIMITS.checkpointSummary}" required>${escapeHTML(reviewCheckpoint.summary === QUICK_DOCK_NOT_RECORDED.summary ? "" : reviewCheckpoint.summary)}</textarea></label>
          <label class="field"><span class="required">回来后的第一物理动作</span><textarea name="nextAction" maxlength="${IMPORT_LIMITS.nextAction}" required>${escapeHTML(reviewCheckpoint.nextAction === QUICK_DOCK_NOT_RECORDED.nextAction ? "" : reviewCheckpoint.nextAction)}</textarea></label>
          <label class="field"><span>仍未闭合的事项</span><textarea name="openLoops" maxlength="${IMPORT_LIMITS.openLoops}">${escapeHTML(reviewCheckpoint.openLoops === QUICK_DOCK_NOT_RECORDED.openLoops ? "" : reviewCheckpoint.openLoops)}</textarea></label>
          <label class="field"><span>材料入口或恢复提示</span><input name="returnHint" maxlength="${IMPORT_LIMITS.returnHint}" placeholder="例如：先打开 README 的实验 4 小节" /></label>
          <div class="dialog-actions"><button class="ghost-button" type="button" data-action="close-dialog">稍后再说</button><button class="primary-button" type="submit">${icon("check")} 保存可靠检查点</button></div>
        </form>
      </dialog>` : ""}
      <dialog id="edit-project-dialog" aria-labelledby="edit-project-title">
        <div class="dialog-header"><div><h2 id="edit-project-title">编辑项目现场</h2><p>项目目的应帮助未来的自己快速判断方向。</p></div><button class="icon-button dialog-close" type="button" data-action="close-dialog" aria-label="关闭">${icon("close")}</button></div>
        <form class="dialog-body" data-form="edit-project">
          <input type="hidden" name="projectId" value="${attr(project?.id ?? "")}" />
          <label class="field"><span class="required">项目名称</span><input name="title" maxlength="${IMPORT_LIMITS.projectTitle}" value="${attr(project?.title ?? "")}" required /></label>
          <label class="field"><span>项目目的</span><textarea name="description" maxlength="${IMPORT_LIMITS.projectDescription}">${escapeHTML(project?.description ?? "")}</textarea></label>
          <label class="field"><span>当前第一动作</span><textarea name="nextAction" maxlength="${IMPORT_LIMITS.nextAction}">${escapeHTML(project?.nextAction ?? "")}</textarea></label>
          <div class="dialog-actions"><button class="ghost-button" type="button" data-action="close-dialog">取消</button><button class="primary-button" type="submit">保存修改</button></div>
        </form>
      </dialog>
      <dialog id="search-dialog" class="search-dialog" aria-labelledby="search-title">
        <div class="dialog-header"><div><h2 id="search-title">找回工作现场</h2><p>搜索项目、轨迹与检查点，或直接执行常用动作；数据不会离开浏览器。</p></div><button class="icon-button dialog-close" type="button" data-action="close-dialog" aria-label="关闭">${icon("close")}</button></div>
        <div class="dialog-body">
          <label class="search-field">${icon("search")}<span class="sr-only">搜索所有工作现场或筛选动作</span><input type="search" data-control="workspace-search" maxlength="${SEARCH_QUERY_LIMIT}" placeholder="输入项目、决定、问题或下一步…" autocomplete="off" autofocus /></label>
          <div class="search-results" data-search-results aria-live="polite">${this.#renderSearchResults("")}</div>
        </div>
      </dialog>
      <dialog id="archive-confirm-dialog" data-context-id="${attr(pendingArchiveProject?.id ?? "")}" aria-labelledby="archive-confirm-title" aria-describedby="archive-confirm-description">
        <div class="dialog-header"><div><h2 id="archive-confirm-title">移入归档舱？</h2><p id="archive-confirm-description">项目会变为只读，但所有会话、轨迹和检查点都会保留，之后可随时恢复。</p></div><button class="icon-button dialog-close" type="button" data-action="close-dialog" aria-label="取消归档并关闭">${icon("close")}</button></div>
        <div class="dialog-body">
          <p class="import-rollback-note">准备归档：<strong data-archive-project-title>${pendingArchiveProject ? `“${escapeHTML(pendingArchiveProject.title)}”` : ""}</strong></p>
          <div class="dialog-actions"><button class="ghost-button" type="button" data-action="close-dialog" autofocus>取消</button><button class="danger-button" type="button" data-action="confirm-archive">确认移入归档</button></div>
        </div>
      </dialog>
      ${this.#renderImportPreviewDialog()}`;
  }

  #renderImportPreviewDialog() {
    const pending = this.#pendingImport;
    if (!pending) return "";
    const { preview } = pending;
    const labels = { projects: "项目", sessions: "会话", crumbs: "轨迹", checkpoints: "检查点" };
    const rows = Object.entries(preview.collections).map(([name, change]) => `
      <tr><th scope="row">${labels[name]}</th><td>${change.current}</td><td>${change.incoming}</td><td class="change-add">+${change.added}</td><td class="change-remove">−${change.removed}</td><td>${change.changed}</td></tr>`).join("");
    const sourceDetails = [
      preview.source.envelope ? "标准备份信封" : "原始工作区数据",
      preview.source.appVersion ? `应用 ${preview.source.appVersion}` : null,
      preview.source.exportedAt ? `导出于 ${formatDateTime(preview.source.exportedAt)}` : null,
      preview.source.checksumVerified ? "内容校验码已核对（非加密）" : preview.source.envelope ? "旧格式未含校验码" : null,
      formatBytes(pending.fileSize)
    ].filter(Boolean).join(" · ");
    const projectSections = [
      renderProjectChangeList("将新增", preview.projectChanges.added, preview.projectChanges.addedTotal, "added"),
      renderProjectChangeList("将移除", preview.projectChanges.removed, preview.projectChanges.removedTotal, "removed"),
      renderChangedProjectList(preview.projectChanges.changed, preview.projectChanges.changedTotal)
    ].filter(Boolean).join("");
    const warnings = [];
    if (preview.currentActiveSession) warnings.push(`当前“${preview.currentActiveSession.projectTitle}”的活动会话将被备份内容替换。`);
    if (preview.incomingActiveSession) warnings.push(`导入后会恢复“${preview.incomingActiveSession.projectTitle}”的活动会话：${preview.incomingActiveSession.intention || "未记录意图"}。`);
    if (preview.projectChanges.removedTotal) warnings.push(`${preview.projectChanges.removedTotal} 个仅存在于当前工作区的项目不会出现在导入结果中。`);
    if (pending.refreshed) warnings.push("预览期间工作区发生了变化，差异已按最新状态重新计算。请再次核对。 ");

    return `
      <dialog id="import-preview-dialog" class="import-preview-dialog" aria-labelledby="import-preview-title" aria-describedby="import-preview-description">
        <div class="dialog-header"><div><h2 id="import-preview-title">核对导入影响</h2><p id="import-preview-description">文件已在本机通过完整结构${preview.source.checksumVerified ? "与内容校验码" : ""}校验；确认后才会替换工作区。</p></div><button class="icon-button dialog-close" type="button" data-action="close-dialog" aria-label="取消导入并关闭">${icon("close")}</button></div>
        <div class="dialog-body">
          <div class="import-file-summary"><span>${icon("shield")}</span><div><strong>${escapeHTML(pending.fileName)}</strong><small>${escapeHTML(sourceDetails)}</small></div></div>
          ${preview.hasContentChanges ? "" : `<div class="import-identical">${icon("check")}<span>项目、记录和设置与当前工作区一致，无需重复导入。</span></div>`}
          ${warnings.length ? `<div class="import-warnings" role="note">${warnings.map((warning) => `<p>${icon("alert")}<span>${escapeHTML(warning)}</span></p>`).join("")}</div>` : ""}
          <div class="import-table-wrap"><table class="import-diff-table"><caption class="sr-only">当前工作区与导入结果的记录差异</caption><thead><tr><th scope="col">记录</th><th scope="col">当前</th><th scope="col">导入后</th><th scope="col">新增</th><th scope="col">移除</th><th scope="col">更新</th></tr></thead><tbody>${rows}</tbody></table></div>
          ${projectSections ? `<div class="import-project-changes">${projectSections}</div>` : ""}
          ${(preview.settingsChanged || preview.selectionChanged || preview.orderChangedCollections.length) ? `<p class="import-meta-note">${icon("info")}<span>${preview.settingsChanged ? "界面设置会采用备份版本。" : ""}${preview.selectionChanged ? " 当前选中的项目也会更新。" : ""}${preview.orderChangedCollections.length ? " 同 ID 记录的排列顺序存在变化。" : ""}</span></p>` : ""}
          <p class="import-rollback-note">当前工作区会自动成为滚动安全快照；导入后可使用“撤销上一次保存”切回。</p>
          <div class="dialog-actions"><button class="ghost-button" type="button" data-action="close-dialog">取消</button><button class="danger-button" type="button" data-action="confirm-import" ${preview.hasContentChanges ? "" : "disabled"}>确认替换工作区</button></div>
        </div>
      </dialog>`;
  }

  #renderNotices() {
    if (!this.#noticeQueue.length) return "";
    return this.#noticeQueue.map((notice) => `<div class="notice-banner">${icon("alert")}<span>${escapeHTML(notice)}</span></div>`).join("");
  }

  #renderSessionInvariantNotice(counts, activeSession, activeProject) {
    if (counts.activeSessions > 1) {
      return `<section class="notice-banner" role="alert">${icon("alert")} 检测到 ${counts.activeSessions} 个活动会话，已停止选择任意现场。请从数据保险箱恢复一份有效备份。</section>`;
    }
    if (activeSession && !activeProject) {
      return `<section class="notice-banner" role="alert">${icon("alert")} 活动会话关联的项目不存在，已停止显示悬浮会话。请从数据保险箱恢复一份有效备份。</section>`;
    }
    return "";
  }

  #onClick(event) {
    const control = event.target.closest("[data-action]");
    if (!control) return;
    const action = control.dataset.action;

    if (action === "open-new-project") this.#openNewProjectDialog();
    if (action === "use-project-template") this.#prepareProjectTemplateDialog(control.dataset.projectId);
    if (action === "open-quick-capture") this.#openDialog("quick-capture-dialog");
    if (action === "open-search") this.#openDialog("search-dialog");
    if (action === "undo-last") this.#restorePrevious(control.dataset.undoContext);
    if (action === "close-dialog") this.#closeDialog(control);
    if (action === "confirm-import") this.#confirmImport();
    if (action === "run-command") this.#runCommand(control.dataset.command, control.closest("dialog"));
    if (action === "edit-project") this.#prepareProjectEditDialog();
    if (action === "open-checkpoint") this.#prepareCheckpointDialog();
    if (action === "review-quick-checkpoint") this.#openDialog("quick-review-dialog");
    if (action === "start-session") this.#prepareSessionDialog(control.dataset.projectId);
    if (action === "quick-dock") this.#quickDock(control.dataset.sessionId, false);
    if (action === "interrupt-and-continue") this.#quickDock(control.dataset.sessionId, true);
    if (action === "continue-session") this.#continueStaleSession(control.dataset.sessionId);
    if (action === "archive-project") this.#prepareArchive(control.dataset.projectId);
    if (action === "confirm-archive") this.#confirmArchive();
    if (action === "restore-project") this.#restoreProject(control.dataset.projectId);
    if (action === "load-sample") this.#loadSample();
    if (action === "export-data") this.#exportData();
    if (action === "copy-workspace-handoff") this.#copyWorkspaceHandoff();
    if (action === "copy-reentry-brief") this.#copyReentryBrief(control.dataset.projectId);
    if (action === "choose-import") this.#root.querySelector("#import-file")?.click();
    if (action === "set-theme") this.#setTheme(control.dataset.theme);
    if (action === "set-motion") this.#setReducedMotion(control.dataset.reducedMotion);
    if (action === "request-persistent-storage") this.#requestPersistentStorage(true);
    if (action === "toggle-crumb-resolution") this.#toggleCrumbResolution(control.dataset.crumbId, control.dataset.resolutionContext);
    if (action === "toggle-crumb-pin") this.#toggleCrumbPin(control.dataset.crumbId);
    if (action === "show-more-timeline") this.#showMoreTimeline(control.dataset.projectId);
    if (action === "show-more-projects") this.#showMoreProjects(control.dataset.scope);
  }

  #onSubmit(event) {
    const form = event.target.closest("form[data-form]");
    if (!form) return;
    event.preventDefault();
    const data = Object.fromEntries(new FormData(form));
    try {
      if (form.dataset.form === "new-project") this.#createProject(data, form);
      if (form.dataset.form === "start-session") this.#startSession(data, form);
      if (form.dataset.form === "capture-crumb") this.#captureCrumb(data);
      if (form.dataset.form === "quick-capture") this.#quickCapture(data, form);
      if (form.dataset.form === "checkpoint") this.#saveCheckpoint(data, form);
      if (form.dataset.form === "quick-review") this.#reviewQuickCheckpoint(data, form);
      if (form.dataset.form === "edit-project") this.#editProject(data, form);
    } catch (error) {
      this.#toast(userFacingErrorMessage(error), "error");
    }
  }

  #onChange(event) {
    const control = event.target;
    if (control.matches('[data-control="project-status"]')) this.#changeProjectStatus(control.dataset.projectId, control.value);
    if (control.matches('[data-control="stale-days"]')) this.#setStaleAfterDays(control.value);
    if (control.matches('[data-control="import-file"]') && control.files?.[0]) this.#importData(control.files[0], control);
  }

  #onInput(event) {
    if (event.isComposing) return;
    const control = event.target;
    if (control.matches('[data-control="workspace-search"]')) {
      const output = this.#root.querySelector("[data-search-results]");
      if (output) output.innerHTML = this.#renderSearchResults(control.value);
      return;
    }
    if (control.matches('[data-control="quick-project-filter"]')) this.#updateQuickCaptureProjects(control);
  }

  #updateQuickCaptureProjects(control) {
    const form = control.closest('[data-form="quick-capture"]');
    const select = form?.elements?.projectId;
    const status = form?.querySelector("[data-quick-project-status]");
    if (!select) return;
    const state = this.#store.getState();
    const activeSession = this.#activeSession;
    const captureWindow = buildQuickCaptureProjectWindow(state, {
      query: control.value,
      preferredIds: [select.value, activeSession?.projectId, state.ui.selectedProjectId]
    });
    select.innerHTML = renderQuickCaptureProjectOptions(captureWindow.items, captureWindow.items[0]?.id, activeSession?.projectId);
    select.disabled = captureWindow.items.length === 0;
    if (status) status.textContent = quickCaptureProjectStatus(captureWindow);
  }

  #runUserAction(action) {
    if (this.#destroyed) return;
    try {
      action();
    } catch (error) {
      this.#toast(userFacingErrorMessage(error), "error");
    }
  }

  #renderSearchResults(query) {
    if (!String(query).trim()) return this.#renderQuickCommands();
    const { items: results, total } = searchWorkspaceIndexWindow(this.#getSearchIndex(), query);
    if (!results.length) return `<p class="search-empty">没有找到“${escapeHTML(query)}”。试试更短或更具体的词。</p>`;
    const kindLabels = { project: "项目", crumb: "轨迹", checkpoint: "检查点" };
    const countLabel = total > results.length
      ? `找到 ${total} 条匹配，显示前 ${results.length} 条`
      : `找到 ${total} 条匹配`;
    return `<p class="search-count">${countLabel}</p><ul>${results.map((result) => `<li><a href="#/project/${encodeURIComponent(result.projectId)}"><span class="search-result-kind">${escapeHTML(result.kind === "crumb" ? CRUMB_LABELS[result.subtype] ?? "轨迹" : kindLabels[result.kind] ?? "记录")}${result.projectStatus === "archived" ? " · 已归档" : ""}</span><strong>${escapeHTML(result.title || result.projectTitle)}</strong>${result.kind !== "project" ? `<small>${escapeHTML(result.projectTitle)} · ${formatDateTime(result.createdAt)}</small>` : ""}${result.snippet && result.snippet !== result.title ? `<p>${escapeHTML(result.snippet)}</p>` : ""}</a></li>`).join("")}</ul>`;
  }

  #getSearchIndex() {
    const state = this.#store.getState();
    if (state !== this.#searchIndexState) {
      this.#searchIndexState = state;
      this.#searchIndex = buildWorkspaceSearchIndex(state);
    }
    return this.#searchIndex;
  }

  #renderQuickCommands() {
    const counts = this.#workspaceCounts ?? buildWorkspaceCounts(this.#store.getState());
    const hasProjects = counts.unarchivedProjects > 0;
    const activeSessionCount = counts.activeSessions;
    const canUndo = this.#store.hasPreviousSnapshot();
    const commands = [
      ...(activeSessionCount ? [["quick-dock", activeSessionCount === 1 ? "archive" : "alert", activeSessionCount === 1 ? "应急停靠" : "会话冲突", activeSessionCount === 1 ? "立即收拢活动会话 · Ctrl/⌘ Shift S" : `检测到 ${activeSessionCount} 个活动会话，需先恢复有效备份`, activeSessionCount !== 1]] : []),
      ["quick-capture", "trail", "快捷记录", "选择项目并保存一条证据", !hasProjects],
      ["new-project", "plus", "建立项目", "创建一个新的工作现场", false],
      ["undo", "undo", "撤销上次保存", "可再次操作切回", !canUndo],
      ["export", "download", "导出完整备份", "下载本地 JSON 信封", false],
      ["home", "home", "项目舰桥", "查看所有未归档项目", false],
      ["archive", "archive", "归档舱", "查看只读历史现场", false],
      ["settings", "settings", "数据保险箱", "主题、备份与滚动快照", false]
    ];
    return `<div class="command-panel" aria-label="快捷动作"><p class="search-count">快捷动作 · 输入文字可搜索全部证据</p><div class="command-grid">${commands.map(([value, iconName, label, detail, disabled]) => `<button type="button" data-action="run-command" data-command="${value}" ${disabled ? "disabled" : ""}>${icon(iconName)}<span><strong>${label}</strong><small>${detail}</small></span></button>`).join("")}</div></div>`;
  }

  #onKeydown(event) {
    if (event.defaultPrevented) return;
    if (this.#root.querySelector("dialog[open]")) return;
    if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === "s") {
      event.preventDefault();
      this.#quickDock(undefined, false);
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      this.#openDialog("search-dialog");
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === "c") {
      event.preventDefault();
      if (this.#workspaceCounts?.unarchivedProjects) this.#openDialog("quick-capture-dialog");
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z" && !isTypingTarget(event.target)) {
      event.preventDefault();
      this.#restorePrevious("topbar");
      return;
    }
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (isTypingTarget(event.target)) return;
    if (event.key.toLowerCase() === "n") {
      event.preventDefault();
      this.#openNewProjectDialog();
    }
    if (event.key.toLowerCase() === "c") {
      const capture = this.#root.querySelector('[data-form="capture-crumb"] textarea');
      if (capture) {
        event.preventDefault();
        capture.focus();
      }
    }
    if (event.key === "/" || event.key === "?") {
      event.preventDefault();
      this.#openDialog("search-dialog");
    }
  }

  #runCommand(command, dialog) {
    dialog?.close();
    requestAnimationFrame(() => {
      if (this.#destroyed) return;
      this.#runUserAction(() => {
        if (command === "quick-capture") this.#openDialog("quick-capture-dialog");
        if (command === "quick-dock") this.#quickDock(undefined, false);
        if (command === "new-project") this.#openNewProjectDialog();
        if (command === "undo") this.#restorePrevious("topbar");
        if (command === "export") this.#exportData();
        if (command === "home") location.hash = "#/";
        if (command === "archive") location.hash = "#/archive";
        if (command === "settings") location.hash = "#/settings";
      });
    });
  }

  #createProject(data, form) {
    const project = createProject(data, isoAtOrAfter(Date.now(), this.#store.getState().meta.updatedAt));
    this.#store.update((state) => {
      state.projects.push(project);
      state.ui.selectedProjectId = project.id;
    });
    this.#newProjectTemplate = null;
    form.closest("dialog")?.close();
    location.hash = `#/project/${encodeURIComponent(project.id)}`;
    this.#requestPersistentStorage();
    this.#toast("项目现场已建立。 ");
  }

  #prepareSessionDialog(projectId) {
    const state = this.#store.getState();
    const plan = prepareSessionDialog(state, projectId);
    if (plan.activeSession) {
      this.#toast(`“${plan.activeProject.title}”仍有活动会话，请先留下检查点。`, "error");
      return;
    }
    const dialog = this.#root.querySelector("#start-session-dialog");
    dialog.querySelector('[name="projectId"]').value = plan.project.id;
    dialog.querySelector('[name="intention"]').value = plan.project.nextAction || "";
    this.#openDialog("start-session-dialog");
  }

  #startSession(data, form) {
    const state = this.#store.getState();
    const { project, projectIndex, sourceCheckpoint } = prepareSessionStart(state, data.projectId);
    const session = createSession(
      { projectId: project.id, intention: data.intention, sourceCheckpointId: sourceCheckpoint?.id ?? null },
      isoAtOrAfter(Date.now(), project.updatedAt, sourceCheckpoint?.createdAt)
    );
    this.#focusSelector = '[data-form="capture-crumb"] textarea';
    this.#store.update((next) => {
      const item = next.projects[projectIndex];
      if (!item || item.id !== project.id || item.status === "archived") {
        throw new Error("项目在开始会话前已不可用。 ");
      }
      next.sessions.push(session);
      item.lastOpenedAt = session.startedAt;
      item.updatedAt = session.startedAt;
      if (item.status === "paused") item.status = "active";
    });
    form.closest("dialog")?.close();
    location.hash = `#/project/${encodeURIComponent(project.id)}`;
    this.#announce("会话已开始");
    this.#toast("工作现场已展开。 ");
  }

  #captureCrumb(data) {
    const state = this.#store.getState();
    const context = locateActiveSessionContext(state);
    if (!context) throw new Error("没有活动会话，无法记录现场。 ");
    const { session, sessionIndex, project, projectIndex } = context;
    const crumb = createCrumb(
      { projectId: session.projectId, sessionId: session.id, type: data.type, text: data.text },
      isoAtOrAfter(Date.now(), session.startedAt, project?.updatedAt)
    );
    if (!crumb.text) throw new Error("先写下一条记录。 ");
    this.#focusSelector = '[data-form="capture-crumb"] textarea';
    this.#store.update((next) => {
      const currentSession = next.sessions[sessionIndex];
      const currentProject = next.projects[projectIndex];
      if (currentSession?.id !== session.id || currentSession.status !== "active"
        || currentProject?.id !== session.projectId || currentProject.status === "archived") {
        throw new Error("活动现场在保存前已发生变化。 ");
      }
      next.crumbs.push(crumb);
      currentProject.updatedAt = crumb.createdAt;
      if (crumb.type === "next") {
        currentProject.nextAction = projectNextActionFromCrumb(crumb);
        currentProject.nextActionUpdatedAt = crumb.createdAt;
      }
    });
    this.#announce(`${CRUMB_LABELS[crumb.type]}已记录`);
    this.#toast(`${CRUMB_LABELS[crumb.type]}已留在轨迹中。`);
  }

  #quickCapture(data, form) {
    const state = this.#store.getState();
    const { crumb, projectIndex, projectTitle, linkedToActiveSession } = prepareQuickCapture(state, data);
    this.#focusSelector = '[data-action="open-quick-capture"]';
    this.#store.update((next) => {
      const target = next.projects[projectIndex];
      if (!target || target.id !== crumb.projectId || target.status === "archived") {
        throw new Error("目标项目在保存前已不可用。 ");
      }
      next.crumbs.push(crumb);
      target.updatedAt = crumb.createdAt;
      if (crumb.type === "next") {
        target.nextAction = projectNextActionFromCrumb(crumb);
        target.nextActionUpdatedAt = crumb.createdAt;
      }
    });
    form.closest("dialog")?.close();
    this.#announce(`${projectTitle}的${CRUMB_LABELS[crumb.type]}已记录`);
    this.#toast(`已保存到“${projectTitle}”${linkedToActiveSession ? "的活动会话" : ""}${crumb.pinned ? "，并设为航标" : ""}。`);
  }

  #prepareCheckpointDialog() {
    const context = locateActiveSessionContext(this.#store.getState());
    if (!context) throw new Error("没有活动会话，无法留下检查点。 ");
    this.#pendingCheckpointSessionId = context.session.id;
    this.#openDialog("checkpoint-dialog");
  }

  #saveCheckpoint(data, form) {
    const pendingSessionId = this.#pendingCheckpointSessionId;
    if (!pendingSessionId) throw new Error("检查点上下文已失效，请重新打开表单。 ");
    const state = this.#store.getState();
    const context = locateActiveSessionContext(state);
    if (!context) throw new Error("活动会话已经结束。 ");
    const { session, sessionIndex, project, projectIndex } = context;
    if (session.id !== pendingSessionId) throw new Error("活动会话在填写检查点期间已切换，请重新打开表单。 ");
    const checkpoint = createCheckpoint(
      { ...data, projectId: session.projectId, sessionId: session.id },
      isoAtOrAfter(Date.now(), session.startedAt, project?.updatedAt)
    );
    if (!checkpoint.summary || !checkpoint.nextAction) throw new Error("状态摘要和第一物理动作不能为空。 ");
    this.#focusSelector = "#main-content";
    this.#store.update((next) => {
      const currentSession = next.sessions[sessionIndex];
      const currentProject = next.projects[projectIndex];
      if (currentSession?.id !== session.id || currentSession.status !== "active"
        || currentProject?.id !== session.projectId || currentProject.status === "archived") {
        throw new Error("活动现场在保存检查点前已发生变化。 ");
      }
      next.checkpoints.push(checkpoint);
      currentSession.status = "completed";
      currentSession.endedAt = checkpoint.createdAt;
      currentSession.checkpointId = checkpoint.id;
      currentSession.closeReason = "checkpoint";
      currentProject.nextAction = checkpoint.nextAction;
      currentProject.nextActionUpdatedAt = checkpoint.createdAt;
      currentProject.updatedAt = checkpoint.createdAt;
    });
    this.#pendingCheckpointSessionId = null;
    form.closest("dialog")?.close();
    this.#announce("检查点已保存，会话已结束");
    this.#toast("现场已安全收拢，下次可以从这里复航。 ");
  }

  #reviewQuickCheckpoint(data, form) {
    const { checkpoint, projectIndex, projectTitle } = prepareQuickCheckpointReview(this.#store.getState(), data);
    this.#focusSelector = "#reentry-card-heading";
    this.#store.update((state) => {
      const project = state.projects[projectIndex];
      if (!project || project.id !== checkpoint.projectId || project.status === "archived") {
        throw new Error("项目在保存前已不可用。");
      }
      state.checkpoints.push(checkpoint);
      project.nextAction = checkpoint.nextAction;
      project.nextActionUpdatedAt = checkpoint.createdAt;
      project.updatedAt = checkpoint.createdAt;
    }, Date.parse(checkpoint.createdAt));
    form.closest("dialog")?.close();
    this.#announce("快速检查点已复核为可靠检查点");
    this.#toast(`“${projectTitle}”已建立新的可靠检查点。`);
  }

  #continueStaleSession(sessionId) {
    if (!sessionId || this.#activeSession?.id !== sessionId) throw new Error("活动会话已经变化，请重新确认。 ");
    this.#acknowledgedStaleSessionId = sessionId;
    this.#focusSelector = '[data-form="capture-crumb"] textarea';
    this.render();
    this.#announce("继续原会话；计时保持不变");
  }

  #quickDock(sessionId, continueAfter) {
    try {
      const state = this.#store.getState();
      const now = Date.now();
      const { input, session: activeSession, sessionIndex, project, projectIndex } = prepareQuickDock(state, sessionId, now);
      const targetSessionId = activeSession.id;
      const eventTime = isoAtOrAfter(now, activeSession.startedAt, project.updatedAt);
      const checkpoint = createCheckpoint(input, eventTime);
      const recordedNextAction = input.nextAction !== QUICK_DOCK_NOT_RECORDED.nextAction;
      const followUp = continueAfter ? createSession({
        projectId: activeSession.projectId,
        intention: recordedNextAction ? input.nextAction : activeSession.intention,
        sourceCheckpointId: checkpoint.id
      }, Date.parse(eventTime) + 1) : null;

      this.#focusSelector = continueAfter ? '[data-form="capture-crumb"] textarea' : "#main-content";
      this.#store.update((next) => {
        const current = next.sessions[sessionIndex];
        const currentProject = next.projects[projectIndex];
        if (current?.id !== targetSessionId || current.status !== "active"
          || currentProject?.id !== current.projectId || currentProject.status === "archived") {
          throw new Error("会话状态刚刚发生变化，请重新确认。 ");
        }
        next.checkpoints.push(checkpoint);
        current.status = "abandoned";
        current.endedAt = checkpoint.createdAt;
        current.checkpointId = checkpoint.id;
        current.closeReason = continueAfter ? "interrupted" : "quick-dock";
        currentProject.updatedAt = checkpoint.createdAt;
        if (recordedNextAction) {
          currentProject.nextAction = input.nextAction;
          currentProject.nextActionUpdatedAt = checkpoint.createdAt;
        }
        if (followUp) {
          next.sessions.push(followUp);
          currentProject.lastOpenedAt = followUp.startedAt;
          currentProject.updatedAt = followUp.startedAt;
        }
      }, followUp ? Date.parse(followUp.startedAt) : now);

      if (this.#acknowledgedStaleSessionId === targetSessionId) this.#acknowledgedStaleSessionId = null;
      this.#announce(continueAfter ? "旧会话已标记中断，并已开始接续会话" : "会话已快速停靠");
      this.#toast(continueAfter ? "旧现场已保留，接续会话已经开始。" : "已用现有证据生成低置信度检查点。 ");
    } catch (error) {
      this.#toast(userFacingErrorMessage(error), "error");
    }
  }

  #editProject(data, form) {
    const title = String(data.title ?? "").trim();
    if (!title) throw new Error("项目名称不能只包含空格。 ");
    const pending = this.#pendingProjectEdit;
    if (!pending || pending.projectId !== data.projectId) throw new Error("编辑上下文已失效，请重新打开表单。 ");
    this.#focusSelector = '[data-action="edit-project"]';
    this.#store.update((state) => {
      const { project } = prepareProjectEdit(state, pending.projectId, pending.editToken);
      const changedAt = isoAtOrAfter(Date.now(), project.updatedAt);
      project.title = title;
      project.description = String(data.description ?? "").trim();
      project.descriptionUpdatedAt = changedAt;
      project.nextAction = String(data.nextAction ?? "").trim();
      project.nextActionUpdatedAt = project.nextAction ? project.descriptionUpdatedAt : null;
      project.updatedAt = project.descriptionUpdatedAt;
    });
    this.#pendingProjectEdit = null;
    form.closest("dialog")?.close();
    this.#toast("项目说明已更新。 ");
  }

  #prepareProjectEditDialog() {
    const state = this.#store.getState();
    const route = parseRoute(location.hash);
    if (route.name !== "project") throw new Error("当前页面没有可编辑的项目。 ");
    const { project, editToken } = prepareProjectEdit(state, route.id);
    this.#pendingProjectEdit = { projectId: project.id, editToken };
    this.#openDialog("edit-project-dialog");
  }

  #prepareProjectTemplateDialog(projectId) {
    const { draft } = prepareProjectTemplate(this.#store.getState(), projectId);
    const dialog = this.#root.querySelector("#new-project-dialog");
    const form = dialog?.querySelector('[data-form="new-project"]');
    if (!dialog || !form) throw new Error("无法打开新项目表单。 ");
    this.#newProjectTemplate = draft;
    dialog.dataset.templateSourceId = draft.sourceProjectId;
    dialog.querySelector("#new-project-title").textContent = "从现有项目建立新现场";
    dialog.querySelector("#new-project-description").textContent = "已带入名称、目的、下一动作和识别颜色；会话、轨迹与检查点不会复制。";
    form.reset();
    form.elements.title.value = draft.title;
    form.elements.description.value = draft.description;
    form.elements.nextAction.value = draft.nextAction;
    if (Object.hasOwn(COLOR_LABELS, draft.color)) form.elements.color.value = draft.color;
    this.#openDialog("new-project-dialog");
    form.elements.title.focus();
    form.elements.title.select();
  }

  #openNewProjectDialog() {
    const dialog = this.#root.querySelector("#new-project-dialog");
    if (dialog) this.#clearNewProjectTemplate(dialog);
    this.#openDialog("new-project-dialog");
  }

  #clearNewProjectTemplate(dialog) {
    if (!this.#newProjectTemplate && !dialog?.dataset.templateSourceId) return;
    this.#newProjectTemplate = null;
    delete dialog.dataset.templateSourceId;
    const form = dialog.querySelector('[data-form="new-project"]');
    form?.reset();
    if (form) {
      form.elements.title.value = "";
      form.elements.description.value = "";
      form.elements.nextAction.value = "";
      form.elements.color.value = "fern";
    }
    const title = dialog.querySelector("#new-project-title");
    const description = dialog.querySelector("#new-project-description");
    if (title) title.textContent = "建立工作现场";
    if (description) description.textContent = "只需一个清楚的名字；其他信息以后再补也可以。";
  }

  #changeProjectStatus(projectId, status) {
    if (!["active", "paused", "blocked"].includes(status)) return;
    try {
      this.#focusSelector = '[data-control="project-status"]';
      this.#store.update((state) => {
        const { project } = prepareProjectStatusChange(state, projectId, status);
        project.status = status;
        project.updatedAt = isoAtOrAfter(Date.now(), project.updatedAt);
      });
      this.#toast(`项目已标记为“${PROJECT_STATUS_LABELS[status]}”。`);
    } catch (error) {
      this.#toast(userFacingErrorMessage(error), "error");
    }
  }

  #toggleCrumbResolution(crumbId, context) {
    this.#focusSelector = `[data-action="toggle-crumb-resolution"][data-resolution-context="${CSS.escape(context || "timeline")}"][data-crumb-id="${CSS.escape(crumbId)}"]`;
    let resolved = false;
    this.#store.update((state) => {
      const crumb = state.crumbs.find((item) => item.id === crumbId);
      if (!crumb || !["question", "blocker"].includes(crumb.type)) throw new Error("找不到可处理的问题或阻塞。 ");
      const changedAt = isoAtOrAfter(Date.now(), crumb.createdAt, crumb.resolvedAt);
      crumb.resolvedAt = crumb.resolvedAt ? null : changedAt;
      resolved = Boolean(crumb.resolvedAt);
      const project = state.projects.find((item) => item.id === crumb.projectId);
      if (project) project.updatedAt = isoAtOrAfter(changedAt, project.updatedAt);
    });
    this.#announce(resolved ? "事项已标记为解决" : "事项已重新打开");
    this.#toast(resolved ? "已从待解决清单移除。" : "已重新加入待解决清单。");
  }

  #toggleCrumbPin(crumbId) {
    this.#focusSelector = `[data-action="toggle-crumb-pin"][data-crumb-id="${CSS.escape(crumbId)}"]`;
    let pinned = false;
    this.#store.update((state) => {
      const crumb = state.crumbs.find((item) => item.id === crumbId);
      if (!crumb) throw new Error("找不到要置顶的轨迹。 ");
      crumb.pinned = !crumb.pinned;
      pinned = crumb.pinned;
      const project = state.projects.find((item) => item.id === crumb.projectId);
      if (project) project.updatedAt = isoAtOrAfter(Date.now(), project.updatedAt, crumb.createdAt);
    });
    this.#announce(pinned ? "轨迹已设为置顶航标" : "轨迹已取消置顶");
    this.#toast(pinned ? "已加入复航卡的置顶航标。" : "已从置顶航标移除。 ");
  }

  #prepareArchive(projectId) {
    const state = this.#store.getState();
    const { project } = prepareProjectArchive(state, projectId);
    this.#pendingArchiveId = projectId;
    const dialog = this.#root.querySelector("#archive-confirm-dialog");
    const title = dialog?.querySelector("[data-archive-project-title]");
    if (title) title.textContent = `“${project.title}”`;
    this.#openDialog("archive-confirm-dialog");
  }

  #confirmArchive() {
    const projectId = this.#pendingArchiveId;
    if (!projectId) return;
    try {
      this.#pendingArchiveId = null;
      this.#store.update((next) => {
        const { projectIndex } = prepareProjectArchive(next, projectId);
        const item = next.projects[projectIndex];
        if (!item || item.id !== projectId || item.status === "archived") {
          throw new Error("项目在归档期间发生了变化，请重新打开确认。 ");
        }
        item.status = "archived";
        item.archivedAt = isoAtOrAfter(Date.now(), item.updatedAt);
        item.updatedAt = item.archivedAt;
      });
      location.hash = "#/";
      this.#toast("项目已移入归档舱。 ");
    } catch (error) {
      this.#pendingArchiveId = null;
      this.#root.querySelector("#archive-confirm-dialog")?.close();
      this.#toast(userFacingErrorMessage(error), "error");
    }
  }

  #restoreProject(projectId) {
    this.#focusSelector = "#main-content";
    this.#store.update((state) => {
      const { project } = prepareProjectRestore(state, projectId);
      project.status = "paused";
      project.archivedAt = null;
      project.updatedAt = isoAtOrAfter(Date.now(), project.updatedAt);
    });
    this.#toast("项目已恢复为暂泊状态。 ");
  }

  #setTheme(theme) {
    if (!["system", "light", "dark"].includes(theme)) return;
    this.#focusSelector = `[data-action="set-theme"][data-theme="${theme}"]`;
    this.#store.update((state) => { state.settings.theme = theme; });
  }

  #syncThemeColor(theme = this.#store.getState().settings.theme) {
    const appearance = resolveThemeAppearance(theme, Boolean(this.#colorSchemeQuery?.matches));
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", appearance.themeColor);
  }

  #setReducedMotion(value) {
    if (value !== "system" && value !== "reduce") throw new Error("动态效果设置不可用。");
    const reduced = value === "reduce";
    this.#focusSelector = `[data-action="set-motion"][data-reduced-motion="${value}"]`;
    this.#store.update((state) => { state.settings.reducedMotion = reduced; });
    this.#announce(reduced ? "已始终减少动态效果" : "动态效果已改为跟随系统");
  }

  #setStaleAfterDays(value) {
    const days = Number(value);
    if (!Number.isSafeInteger(days) || days < 1 || days > 365) throw new Error("离开提醒阈值必须在 1 到 365 天之间。");
    this.#focusSelector = '[data-control="stale-days"]';
    this.#store.update((state) => { state.settings.staleAfterDays = days; });
    this.#announce(`离开提醒阈值已设为 ${days} 天`);
    this.#toast(`关注清单将在离开 ${days} 天后提示核对。`);
  }

  #restorePrevious(context = "topbar") {
    try {
      if (!this.#store.hasPreviousSnapshot()) throw new Error("没有可恢复的上一次保存。 ");
      this.#focusSelector = `[data-action="undo-last"][data-undo-context="${CSS.escape(context)}"]`;
      this.#store.restorePrevious();
      this.#requestPersistentStorage();
      this.#announce("已恢复到上一次保存；再次操作可切换回来");
      this.#toast("已恢复上一次保存；需要时可再次撤销。 ");
    } catch (error) {
      this.#toast(userFacingErrorMessage(error), "error");
    }
  }

  #showMoreTimeline(projectId) {
    const currentLimit = this.#timelineLimits.get(projectId) ?? TIMELINE_PAGE_SIZE;
    const current = buildTimelineWindow(this.#store.getState().crumbs, projectId, currentLimit);
    if (!current.remaining) return;
    const expanded = buildTimelineWindow(this.#store.getState().crumbs, projectId, current.nextLimit);
    const firstNewItem = expanded.items[current.shown];
    this.#timelineLimits.delete(projectId);
    this.#timelineLimits.set(projectId, expanded.shown);
    while (this.#timelineLimits.size > MAX_REMEMBERED_TIMELINES) {
      this.#timelineLimits.delete(this.#timelineLimits.keys().next().value);
    }
    if (firstNewItem) this.#focusSelector = `[data-crumb-id="${CSS.escape(firstNewItem.id)}"]`;
    this.render();
    this.#announce(`已显示 ${expanded.shown} 条轨迹，还剩 ${expanded.remaining} 条`);
  }

  #showMoreProjects(scope) {
    if (scope !== "home" && scope !== "archive") return;
    const state = this.#store.getState();
    const counts = buildWorkspaceCounts(state);
    const total = scope === "home" ? counts.unarchivedProjects : counts.archivedProjects;
    const currentLimit = this.#collectionLimits.get(scope) ?? COLLECTION_PAGE_SIZE;
    if (currentLimit >= total) return;
    const shown = Math.min(total, currentLimit + COLLECTION_PAGE_SIZE);
    this.#collectionLimits.set(scope, shown);
    this.#focusSelector = `[data-project-window="${scope}"] [data-project-window-item="${currentLimit}"]`;
    this.render();
    this.#announce(`已显示 ${shown} 个${scope === "home" ? "项目" : "归档项目"}，还剩 ${total - shown} 个`);
  }

  #loadSample() {
    if (this.#store.getState().projects.length) return;
    const now = Date.now();
    const visual = createProject({ title: "重构研究结果图", description: "让六张结果图使用一致的视觉语法，并能直接进入论文终稿。", nextAction: "打开 figure_03.ipynb，核对第三组图例顺序", color: "amber", createdAt: new Date(now - 5 * 86_400_000).toISOString(), updatedAt: new Date(now - 22 * 3_600_000).toISOString(), lastOpenedAt: new Date(now - 22 * 3_600_000).toISOString() }, now);
    const session = createSession({ projectId: visual.id, intention: "统一图例顺序和颜色映射", status: "completed", startedAt: new Date(now - 24 * 3_600_000).toISOString(), endedAt: new Date(now - 22 * 3_600_000).toISOString() }, now);
    const crumbs = [
      createCrumb({ projectId: visual.id, sessionId: session.id, type: "decision", text: "主结果统一采用实验组在前、基线组在后的顺序。", createdAt: new Date(now - 23.5 * 3_600_000).toISOString() }, now),
      createCrumb({ projectId: visual.id, sessionId: session.id, type: "discovery", text: "Figure 3 的配色映射与 Figure 1 相反，是正文描述不一致的来源。", createdAt: new Date(now - 23 * 3_600_000).toISOString() }, now),
      createCrumb({ projectId: visual.id, sessionId: session.id, type: "question", text: "附录中的灰度打印版本是否也要同步调整？", createdAt: new Date(now - 22.5 * 3_600_000).toISOString() }, now)
    ];
    const checkpoint = createCheckpoint({ projectId: visual.id, sessionId: session.id, summary: "Figure 1 和 2 已统一配色；Figure 3 已定位到图例顺序反转，但尚未修改生成脚本。", nextAction: "打开 figure_03.ipynb，核对第三组图例顺序", openLoops: "确认附录灰度版本是否同步；修改后重新导出 SVG。", returnHint: "颜色常量在 notebook 第 4 个单元格，不需要重跑数据预处理。", createdAt: new Date(now - 22 * 3_600_000).toISOString() }, now);
    session.checkpointId = checkpoint.id;

    const handbook = createProject({ title: "团队上手手册", description: "把新成员第一周最容易卡住的流程整理成可执行手册。", nextAction: "向小林确认测试环境账号的申请入口", color: "sky", status: "blocked", createdAt: new Date(now - 12 * 86_400_000).toISOString(), updatedAt: new Date(now - 4 * 86_400_000).toISOString(), lastOpenedAt: new Date(now - 4 * 86_400_000).toISOString() }, now);
    const handbookCrumb = createCrumb({ projectId: handbook.id, type: "blocker", text: "测试环境账号申请入口尚未确认，部署章节无法写准。", createdAt: new Date(now - 4 * 86_400_000).toISOString() }, now);

    this.#store.update((state) => {
      state.projects.push(visual, handbook);
      state.sessions.push(session);
      state.crumbs.push(...crumbs, handbookCrumb);
      state.checkpoints.push(checkpoint);
    });
    this.#requestPersistentStorage();
    this.#toast("示例现场已载入，可以放心探索。 ");
  }

  #exportData() {
    const blob = new Blob([this.#store.exportSnapshotText()], { type: "application/json" });
    triggerBlobDownload(blob, `reentry-backup-${new Date().toISOString().slice(0, 10)}.json`);
    this.#toast("完整备份已生成。 ");
  }

  async #copyReentryBrief(projectId) {
    const isCurrentRequest = this.#clipboardRequestGate.begin();
    try {
      const card = buildReentryCard(this.#store.getState(), projectId);
      if (!card) throw new Error("找不到可复制的项目现场。 ");
      await copyPlainText(buildReentryBrief(card));
      if (!isCurrentRequest()) return;
      this.#announce("复航简报已复制");
      this.#toast("复航简报已复制到剪贴板。 ");
    } catch (error) {
      if (isCurrentRequest()) this.#toast(`无法复制简报：${userFacingErrorMessage(error)}`, "error");
    }
  }

  async #copyWorkspaceHandoff() {
    const isCurrentRequest = this.#clipboardRequestGate.begin();
    try {
      const now = Date.now();
      const overview = buildWorkspaceOverview(this.#store.getState(), now, { rankedLimit: WORKSPACE_HANDOFF_PROJECT_LIMIT });
      await copyPlainText(buildWorkspaceHandoff(overview, now));
      if (!isCurrentRequest()) return;
      this.#announce("工作区交接清单已复制");
      this.#toast("工作区交接清单已复制到剪贴板。 ");
    } catch (error) {
      if (isCurrentRequest()) this.#toast(`无法复制交接清单：${userFacingErrorMessage(error)}`, "error");
    }
  }

  async #importData(file, input) {
    const isCurrentRequest = this.#importRequestGate.begin();
    this.#importReadController?.abort();
    const controller = new AbortController();
    this.#importReadController = controller;
    try {
      const parsed = await readBackupFile(file, { signal: controller.signal });
      if (!isCurrentRequest()) return;
      const preview = this.#store.previewImport(parsed);
      this.#pendingImport = {
        value: preview.normalizedSnapshot,
        preview,
        source: preview.source,
        baseState: this.#store.getState(),
        fileName: importFileLabel(file),
        fileSize: file.size,
        refreshed: false
      };
      this.render();
      this.#openDialog("import-preview-dialog");
    } catch (error) {
      if (isCurrentRequest()) this.#toast(`无法导入：${userFacingErrorMessage(error)}`, "error");
    } finally {
      if (this.#importReadController === controller) this.#importReadController = null;
      if (isCurrentRequest()) input.value = "";
    }
  }

  #confirmImport() {
    const pending = this.#pendingImport;
    if (!pending || !pending.preview.hasContentChanges) return;
    const currentState = this.#store.getState();
    if (currentState !== pending.baseState) {
      pending.preview = { ...this.#store.previewImport(pending.value), source: pending.source };
      pending.value = pending.preview.normalizedSnapshot;
      pending.baseState = currentState;
      pending.refreshed = true;
      this.render();
      this.#openDialog("import-preview-dialog");
      this.#toast("工作区刚刚有变化，已刷新导入差异，请重新核对。", "error");
      return;
    }

    this.#pendingImport = null;
    this.#focusSelector = "#main-content";
    try {
      this.#store.importSnapshot(pending.value);
      this.#requestPersistentStorage();
      if (location.hash !== "#/") location.hash = "#/";
      this.#toast("备份已按预览结果恢复；上一个工作区仍可撤销回来。 ");
    } catch (error) {
      this.#pendingImport = pending;
      pending.refreshed = true;
      this.render();
      this.#openDialog("import-preview-dialog");
      this.#toast(`无法导入：${userFacingErrorMessage(error)}`, "error");
    }
  }

  #closeDialog(control) {
    const dialog = control.closest("dialog");
    if (dialog?.id === "import-preview-dialog") this.#pendingImport = null;
    if (dialog?.id === "archive-confirm-dialog") this.#pendingArchiveId = null;
    if (dialog?.id === "edit-project-dialog") this.#pendingProjectEdit = null;
    if (dialog?.id === "new-project-dialog") this.#clearNewProjectTemplate(dialog);
    if (dialog?.id === "checkpoint-dialog") this.#pendingCheckpointSessionId = null;
    dialog?.close();
  }

  #openDialog(id) {
    const dialog = this.#root.querySelector(`#${id}`);
    if (!dialog) return;
    if (dialog.open) {
      this.#focusDialogControl(dialog);
      return;
    }
    dialog.showModal();
    requestAnimationFrame(() => {
      if (!this.#destroyed && dialog.isConnected && dialog.open) this.#focusDialogControl(dialog);
    });
  }

  #focusDialogControl(dialog) {
    const preferred = dialog.querySelector("[autofocus]")
      ?? dialog.querySelector('[data-control="workspace-search"]')
      ?? dialog.querySelector("input:not([type=hidden]), textarea, select")
      ?? dialog.querySelector("button");
    preferred?.focus();
  }

  #refreshAfterResume() {
    this.#store.refreshFromStorage();
    this.#refreshTimers();
  }

  #refreshTimers() {
    if (document.visibilityState === "hidden") return;
    const now = Date.now();
    for (const timer of this.#root.querySelectorAll(".js-session-timer")) {
      timer.textContent = formatDuration(elapsedSeconds(timer.dataset.startedAt, now));
    }
    const activeSession = this.#activeSession;
    const nextSignature = sessionHealthSignature(
      activeSession,
      Boolean(activeSession && activeSession.id === this.#acknowledgedStaleSessionId),
      now
    );
    const nextDaySignature = localDaySignature(now);
    if (nextSignature === this.#sessionHealthSignature && nextDaySignature === this.#calendarDaySignature) return;
    const focusedControl = document.activeElement;
    if (focusedControl && this.#root.contains(focusedControl) && focusedControl.matches?.("input, textarea, select")) return;
    this.render({ preserveDialog: true });
  }

  #toast(message, kind = "success") {
    if (this.#destroyed) return;
    const toast = {
      id: `toast-${++this.#toastSequence}`,
      message: compactText(message, MAX_TOAST_MESSAGE_LENGTH),
      kind,
      expiresAt: Date.now() + 3_600
    };
    this.#toasts.push(toast);
    while (this.#toasts.length > MAX_VISIBLE_TOASTS) {
      const removed = this.#toasts.shift();
      const timerId = this.#toastTimers.get(removed.id);
      if (timerId !== undefined) window.clearTimeout(timerId);
      this.#toastTimers.delete(removed.id);
      this.#root.querySelector(`[data-toast-id="${CSS.escape(removed.id)}"]`)?.remove();
    }
    const region = this.#root.querySelector("#toast-region");
    if (region) region.insertAdjacentHTML("beforeend", this.#renderToast(toast));
    const timerId = window.setTimeout(() => {
      this.#toastTimers.delete(toast.id);
      this.#dismissToast(toast.id);
    }, 3_600);
    this.#toastTimers.set(toast.id, timerId);
  }

  #renderToasts() {
    const now = Date.now();
    this.#toasts = this.#toasts.filter((toast) => toast.expiresAt > now).slice(-MAX_VISIBLE_TOASTS);
    return this.#toasts.map((toast) => this.#renderToast(toast)).join("");
  }

  #renderToast(toast) {
    return `<div class="toast" data-toast-id="${attr(toast.id)}" data-kind="${attr(toast.kind)}">${icon(toast.kind === "error" ? "alert" : "check")}<span>${escapeHTML(toast.message)}</span></div>`;
  }

  #dismissToast(id) {
    if (this.#destroyed) return;
    this.#toasts = this.#toasts.filter((toast) => toast.id !== id);
    this.#root.querySelector(`[data-toast-id="${CSS.escape(id)}"]`)?.remove();
  }

  #announce(message) {
    const region = this.#root.querySelector("#live-region");
    if (!region) return;
    region.textContent = "";
    requestAnimationFrame(() => {
      if (!this.#destroyed && region.isConnected) region.textContent = message;
    });
  }

  async #requestPersistentStorage(report = false) {
    const isCurrentRequest = this.#storageDurabilityRequestGate.begin();
    let result = STORAGE_DURABILITY_STATUS.ERROR;
    try {
      result = await requestPersistentStorage(navigator.storage);
    } catch {
      // Access to navigator.storage itself can be denied before the core capability boundary runs.
    }
    if (!isCurrentRequest()) return;
    this.#storageDurabilityStatus = result;
    if (!report) return;
    try {
      this.#focusSelector = '[data-action="request-persistent-storage"]';
      this.render();
      const message = STORAGE_DURABILITY_DETAILS[result]?.message ?? STORAGE_DURABILITY_DETAILS.error.message;
      this.#announce(message);
      this.#toast(message, result === STORAGE_DURABILITY_STATUS.GRANTED ? "success" : "error");
    } catch (error) {
      if (!isCurrentRequest() || !report) return;
      this.#storageDurabilityStatus = STORAGE_DURABILITY_STATUS.ERROR;
      this.#toast(`无法检查本机数据保护：${userFacingErrorMessage(error)}`, "error");
    }
  }

  async #inspectPersistentStorage() {
    const isCurrentRequest = this.#storageDurabilityRequestGate.begin();
    let result = STORAGE_DURABILITY_STATUS.ERROR;
    try {
      result = await inspectPersistentStorage(navigator.storage);
    } catch {
      // Access to navigator.storage itself can be denied before the core capability boundary runs.
    }
    if (!isCurrentRequest()) return;
    this.#storageDurabilityStatus = result;
    if (location.hash !== "#/settings") return;
    try {
      this.render({ preserveDialog: true });
    } catch (error) {
      if (isCurrentRequest()) this.#toast(`无法显示本机数据保护状态：${userFacingErrorMessage(error)}`, "error");
    }
  }
}

function sessionHealthSignature(session, acknowledged, now = Date.now()) {
  if (!session) return "none";
  const health = inspectSession(session, now);
  return `${session.id}|${health.staleReasons.join(",")}|${acknowledged ? "ack" : "pending"}`;
}

export function localDaySignature(now = Date.now()) {
  const date = new Date(now);
  if (!Number.isFinite(date.getTime())) return "invalid";
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
}

function controlContext(value) {
  return compactText(String(value ?? "").replace(/\s+/gu, " "), 80) || "未命名内容";
}

export const ROUTE_HASH_LIMIT = 2_420;

export function parseRoute(hash) {
  const raw = String(hash ?? "");
  if (raw.length > ROUTE_HASH_LIMIT) return { name: "notFound" };
  const value = raw.replace(/^#\/?/, "");
  if (!value) return { name: "home" };
  const segments = value.split("/");
  const [name, encodedId] = segments;
  if (name === "project" && segments.length === 2 && encodedId && encodedId.length <= 2_400) {
    try {
      const id = decodeURIComponent(encodedId);
      if (!id || id.length > IMPORT_LIMITS.id || containsUnsafeIdControl(id)) return { name: "notFound" };
      return { name: "project", id };
    } catch {
      return { name: "notFound" };
    }
  }
  if (name === "archive" && segments.length === 1) return { name: "archive" };
  if (name === "settings" && segments.length === 1) return { name: "settings" };
  return { name: "notFound" };
}

function routeTitle(route) {
  return { home: "项目舰桥", archive: "归档舱", settings: "数据保险箱", notFound: "页面未找到" }[route.name] ?? "页面未找到";
}

function brandMark() {
  return '<span class="brand-mark" aria-hidden="true"><span></span><span></span><span></span></span>';
}

function icon(name) {
  return `<svg aria-hidden="true" viewBox="0 0 24 24">${ICONS[name] ?? ICONS.info}</svg>`;
}

function metric(label, value, detail) {
  return `<article class="metric-card"><span class="metric-label">${escapeHTML(label)}</span><strong class="metric-value">${value}</strong><span class="metric-detail">${escapeHTML(detail)}</span></article>`;
}

function miniStat(value, label) {
  return `<div class="mini-stat"><strong>${value}</strong><span>${escapeHTML(label)}</span></div>`;
}

function renderProjectChangeList(label, projects, total, kind) {
  if (!total) return "";
  const hidden = total - projects.length;
  return `<section data-kind="${kind}"><h3>${escapeHTML(label)} <span>${total}</span></h3><ul>${projects.map((project) => `<li><strong>${escapeHTML(project.title)}</strong><small>${escapeHTML(PROJECT_STATUS_LABELS[project.status] ?? project.status)}</small></li>`).join("")}</ul>${hidden ? `<p>另有 ${hidden} 个项目未逐项展开</p>` : ""}</section>`;
}

function renderChangedProjectList(projects, total) {
  if (!total) return "";
  const hidden = total - projects.length;
  return `<section data-kind="changed"><h3>同 ID 更新 <span>${total}</span></h3><ul>${projects.map((project) => `<li><strong>${escapeHTML(project.beforeTitle === project.afterTitle ? project.afterTitle : `${project.beforeTitle} → ${project.afterTitle}`)}</strong><small>${escapeHTML(project.beforeStatus === project.afterStatus ? PROJECT_STATUS_LABELS[project.afterStatus] ?? project.afterStatus : `${PROJECT_STATUS_LABELS[project.beforeStatus] ?? project.beforeStatus} → ${PROJECT_STATUS_LABELS[project.afterStatus] ?? project.afterStatus}`)}</small></li>`).join("")}</ul>${hidden ? `<p>另有 ${hidden} 个项目未逐项展开</p>` : ""}</section>`;
}

function renderQuickCaptureProjectOptions(projects, selectedId, activeProjectId) {
  let html = "";
  for (const project of projects) {
    html += `<option value="${attr(project.id)}" ${project.id === selectedId ? "selected" : ""}>${escapeHTML(project.title)}${project.id === activeProjectId ? " · 会话中" : ""}</option>`;
  }
  return html;
}

function quickCaptureProjectStatus(window) {
  if (window.queryRejected) return `筛选词不能超过 ${QUICK_CAPTURE_QUERY_LIMIT} 个字符。`;
  if (window.query) {
    if (!window.matched) return `没有匹配“${window.query}”的未归档项目。`;
    return `找到 ${window.matched} 个匹配项目，显示前 ${window.items.length} 个。`;
  }
  if (window.total > window.items.length) {
    return `显示 ${window.items.length} / ${window.total} 个未归档项目；输入关键词可查找其余项目。`;
  }
  return `共 ${window.total} 个未归档项目。`;
}

function pulseMetric(value, label, detail) {
  return `<article><strong>${escapeHTML(value)}</strong><span>${escapeHTML(label)}</span><small>${escapeHTML(detail)}</small></article>`;
}

function formatInsightDuration(minutes) {
  if (!Number.isFinite(minutes) || minutes <= 0) return "0 分钟";
  return formatDuration(Math.round(minutes * 60), { compact: true });
}

function greeting() {
  const hour = new Date().getHours();
  if (hour < 6) return "夜深了，保留现场即可";
  if (hour < 11) return "早上好，准备复航";
  if (hour < 14) return "中午好，先找回方向";
  if (hour < 18) return "下午好，继续一段清楚的路";
  return "晚上好，把思路接回来";
}

function awayLabel(days) {
  if (days < 1 / 24) return "刚刚还在这里";
  if (days < 1) return `离开约 ${Math.max(1, Math.round(days * 24))} 小时`;
  if (days < 2) return "上次在昨天";
  return `已离开 ${Math.floor(days)} 天`;
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function isTypingTarget(target) {
  return target instanceof HTMLElement && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));
}

function textBlock(value) {
  return escapeHTML(value).replaceAll("\n", "<br>");
}

function escapeHTML(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[character]);
}

function attr(value) {
  return escapeHTML(value);
}
