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

test("backup reads ignore stale completions and are invalidated on app destruction", async () => {
  const source = await readFile(APP_SOURCE_URL, "utf8");

  assert.match(source, /const isCurrentRequest = this\.#importRequestGate\.begin\(\)/);
  assert.match(source, /if \(!isCurrentRequest\(\)\) return/);
  assert.match(source, /if \(isCurrentRequest\(\)\) this\.#toast/);
  assert.match(source, /this\.#importRequestGate\.invalidate\(\)/);
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
  assert.match(source, /<div class="segmented-control" aria-label="动态效果">/);
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
