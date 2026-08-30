import assert from "node:assert/strict";
import test from "node:test";

import { AppStore, MemoryStorage } from "../src/core/store.js";
import {
  createInlineCaptureDraftGate,
  createLocalCommitFocusGate,
  createRouteFocusGate,
  createTransientDialogRestoreGate
} from "../src/ui/app.js";

test("transient dialog restore gate carries snapshots across redraws and clears by request identity", () => {
  const gate = createTransientDialogRestoreGate();
  const snapshot = Object.freeze({ id: "quick-capture-dialog" });
  const first = gate.prepare(1, snapshot, true);

  assert.equal(gate.hasPending(), true);
  assert.equal(gate.addNotice("导入稍后重试"), true);
  const second = gate.prepare(2, null, true);
  assert.notEqual(second, first);
  assert.equal(second.snapshot, snapshot);
  assert.equal(second.notice, "导入稍后重试");
  assert.equal(gate.consume(first), null);
  assert.equal(gate.hasPending(), true);
  assert.equal(gate.consume(second), second);
  assert.equal(gate.hasPending(), false);

  const superseded = gate.prepare(3, snapshot, true);
  assert.ok(superseded);
  assert.equal(gate.prepare(4, null, false), null);
  assert.equal(gate.consume(superseded), null);
  assert.equal(gate.addNotice("没有待恢复项"), false);
  gate.prepare(5, snapshot, true);
  gate.clear();
  assert.equal(gate.hasPending(), false);
});

test("inline capture draft gate preserves unrelated redraws and consumes only its own local commit", () => {
  const storage = new MemoryStorage();
  const store = new AppStore(storage, Date.parse("2026-08-30T00:00:00.000Z"), null);
  const gate = createInlineCaptureDraftGate();
  const decisions = [];
  store.subscribe((_state, event) => decisions.push([event.source, gate.shouldPreserve(event.source)]));

  store.update((state) => { state.settings.theme = "dark"; }, Date.parse("2026-08-30T00:01:00.000Z"));
  gate.runConsuming(() => {
    store.update((state) => { state.settings.staleAfterDays = 14; }, Date.parse("2026-08-30T00:02:00.000Z"));
  });
  store.update((state) => { state.settings.reducedMotion = true; }, Date.parse("2026-08-30T00:03:00.000Z"));

  assert.deepEqual(decisions, [["local", true], ["local", false], ["local", true]]);
});

test("inline capture draft gate preserves an adopted external redraw and resets after rejection", () => {
  const storage = new MemoryStorage();
  const writer = new AppStore(storage, Date.parse("2026-08-30T00:00:00.000Z"), null);
  const stale = new AppStore(storage, Date.parse("2026-08-30T00:00:00.000Z"), null);
  const gate = createInlineCaptureDraftGate();
  const decisions = [];
  stale.subscribe((_state, event) => decisions.push([event.source, gate.shouldPreserve(event.source)]));

  writer.update((state) => { state.settings.theme = "dark"; }, Date.parse("2026-08-30T00:01:00.000Z"));
  assert.throws(() => gate.runConsuming(() => {
    stale.update((state) => { state.settings.staleAfterDays = 14; }, Date.parse("2026-08-30T00:02:00.000Z"));
  }), /另一个标签页刚刚更新/u);
  stale.update((state) => { state.settings.reducedMotion = true; }, Date.parse("2026-08-30T00:03:00.000Z"));

  assert.deepEqual(decisions, [["external", true], ["local", true]]);
});

test("local commit focus waits through external redraws for the matching local update", () => {
  const gate = createLocalCommitFocusGate();

  const result = gate.run("#saved-control", () => {
    assert.equal(gate.consume("external"), null);
    assert.equal(gate.consume("local"), "#saved-control");
    assert.equal(gate.consume("local"), null);
    return "saved";
  });

  assert.equal(result, "saved");
});

