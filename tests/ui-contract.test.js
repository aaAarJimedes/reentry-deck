import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const APP_SOURCE_URL = new URL("../src/ui/app.js", import.meta.url);
const STYLE_SOURCE_URL = new URL("../src/styles.css", import.meta.url);

test("project archival uses an accessible in-app confirmation instead of window.confirm", async () => {
  const source = await readFile(APP_SOURCE_URL, "utf8");
  const dialogs = source.match(/#renderDialogs\(project, activeSession, reentryCard\) \{([\s\S]*?)\n  \}\n\n  #renderImportPreviewDialog/u)?.[1] ?? "";
  const prepare = source.match(/#prepareArchive\(projectId\) \{([\s\S]*?)\n  \}\n\n  #confirmArchive/u)?.[1] ?? "";
  const confirm = source.match(/#confirmArchive\(\) \{([\s\S]*?)\n  \}\n\n  #restoreProject/u)?.[1] ?? "";

  assert.doesNotMatch(source, /window\.confirm\s*\(/);
  assert.match(
    source,
    /<dialog id="archive-confirm-dialog"[^>]* aria-labelledby="archive-confirm-title" aria-describedby="archive-confirm-description">/
  );
  assert.match(source, /id="archive-confirm-description"/);
  assert.match(source, /data-archive-project-title/);
  assert.match(source, /data-action="close-dialog" autofocus>取消<\/button>/);
  assert.match(source, /data-action="confirm-archive">确认移入归档<\/button>/);
  assert.match(source, /if \(action === "archive-project"\) this\.#prepareArchive/);
  assert.match(source, /if \(action === "confirm-archive"\) this\.#confirmArchive/);
  assert.match(dialogs, /project\?\.id === this\.#pendingArchiveId \? project : null/u);
  assert.doesNotMatch(dialogs, /state\.projects\.find/u);
  assert.match(prepare, /prepareProjectArchive\(state, projectId\)/u);
  assert.doesNotMatch(prepare, /(?:projects\.find|sessions\.some)/u);
  assert.match(confirm, /prepareProjectArchive\(next, projectId\)/u);
  assert.match(confirm, /next\.projects\[projectIndex\]/u);
  assert.doesNotMatch(confirm, /(?:projects\.find|sessions\.some)/u);
});

test("project mutations enforce lifecycle-specific core plans", async () => {
  const source = await readFile(APP_SOURCE_URL, "utf8");
  const edit = source.match(/#editProject\(data, form\) \{([\s\S]*?)\n  \}\n\n  #prepareProjectEditDialog/u)?.[1] ?? "";
  const prepareEdit = source.match(/#prepareProjectEditDialog\(\) \{([\s\S]*?)\n  \}\n\n  #changeProjectStatus/u)?.[1] ?? "";
  const status = source.match(/#changeProjectStatus\(projectId, status\) \{([\s\S]*?)\n  \}\n\n  #toggleCrumbResolution/u)?.[1] ?? "";
  const restore = source.match(/#restoreProject\(projectId\) \{([\s\S]*?)\n  \}\n\n  #setTheme/u)?.[1] ?? "";

  assert.match(source, /if \(action === "edit-project"\) this\.#prepareProjectEditDialog\(\)/u);
  assert.match(prepareEdit, /this\.#pendingProjectEdit = \{ projectId: project\.id, editToken \}/u);
  assert.match(edit, /pending\.projectId, pending\.editToken/u);
  assert.match(edit, /pending\.projectId !== data\.projectId/u);
  assert.match(status, /prepareProjectStatusChange\(state, projectId, status\)/u);
  assert.match(restore, /prepareProjectRestore\(state, projectId\)/u);
  for (const handler of [edit, status, restore]) assert.doesNotMatch(handler, /state\.projects\.find/u);
});

test("user-triggered mutation surfaces are guarded by the shared action boundary", async () => {
  const source = await readFile(APP_SOURCE_URL, "utf8");

  assert.match(source, /addEventListener\("click", \(event\) => this\.#runUserAction\(\(\) => this\.#onClick\(event\)\), listenerOptions\)/);
  assert.match(source, /addEventListener\("change", \(event\) => this\.#runUserAction\(\(\) => this\.#onChange\(event\)\), listenerOptions\)/);
  assert.match(source, /addEventListener\("keydown", \(event\) => this\.#runUserAction\(\(\) => this\.#onKeydown\(event\)\), listenerOptions\)/);
  assert.match(source, /requestAnimationFrame\(\(\) => \{[\s\S]*?this\.#runUserAction/u);
  assert.match(source, /操作未完成，请根据最新状态重试/);
});

test("app destruction releases listeners, subscriptions, and toast timers", async () => {
  const source = await readFile(APP_SOURCE_URL, "utf8");

  assert.match(source, /const listenerOptions = \{ signal: this\.#eventController\.signal \}/);
  assert.match(source, /this\.#eventController\.abort\(\)/);
  assert.match(source, /this\.#unsubscribeStore\?\.\(\)/);
  assert.match(source, /for \(const timerId of this\.#toastTimers\.values\(\)\) window\.clearTimeout\(timerId\)/);
  assert.match(source, /this\.#store\.destroy\?\.\(\)/);
  assert.match(source, /if \(this\.#destroyed\) return/u);
  assert.match(source, /this\.#destroyed = true/u);
  assert.match(source, /this\.#renderSequence \+= 1/u);
});

test("deferred UI callbacks cannot outlive their render or app instance", async () => {
  const source = await readFile(APP_SOURCE_URL, "utf8");
  const render = source.match(/render\(\{ preserveDialog = false \} = \{\}\) \{([\s\S]*?)\n  \}\n\n  #captureTransientDialog/u)?.[1] ?? "";
  const command = source.match(/#runCommand\(command, dialog\) \{([\s\S]*?)\n  \}\n\n  #createProject/u)?.[1] ?? "";
  const open = source.match(/#openDialog\(id\) \{([\s\S]*?)\n  \}\n\n  #focusDialogControl/u)?.[1] ?? "";
  const announce = source.match(/#announce\(message\) \{([\s\S]*?)\n  \}\n\n  async #requestPersistentStorage/u)?.[1] ?? "";

  assert.match(render, /const renderSequence = \+\+this\.#renderSequence/u);
  assert.ok((render.match(/renderSequence !== this\.#renderSequence/gu)?.length ?? 0) >= 3);
  assert.match(command, /if \(this\.#destroyed\) return/u);
  assert.match(open, /!this\.#destroyed && dialog\.isConnected && dialog\.open/u);
  assert.match(announce, /!this\.#destroyed && region\.isConnected/u);
});

test("toast output is text-bounded, count-bounded, and timer-bounded", async () => {
  const source = await readFile(APP_SOURCE_URL, "utf8");
  const toast = source.match(/#toast\(message, kind = "success"\) \{([\s\S]*?)\n  \}\n\n  #renderToasts/u)?.[1] ?? "";
  const render = source.match(/#renderToasts\(\) \{([\s\S]*?)\n  \}\n\n  #renderToast/u)?.[1] ?? "";

  assert.match(source, /const MAX_VISIBLE_TOASTS = 4/u);
  assert.match(source, /const MAX_TOAST_MESSAGE_LENGTH = 500/u);
  assert.match(toast, /if \(this\.#destroyed\) return/u);
  assert.match(toast, /compactText\(message, MAX_TOAST_MESSAGE_LENGTH\)/u);
  assert.match(toast, /while \(this\.#toasts\.length > MAX_VISIBLE_TOASTS\)/u);
  assert.match(toast, /window\.clearTimeout\(timerId\)/u);
  assert.match(toast, /this\.#toastTimers\.delete\(removed\.id\)/u);
  assert.match(render, /slice\(-MAX_VISIBLE_TOASTS\)/u);
});

test("storage diagnostics are consumed only after the rendered shell commits", async () => {
  const source = await readFile(APP_SOURCE_URL, "utf8");
  const render = source.match(/render\(\{ preserveDialog = false \} = \{\}\) \{([\s\S]*?)\n  \}\n\n  #captureTransientDialog/u)?.[1] ?? "";
  const notices = source.match(/#renderNotices\(\) \{([\s\S]*?)\n  \}\n\n  #renderSessionInvariantNotice/u)?.[1] ?? "";

  assert.match(notices, /this\.#noticeQueue\.map/u);
  assert.doesNotMatch(notices, /(?:splice|shift|pop)\(/u);
  assert.ok(render.indexOf("this.#root.innerHTML =") < render.indexOf("this.#noticeQueue = []"));
});

test("quick-dock continuation advances workspace time through the follow-up session", async () => {
  const source = await readFile(APP_SOURCE_URL, "utf8");

  assert.match(source, /\}, followUp \? Date\.parse\(followUp\.startedAt\) : now\);/);
});

test("session lifecycle warnings refresh after time boundaries without erasing active input", async () => {
  const source = await readFile(APP_SOURCE_URL, "utf8");

  assert.match(source, /#sessionHealthSignature = "none"/u);
  assert.match(source, /#calendarDaySignature = "invalid"/u);
  assert.match(source, /this\.#sessionHealthSignature = sessionHealthSignature/u);
  assert.match(source, /nextSignature === this\.#sessionHealthSignature && nextDaySignature === this\.#calendarDaySignature/u);
  assert.match(source, /focusedControl\.matches\?\.\("input, textarea, select"\)/u);
  assert.match(source, /this\.render\(\{ preserveDialog: true \}\)/u);
  assert.match(source, /health\.staleReasons\.join\(","\)/u);
  assert.match(source, /document\.visibilityState === "hidden"/u);
  assert.match(source, /document\.visibilityState === "visible"\) this\.#refreshTimers\(\)/u);
});

test("stale-session acknowledgement is single-use and bound to the current active session", async () => {
  const source = await readFile(APP_SOURCE_URL, "utf8");
  const render = source.match(/render\(\{ preserveDialog = false \} = \{\}\) \{([\s\S]*?)\n  \}\n\n  #captureTransientDialog/u)?.[1] ?? "";
  const acknowledge = source.match(/#continueStaleSession\(sessionId\) \{([\s\S]*?)\n  \}\n\n  #quickDock/u)?.[1] ?? "";

  assert.match(source, /#acknowledgedStaleSessionId = null/u);
  assert.doesNotMatch(source, /acknowledgedStaleSessions|new Set\(\)/u);
  assert.match(render, /!activeSession \|\| this\.#acknowledgedStaleSessionId !== activeSession\.id/u);
  assert.match(acknowledge, /this\.#activeSession\?\.id !== sessionId/u);
  assert.match(acknowledge, /this\.#acknowledgedStaleSessionId = sessionId/u);
  assert.match(source, /Boolean\(activeSession && activeSession\.id === this\.#acknowledgedStaleSessionId\)/u);
  assert.match(source, /session\.id !== this\.#acknowledgedStaleSessionId/u);
});

test("interactive refresh paths reuse the invariant-safe render context", async () => {
  const source = await readFile(APP_SOURCE_URL, "utf8");
  const render = source.match(/render\(\{ preserveDialog = false \} = \{\}\) \{([\s\S]*?)\n  \}\n\n  #captureTransientDialog/u)?.[1] ?? "";
  const filter = source.match(/#updateQuickCaptureProjects\(control\) \{([\s\S]*?)\n  \}\n\n  #runUserAction/u)?.[1] ?? "";
  const keydown = source.match(/#onKeydown\(event\) \{([\s\S]*?)\n  \}\n\n  #runCommand/u)?.[1] ?? "";
  const refresh = source.match(/#refreshTimers\(\) \{([\s\S]*?)\n  \}\n\n  #toast/u)?.[1] ?? "";

  assert.match(render, /this\.#activeSession = activeSession/u);
  assert.match(filter, /const activeSession = this\.#activeSession/u);
  assert.doesNotMatch(filter, /sessions\.find/u);
  assert.match(keydown, /this\.#workspaceCounts\?\.unarchivedProjects/u);
  assert.doesNotMatch(keydown, /projects\.some/u);
  assert.match(refresh, /const activeSession = this\.#activeSession/u);
  assert.doesNotMatch(refresh, /(?:getState|sessions\.find)/u);
});

test("dialog redraw restoration preserves controls only while their entity context remains valid", async () => {
  const source = await readFile(APP_SOURCE_URL, "utf8");
  const capture = source.match(/#captureTransientDialog\(\) \{([\s\S]*?)\n  \}\n\n  #dialogContextKey/u)?.[1] ?? "";
  const restore = source.match(/#restoreTransientDialog\(snapshot\) \{([\s\S]*?)\n  \}\n\n  #validateTransientDialogContext/u)?.[1] ?? "";
  const validate = source.match(/#validateTransientDialogContext\(snapshot, dialog\) \{([\s\S]*?)\n  \}\n\n  #renderSidebar/u)?.[1] ?? "";

  assert.doesNotMatch(source, /dialog\.id === "import-preview-dialog"\) return null/u);
  assert.match(source, /querySelectorAll\("button, input, select, textarea"\)/u);
  assert.match(source, /const activeFocusableIndex = focusables\.indexOf\(document\.activeElement\)/u);
  assert.match(source, /activeControlIndex,\s+activeFocusableIndex,/u);
  assert.match(source, /const active = focusables\[snapshot\.activeFocusableIndex\]/u);
  assert.match(source, /active === controls\[snapshot\.activeControlIndex\]/u);
  assert.match(source, /transientDialog\?\.id === "import-preview-dialog"/u);
  assert.match(capture, /contextKey: this\.#dialogContextKey\(dialog\)/u);
  assert.match(restore, /if \(!this\.#validateTransientDialogContext\(snapshot, dialog\)\) return/u);
  assert.match(validate, /prepareSessionDialog\(this\.#store\.getState\(\), projectId\)/u);
  assert.match(validate, /if \(plan\.activeSession\) throw new Error/u);
  assert.match(validate, /prepareProjectEdit\(this\.#store\.getState\(\), pending\.projectId, pending\.editToken\)/u);
  assert.match(validate, /prepareProjectArchive\(this\.#store\.getState\(\), this\.#pendingArchiveId\)/u);
  assert.match(validate, /snapshot\.contextKey === this\.#dialogContextKey\(dialog\)/u);
  assert.match(source, /quick-review-dialog"\) return `\$\{dialog\.id\}:\$\{value\("projectId"\)\}:\$\{value\("sourceCheckpointId"\)\}`/u);
  assert.match(source, /<dialog id="checkpoint-dialog" data-context-id="\$\{attr\(activeSession\?\.id \?\? ""\)\}"/u);
  assert.match(source, /<dialog id="archive-confirm-dialog" data-context-id="\$\{attr\(pendingArchiveProject\?\.id \?\? ""\)\}"/u);
});

test("external redraw preserves an inline capture draft only for the same session", async () => {
  const source = await readFile(APP_SOURCE_URL, "utf8");
  const render = source.match(/render\(\{ preserveDialog = false \} = \{\}\) \{([\s\S]*?)\n  \}\n\n  #captureTransientDialog/u)?.[1] ?? "";
  const capture = source.match(/#captureInlineCaptureDraft\(\) \{([\s\S]*?)\n  \}\n\n  #restoreInlineCaptureDraft/u)?.[1] ?? "";
  const restore = source.match(/#restoreInlineCaptureDraft\(snapshot, activeSession\) \{([\s\S]*?)\n  \}\n\n  #restoreTransientDialog/u)?.[1] ?? "";

  assert.match(render, /preserveDialog \? this\.#captureInlineCaptureDraft\(\) : null/u);
  assert.match(render, /this\.#restoreInlineCaptureDraft\(captureDraft, activeSession\)/u);
  assert.match(capture, /sessionId = this\.#activeSession\?\.id/u);
  assert.match(capture, /if \(!focused && !text\.value\) return null/u);
  assert.match(restore, /activeSession\?\.id !== snapshot\.sessionId/u);
  assert.match(restore, /boundTransientControlValue\(snapshot\.text, IMPORT_LIMITS\.crumbText\)/u);
  assert.match(restore, /Object\.hasOwn\(CRUMB_LABELS, snapshot\.type\)/u);
  assert.match(restore, /setSelectionRange/u);
});

test("quick checkpoint review is an accessible explicit upgrade flow", async () => {
  const source = await readFile(APP_SOURCE_URL, "utf8");

  assert.match(source, /data-action="review-quick-checkpoint">复核并升级检查点/);
  assert.match(source, /<dialog id="quick-review-dialog" aria-labelledby="quick-review-title" aria-describedby="quick-review-description">/);
  assert.match(source, /data-form="quick-review"/);
  assert.match(source, /this\.#reviewQuickCheckpoint\(data, form\)/);
});

test("form length boundaries come from the persisted model contract", async () => {
  const source = await readFile(APP_SOURCE_URL, "utf8");

  assert.doesNotMatch(source, /maxlength="\d+"/);
  for (const field of ["projectTitle", "projectDescription", "sessionIntention", "crumbText", "checkpointSummary", "nextAction", "openLoops", "returnHint"]) {
    assert.match(source, new RegExp(`maxlength="\\$\\{IMPORT_LIMITS\\.${field}\\}"`, "u"));
  }
});

test("workspace search exposes the same query budget enforced by the core", async () => {
  const source = await readFile(new URL("../src/ui/app.js", import.meta.url), "utf8");

  assert.match(source, /import \{ SEARCH_QUERY_LIMIT, buildWorkspaceSearchIndex/u);
  assert.match(source, /data-control="workspace-search" maxlength="\$\{SEARCH_QUERY_LIMIT\}"/u);
  assert.match(source, /#onInput\(event\) \{\s+if \(event\.isComposing\) return;/u);
});

test("command availability reuses workspace counts and disables ambiguous docking", async () => {
  const source = await readFile(APP_SOURCE_URL, "utf8");
  const commands = source.match(/#renderQuickCommands\(\) \{([\s\S]*?)\n  \}\n\n  #onKeydown/u)?.[1] ?? "";

  assert.match(source, /this\.#workspaceCounts = workspaceCounts/u);
  assert.match(commands, /counts\.unarchivedProjects > 0/u);
  assert.match(commands, /const activeSessionCount = counts\.activeSessions/u);
  assert.match(commands, /activeSessionCount !== 1/u);
  assert.match(commands, /检测到 \$\{activeSessionCount\} 个活动会话/u);
  assert.doesNotMatch(commands, /\.(?:projects|sessions)\.some/u);
});

test("rendering never selects an arbitrary session when the active invariant is broken", async () => {
  const source = await readFile(APP_SOURCE_URL, "utf8");
  const render = source.match(/render\(\{ preserveDialog = false \} = \{\}\) \{([\s\S]*?)\n  \}\n\n  #captureTransientDialog/u)?.[1] ?? "";

  assert.match(render, /buildWorkspaceFrame\(state, route\.name === "project" \? route\.id : null, now\)/u);
  assert.match(render, /counts: workspaceCounts, currentProject, activeSession, activeProject/u);
  assert.doesNotMatch(render, /state\.(?:projects|sessions)\.find/u);
  assert.match(render, /#renderSessionInvariantNotice\(workspaceCounts, activeSession, activeProject\)/u);
  assert.match(source, /role="alert"[^`]*检测到 \$\{counts\.activeSessions\} 个活动会话/u);
  assert.match(source, /活动会话关联的项目不存在/u);
});

test("backup reads ignore stale completions and are invalidated on app destruction", async () => {
  const source = await readFile(APP_SOURCE_URL, "utf8");

  assert.match(source, /const isCurrentRequest = this\.#importRequestGate\.begin\(\)/);
  assert.match(source, /if \(!isCurrentRequest\(\)\) return/);
  assert.match(source, /if \(isCurrentRequest\(\)\) this\.#toast/);
  assert.match(source, /this\.#importRequestGate\.invalidate\(\)/);
  assert.match(source, /this\.#importReadController\?\.abort\(\)/);
  assert.match(source, /readBackupFile\(file, \{ signal: controller\.signal \}\)/);
  assert.match(source, /if \(this\.#importReadController === controller\) this\.#importReadController = null/);
  assert.match(source, /value: preview\.normalizedSnapshot/);
  assert.match(source, /source: preview\.source/);
  assert.match(source, /source: this\.#pendingImport\.source/);
  assert.match(source, /source: pending\.source/);
  assert.match(source, /pending\.value = pending\.preview\.normalizedSnapshot/);
});

test("attention threshold is an accessible validated local setting", async () => {
  const source = await readFile(APP_SOURCE_URL, "utf8");

  assert.match(source, /<select data-control="stale-days" aria-label="离开提醒阈值">/);
  assert.match(source, /this\.#setStaleAfterDays\(control\.value\)/);
  assert.match(source, /Number\.isSafeInteger\(days\) \|\| days < 1 \|\| days > 365/);
  assert.match(source, /state\.settings\.staleAfterDays = days/);
});

test("reduced motion can follow the system or be forced by a persisted setting", async () => {
  const [source, styles] = await Promise.all([
    readFile(APP_SOURCE_URL, "utf8"),
    readFile(STYLE_SOURCE_URL, "utf8")
  ]);

  assert.match(source, /document\.documentElement\.dataset\.reducedMotion = state\.settings\.reducedMotion \? "reduce" : "system"/);
  assert.match(source, /<div class="segmented-control" role="group" aria-label="动态效果">/);
  assert.match(source, /this\.#setReducedMotion\(control\.dataset\.reducedMotion\)/);
  assert.match(source, /state\.settings\.reducedMotion = reduced/);
  assert.match(styles, /:root\[data-reduced-motion="reduce"\] \*::after/);
  assert.match(styles, /animation-iteration-count: 1 !important/);
});

test("system color-scheme changes update browser chrome and release their listener", async () => {
  const source = await readFile(APP_SOURCE_URL, "utf8");

  assert.match(source, /window\.matchMedia\?\.\("\(prefers-color-scheme: dark\)"\)/);
  assert.match(source, /this\.#colorSchemeQuery\?\.addEventListener\?\.\("change", this\.#colorSchemeListener\)/);
  assert.match(source, /this\.#colorSchemeQuery\?\.removeEventListener\?\.\("change", this\.#colorSchemeListener\)/);
  assert.match(source, /resolveThemeAppearance\(theme, Boolean\(this\.#colorSchemeQuery\?\.matches\)\)/);
});

test("global keyboard shortcuts do not escape an open modal boundary", async () => {
  const source = await readFile(APP_SOURCE_URL, "utf8");
  const handler = source.match(/#onKeydown\(event\) \{([\s\S]*?)\n  \}\n\n  #runCommand/u)?.[1] ?? "";

  assert.match(handler, /if \(event\.defaultPrevented\) return;\s+if \(this\.#root\.querySelector\("dialog\[open\]"\)\) return;/u);
  assert.match(handler, /this\.#restorePrevious\("topbar"\)/);
  assert.ok(handler.indexOf('querySelector("dialog[open]")') < handler.indexOf("#restorePrevious") || handler.indexOf('querySelector("dialog[open]")') < handler.indexOf("this.#restorePrevious"));
});

test("emergency docking is discoverable, modal-safe, and project-contextual", async () => {
  const source = await readFile(APP_SOURCE_URL, "utf8");
  const handler = source.match(/#onKeydown\(event\) \{([\s\S]*?)\n  \}\n\n  #runCommand/u)?.[1] ?? "";

  assert.match(handler, /event\.shiftKey && event\.key\.toLowerCase\(\) === "s"/u);
  assert.match(handler, /this\.#quickDock\(undefined, false\)/u);
  assert.doesNotMatch(handler, /sessions\.find\(/u);
  assert.ok(handler.indexOf('querySelector("dialog[open]")') < handler.indexOf('key.toLowerCase() === "s"'));
  assert.match(source, /activeSessionCount === 1 \? "应急停靠" : "会话冲突"/u);
  assert.match(source, /立即收拢活动会话 · Ctrl\/⌘ Shift S/u);
  assert.match(source, /if \(command === "quick-dock"\) this\.#quickDock\(undefined, false\)/u);
  assert.doesNotMatch(source, /#quickDockActiveSession/u);
  assert.match(source, /aria-label="快速停靠：\$\{attr\(controlContext\(project\.title\)\)\}" title="快速停靠（Ctrl\/⌘ Shift S）"/u);
});

test("quick capture project selection stays searchable and DOM-bounded", async () => {
  const source = await readFile(APP_SOURCE_URL, "utf8");

  assert.match(source, /data-control="quick-project-filter"/u);
  assert.match(source, /aria-describedby="quick-project-filter-status"/u);
  assert.match(source, /data-quick-project-status aria-live="polite"/u);
  assert.match(source, /buildQuickCaptureProjectWindow\(state,/u);
  assert.match(source, /renderQuickCaptureProjectOptions\(captureWindow\.items/u);
  assert.match(source, /select\.disabled = captureWindow\.items\.length === 0/u);
  assert.doesNotMatch(source, /const captureProjects = state\.projects\.filter/u);
});

test("project routes share one reentry card with dialogs and inline stats", async () => {
  const source = await readFile(APP_SOURCE_URL, "utf8");

  assert.match(source, /const currentReentryCard = currentProject/u);
  assert.match(source, /buildReentryCardWithStats\(state, currentProject\.id, now\)/u);
  assert.match(source, /#renderDialogs\(currentProject, activeSession, currentReentryCard\)/u);
  assert.match(source, /const stats = card\.stats/u);
  assert.match(source, /const reviewCheckpoint = reentryCard\?\.checkpoint/u);
  assert.doesNotMatch(source, /getProjectStats/u);
});

test("archive pagination streams projects and reuses workspace counts", async () => {
  const source = await readFile(APP_SOURCE_URL, "utf8");

  assert.match(source, /buildProjectCollectionWindow\(state\.projects, "archive"/u);
  assert.match(source, /const counts = buildWorkspaceCounts\(state\)/u);
  assert.match(source, /counts\.unarchivedProjects : counts\.archivedProjects/u);
  assert.doesNotMatch(source, /const projects = state\.projects\.filter\(\(item\) => item\.status === "archived"\)/u);
});

test("home recommendations rank only the requested visible window", async () => {
  const source = await readFile(APP_SOURCE_URL, "utf8");

  assert.match(source, /const rankedLimit = this\.#collectionLimits\.get\("home"\) \?\? COLLECTION_PAGE_SIZE/u);
  assert.match(source, /buildWorkspaceOverview\(state, now, \{ rankedLimit \}\)/u);
  assert.match(source, /buildCollectionWindow\(ranked, rankedLimit, rankedTotal\)/u);
});

test("pagination memory resets with workspace identity and stays bounded across project history", async () => {
  const source = await readFile(APP_SOURCE_URL, "utf8");
  const destroy = source.match(/destroy\(\) \{([\s\S]*?)\n  \}\n\n  render/u)?.[1] ?? "";
  const render = source.match(/render\(\{ preserveDialog = false \} = \{\}\) \{([\s\S]*?)\n  \}\n\n  #captureTransientDialog/u)?.[1] ?? "";
  const expand = source.match(/#showMoreTimeline\(projectId\) \{([\s\S]*?)\n  \}\n\n  #showMoreProjects/u)?.[1] ?? "";

  assert.match(source, /const MAX_REMEMBERED_TIMELINES = 24/u);
  assert.match(render, /this\.#workspaceCreatedAt !== state\.meta\.createdAt/u);
  assert.match(render, /this\.#timelineLimits\.clear\(\)/u);
  assert.match(render, /this\.#collectionLimits\.clear\(\)/u);
  assert.match(expand, /this\.#timelineLimits\.delete\(projectId\)/u);
  assert.match(expand, /this\.#timelineLimits\.size > MAX_REMEMBERED_TIMELINES/u);
  assert.match(expand, /this\.#timelineLimits\.keys\(\)\.next\(\)\.value/u);
  assert.match(destroy, /this\.#timelineLimits\.clear\(\)/u);
  assert.match(destroy, /this\.#collectionLimits\.clear\(\)/u);
  assert.match(destroy, /this\.#searchIndexState = null/u);
  assert.match(destroy, /this\.#searchIndex = null/u);
});

test("crumb actions carry their committed result out of the transaction without a second scan", async () => {
  const source = await readFile(APP_SOURCE_URL, "utf8");
  const resolutionHandler = source.match(/#toggleCrumbResolution\(crumbId, context\) \{([\s\S]*?)\n  \}\n\n  #toggleCrumbPin/u)?.[1] ?? "";
  const pinHandler = source.match(/#toggleCrumbPin\(crumbId\) \{([\s\S]*?)\n  \}\n\n  #prepareArchive/u)?.[1] ?? "";

  assert.equal(resolutionHandler.match(/state\.crumbs\.find/gu)?.length, 1);
  assert.equal(pinHandler.match(/state\.crumbs\.find/gu)?.length, 1);
  assert.match(resolutionHandler, /resolved = Boolean\(crumb\.resolvedAt\)/u);
  assert.match(pinHandler, /pinned = crumb\.pinned/u);
  assert.doesNotMatch(`${resolutionHandler}\n${pinHandler}`, /#store\.getState\(\)\.crumbs\.find/u);
});

test("starting a session selects only its latest checkpoint instead of building a full reentry card", async () => {
  const source = await readFile(APP_SOURCE_URL, "utf8");
  const dialogHandler = source.match(/#prepareSessionDialog\(projectId\) \{([\s\S]*?)\n  \}\n\n  #startSession/u)?.[1] ?? "";
  const handler = source.match(/#startSession\(data, form\) \{([\s\S]*?)\n  \}\n\n  #captureCrumb/u)?.[1] ?? "";

  assert.match(dialogHandler, /const plan = prepareSessionDialog\(state, projectId\)/u);
  assert.match(dialogHandler, /plan\.activeProject\.title/u);
  assert.doesNotMatch(dialogHandler, /(?:sessions|projects)\.find/u);
  assert.match(source, /prepareSessionStart/u);
  assert.match(handler, /prepareSessionStart\(state, data\.projectId\)/u);
  assert.match(handler, /next\.projects\[projectIndex\]/u);
  assert.doesNotMatch(handler, /buildReentryCard/u);
  assert.doesNotMatch(handler, /next\.projects\.find/u);
});

test("quick capture reuses its validated project position inside the transaction", async () => {
  const source = await readFile(APP_SOURCE_URL, "utf8");
  const handler = source.match(/#quickCapture\(data, form\) \{([\s\S]*?)\n  \}\n\n  #saveCheckpoint/u)?.[1] ?? "";

  assert.match(handler, /\{ crumb, projectIndex, projectTitle, linkedToActiveSession \}/u);
  assert.match(handler, /const target = next\.projects\[projectIndex\]/u);
  assert.match(handler, /target\.id !== crumb\.projectId \|\| target\.status === "archived"/u);
  assert.doesNotMatch(handler, /next\.projects\.find/u);
});

test("quick checkpoint review reuses its validated project position inside the transaction", async () => {
  const source = await readFile(APP_SOURCE_URL, "utf8");
  const handler = source.match(/#reviewQuickCheckpoint\(data, form\) \{([\s\S]*?)\n  \}\n\n  #continueStaleSession/u)?.[1] ?? "";

  assert.match(handler, /\{ checkpoint, projectIndex, projectTitle \}/u);
  assert.match(handler, /const project = state\.projects\[projectIndex\]/u);
  assert.match(handler, /project\.id !== checkpoint\.projectId \|\| project\.status === "archived"/u);
  assert.doesNotMatch(handler, /state\.projects\.find/u);
});

test("active capture and manual checkpoint transactions reuse validated context positions", async () => {
  const source = await readFile(APP_SOURCE_URL, "utf8");
  const capture = source.match(/#captureCrumb\(data\) \{([\s\S]*?)\n  \}\n\n  #quickCapture/u)?.[1] ?? "";
  const checkpoint = source.match(/#saveCheckpoint\(data, form\) \{([\s\S]*?)\n  \}\n\n  #reviewQuickCheckpoint/u)?.[1] ?? "";

  for (const handler of [capture, checkpoint]) {
    assert.match(handler, /locateActiveSessionContext\(state\)/u);
    assert.match(handler, /next\.sessions\[sessionIndex\]/u);
    assert.match(handler, /next\.projects\[projectIndex\]/u);
    assert.doesNotMatch(handler, /next\.(?:sessions|projects)\.find/u);
  }
});

test("checkpoint dialogs stay bound to the session that opened them", async () => {
  const source = await readFile(APP_SOURCE_URL, "utf8");
  const prepare = source.match(/#prepareCheckpointDialog\(\) \{([\s\S]*?)\n  \}\n\n  #saveCheckpoint/u)?.[1] ?? "";
  const save = source.match(/#saveCheckpoint\(data, form\) \{([\s\S]*?)\n  \}\n\n  #reviewQuickCheckpoint/u)?.[1] ?? "";

  assert.match(source, /if \(action === "open-checkpoint"\) this\.#prepareCheckpointDialog\(\)/u);
  assert.match(prepare, /locateActiveSessionContext\(this\.#store\.getState\(\)\)/u);
  assert.match(prepare, /this\.#pendingCheckpointSessionId = context\.session\.id/u);
  assert.match(save, /const pendingSessionId = this\.#pendingCheckpointSessionId/u);
  assert.match(save, /session\.id !== pendingSessionId/u);
  assert.match(save, /this\.#pendingCheckpointSessionId = null/u);
  assert.match(source, /dialog\?\.id === "checkpoint-dialog"\) this\.#pendingCheckpointSessionId = null/u);
});

test("quick docking reuses the core plan's active-context positions", async () => {
  const source = await readFile(APP_SOURCE_URL, "utf8");
  const handler = source.match(/#quickDock\(sessionId, continueAfter\) \{([\s\S]*?)\n  \}\n\n  #editProject/u)?.[1] ?? "";

  assert.match(handler, /prepareQuickDock\(state, sessionId, now\)/u);
  assert.match(handler, /const targetSessionId = activeSession\.id/u);
  assert.match(handler, /next\.sessions\[sessionIndex\]/u);
  assert.match(handler, /next\.projects\[projectIndex\]/u);
  assert.match(handler, /current\?\.id !== targetSessionId/u);
  assert.doesNotMatch(handler, /(?:state|next)\.(?:sessions|projects)\.find/u);
});

test("reentry brief copy is accessible and ignores stale asynchronous completions", async () => {
  const source = await readFile(APP_SOURCE_URL, "utf8");

  assert.match(source, /data-action="copy-reentry-brief"[^>]*aria-label="复制复航简报：/u);
  assert.match(source, /if \(action === "copy-reentry-brief"\) this\.#copyReentryBrief/u);
  assert.match(source, /const isCurrentRequest = this\.#clipboardRequestGate\.begin\(\)/u);
  assert.match(source, /await copyPlainText\(buildReentryBrief\(card\)\)/u);
  assert.match(source, /if \(!isCurrentRequest\(\)\) return/u);
  assert.match(source, /this\.#clipboardRequestGate\.invalidate\(\)/u);
});

test("dashboard exposes a bounded accessible workspace handoff copy action", async () => {
  const source = await readFile(APP_SOURCE_URL, "utf8");

  assert.match(source, /data-action="copy-workspace-handoff" aria-label="复制工作区交接清单"/u);
  assert.match(source, /if \(action === "copy-workspace-handoff"\) this\.#copyWorkspaceHandoff\(\)/u);
  assert.match(source, /rankedLimit: WORKSPACE_HANDOFF_PROJECT_LIMIT/u);
  assert.match(source, /copyPlainText\(buildWorkspaceHandoff\(overview, now\)\)/u);
  assert.match(source, /const isCurrentRequest = this\.#clipboardRequestGate\.begin\(\)/u);
});

test("backup sizing and download share the compact serialized snapshot path", async () => {
  const source = await readFile(APP_SOURCE_URL, "utf8");
  const sizing = source.match(/#getBackupSize\(state\) \{([\s\S]*?)\n  \}\n\n  #renderNotFound/u)?.[1] ?? "";
  const download = source.match(/#exportData\(\) \{([\s\S]*?)\n  \}\n\n  async #copyReentryBrief/u)?.[1] ?? "";

  assert.match(sizing, /this\.#store\.exportSnapshotText\(\)/u);
  assert.match(download, /new Blob\(\[this\.#store\.exportSnapshotText\(\)\]/u);
  assert.doesNotMatch(`${sizing}\n${download}`, /exportSnapshot\(\)|JSON\.stringify/u);
});

test("checkpoint-only open loops are labeled as historical instead of disappearing", async () => {
  const source = await readFile(new URL("../src/ui/app.js", import.meta.url), "utf8");

  assert.match(source, /#renderOpenLoops\(card\)/u);
  assert.match(source, /检查点曾记录（待确认）：/u);
  assert.match(source, /if \(card\.historicalOpenLoops\)/u);
});

test("archive cards batch reentry projection and record counting", async () => {
  const source = await readFile(new URL("../src/ui/app.js", import.meta.url), "utf8");

  assert.match(source, /buildReentryCards\(state, \[\.\.\.visibleIds\]\)/u);
  assert.match(source, /for \(const crumb of state\.crumbs\)/u);
  assert.match(source, /crumbCounts\.get\(project\.id\) \?\? 0/u);
  assert.doesNotMatch(source, /state\.crumbs\.filter\(\(item\) => item\.projectId === project\.id\)\.length/u);
});

test("archived cards expose a read-only detail route before restoration", async () => {
  const source = await readFile(APP_SOURCE_URL, "utf8");

  assert.match(source, /href="#\/project\/\$\{encodeURIComponent\(project\.id\)\}" aria-label="查看归档项目：\$\{attr\(controlContext\(project\.title\)\)\}">查看现场<\/a>/u);
  assert.match(source, /aria-label="恢复项目：\$\{attr\(controlContext\(project\.title\)\)\}">恢复项目<\/button>/u);
  assert.match(source, /所有历史记录保持只读/u);
});

test("repeated dynamic controls expose bounded contextual names and labeled groups", async () => {
  const source = await readFile(APP_SOURCE_URL, "utf8");

  assert.match(source, /class="segmented-control" role="group" aria-label="界面主题"/u);
  assert.match(source, /class="segmented-control" role="group" aria-label="动态效果"/u);
  assert.match(source, /aria-label="标记已解决：\$\{attr\(controlContext\(item\.text\)\)\}"/u);
  assert.match(source, /aria-label="\$\{crumb\.pinned \? "取消置顶" : "设为航标"\}：\$\{attr\(controlContext\(crumb\.text\)\)\}"/u);
  assert.match(source, /aria-label="恢复项目：\$\{attr\(controlContext\(project\.title\)\)\}"/u);
  assert.match(source, /compactText\(String\(value \?\? ""\)\.replace\(\/\\s\+\/gu, " "\), 80\)/u);
});
