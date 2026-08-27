import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const APP_SOURCE_URL = new URL("../src/ui/app.js", import.meta.url);
const STYLE_SOURCE_URL = new URL("../src/styles.css", import.meta.url);

test("project archival uses an accessible in-app confirmation instead of window.confirm", async () => {
  const source = await readFile(APP_SOURCE_URL, "utf8");

  assert.doesNotMatch(source, /window\.confirm\s*\(/);
  assert.match(
    source,
    /<dialog id="archive-confirm-dialog" aria-labelledby="archive-confirm-title" aria-describedby="archive-confirm-description">/
  );
  assert.match(source, /id="archive-confirm-description"/);
  assert.match(source, /data-archive-project-title/);
  assert.match(source, /data-action="close-dialog" autofocus>取消<\/button>/);
  assert.match(source, /data-action="confirm-archive">确认移入归档<\/button>/);
  assert.match(source, /if \(action === "archive-project"\) this\.#prepareArchive/);
  assert.match(source, /if \(action === "confirm-archive"\) this\.#confirmArchive/);
});

test("user-triggered mutation surfaces are guarded by the shared action boundary", async () => {
  const source = await readFile(APP_SOURCE_URL, "utf8");

  assert.match(source, /addEventListener\("click", \(event\) => this\.#runUserAction\(\(\) => this\.#onClick\(event\)\), listenerOptions\)/);
  assert.match(source, /addEventListener\("change", \(event\) => this\.#runUserAction\(\(\) => this\.#onChange\(event\)\), listenerOptions\)/);
  assert.match(source, /addEventListener\("keydown", \(event\) => this\.#runUserAction\(\(\) => this\.#onKeydown\(event\)\), listenerOptions\)/);
  assert.match(source, /requestAnimationFrame\(\(\) => this\.#runUserAction/);
  assert.match(source, /操作未完成，请根据最新状态重试/);
});

test("app destruction releases listeners, subscriptions, and toast timers", async () => {
  const source = await readFile(APP_SOURCE_URL, "utf8");

  assert.match(source, /const listenerOptions = \{ signal: this\.#eventController\.signal \}/);
  assert.match(source, /this\.#eventController\.abort\(\)/);
  assert.match(source, /this\.#unsubscribeStore\?\.\(\)/);
  assert.match(source, /for \(const timerId of this\.#toastTimers\.values\(\)\) window\.clearTimeout\(timerId\)/);
  assert.match(source, /this\.#store\.destroy\?\.\(\)/);
});

test("quick-dock continuation advances workspace time through the follow-up session", async () => {
  const source = await readFile(APP_SOURCE_URL, "utf8");

  assert.match(source, /\}, followUp \? Date\.parse\(followUp\.startedAt\) : now\);/);
});

test("session lifecycle warnings refresh after time boundaries without erasing active input", async () => {
  const source = await readFile(APP_SOURCE_URL, "utf8");

  assert.match(source, /#sessionHealthSignature = "none"/u);
  assert.match(source, /this\.#sessionHealthSignature = sessionHealthSignature/u);
  assert.match(source, /if \(nextSignature === this\.#sessionHealthSignature\) return/u);
  assert.match(source, /focusedControl\.matches\?\.\("input, textarea, select"\)/u);
  assert.match(source, /this\.render\(\{ preserveDialog: true \}\)/u);
  assert.match(source, /health\.staleReasons\.join\(","\)/u);
});

test("dialog redraw restoration preserves button focus as well as field values and selections", async () => {
  const source = await readFile(APP_SOURCE_URL, "utf8");

  assert.doesNotMatch(source, /dialog\.id === "import-preview-dialog"\) return null/u);
  assert.match(source, /querySelectorAll\("button, input, select, textarea"\)/u);
  assert.match(source, /const activeFocusableIndex = focusables\.indexOf\(document\.activeElement\)/u);
  assert.match(source, /activeControlIndex,\s+activeFocusableIndex,/u);
  assert.match(source, /const active = focusables\[snapshot\.activeFocusableIndex\]/u);
  assert.match(source, /active === controls\[snapshot\.activeControlIndex\]/u);
  assert.match(source, /transientDialog\?\.id === "import-preview-dialog"/u);
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

test("reentry brief copy is accessible and ignores stale asynchronous completions", async () => {
  const source = await readFile(APP_SOURCE_URL, "utf8");

  assert.match(source, /data-action="copy-reentry-brief"[^>]*aria-label="复制复航简报：/u);
  assert.match(source, /if \(action === "copy-reentry-brief"\) this\.#copyReentryBrief/u);
  assert.match(source, /const isCurrentRequest = this\.#clipboardRequestGate\.begin\(\)/u);
  assert.match(source, /await copyPlainText\(buildReentryBrief\(card\)\)/u);
  assert.match(source, /if \(!isCurrentRequest\(\)\) return/u);
  assert.match(source, /this\.#clipboardRequestGate\.invalidate\(\)/u);
});

test("checkpoint-only open loops are labeled as historical instead of disappearing", async () => {
  const source = await readFile(new URL("../src/ui/app.js", import.meta.url), "utf8");

  assert.match(source, /#renderOpenLoops\(card\)/u);
  assert.match(source, /检查点曾记录（待确认）：/u);
  assert.match(source, /if \(card\.historicalOpenLoops\)/u);
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