test("failed local commits cannot leak focus into a later redraw", () => {
  const gate = createLocalCommitFocusGate();

  assert.throws(() => gate.run("#invalid-control", () => {
    throw new Error("validation failed");
  }), /validation failed/u);
  assert.equal(gate.consume("local"), null);

  assert.throws(() => gate.run("#stale-control", () => {
    assert.equal(gate.consume("external"), null);
    throw new Error("conflict");
  }), /conflict/u);

  assert.equal(gate.consume("local"), null);
});

test("silent commits clear unused focus requests before later updates", () => {
  const gate = createLocalCommitFocusGate();

  gate.run("#unused-control", () => "no update emitted");

  assert.equal(gate.consume("local"), null);
});

test("clearing the gate invalidates an armed request", () => {
  const gate = createLocalCommitFocusGate();

  gate.run("#destroyed-control", () => {
    gate.clear();
    assert.equal(gate.consume("local"), null);
  });
});

test("route focus is one-shot and requires the exact route and session", () => {
  const gate = createRouteFocusGate();

  gate.arm("#/project/p1", "session-1", "#capture-session-1");
  assert.equal(gate.consume("#/project/p1", "session-1"), "#capture-session-1");
  assert.equal(gate.consume("#/project/p1", "session-1"), null);

  gate.arm("#/project/p1", "session-1", "#wrong-route");
  assert.equal(gate.consume("#/project/p2", "session-1"), null);
  assert.equal(gate.consume("#/project/p1", "session-1"), null);

  gate.arm("#/project/p1", "session-1", "#wrong-session");
  assert.equal(gate.consume("#/project/p1", "session-2"), null);

  gate.arm("#/project/p1", "session-1", "#destroyed");
  gate.clear();
  assert.equal(gate.consume("#/project/p1", "session-1"), null);
});

for (const [label, focusSelector] of [
  ["main content", "#main-content"],
  ["follow-up capture", '[data-form="capture-crumb"] textarea'],
  ["quick capture trigger", '[data-action="open-quick-capture"]'],
  ["project edit trigger", '[data-action="edit-project"]'],
  ["project status control", '[data-control="project-status"]'],
  ["resolution control", '[data-action="toggle-crumb-resolution"]'],
  ["pin control", '[data-action="toggle-crumb-pin"]'],
  ["theme control", '[data-action="set-theme"]'],
  ["motion control", '[data-action="set-motion"]'],
  ["attention threshold", '[data-control="stale-days"]']
]) {
  test(`a real stale-tab rejection cannot transfer ${label} focus to the adopted workspace`, () => {
    const storage = new MemoryStorage();
    const writer = new AppStore(storage, Date.parse("2026-08-30T00:00:00.000Z"), null);
    const stale = new AppStore(storage, Date.parse("2026-08-30T00:00:00.000Z"), null);
    const gate = createLocalCommitFocusGate();
    const focused = [];
    const sources = [];
    stale.subscribe((_state, event) => {
      sources.push(event.source);
      const selector = gate.consume(event.source);
      if (selector) focused.push(selector);
    });

    writer.update((state) => { state.settings.theme = "dark"; }, Date.parse("2026-08-30T00:01:00.000Z"));
    assert.throws(() => gate.run(focusSelector, () => {
      stale.update((state) => { state.settings.staleAfterDays = 14; }, Date.parse("2026-08-30T00:02:00.000Z"));
    }), /另一个标签页刚刚更新/u);

    assert.deepEqual(sources, ["external"]);
    assert.deepEqual(focused, []);
    assert.equal(stale.getState().settings.theme, "dark");
    stale.update((state) => { state.settings.staleAfterDays = 14; }, Date.parse("2026-08-30T00:03:00.000Z"));
    assert.deepEqual(sources, ["external", "local"]);
    assert.deepEqual(focused, []);

    gate.run(focusSelector, () => {
      stale.update((state) => { state.settings.staleAfterDays = 21; }, Date.parse("2026-08-30T00:04:00.000Z"));
    });
    assert.deepEqual(focused, [focusSelector]);
  });
}
