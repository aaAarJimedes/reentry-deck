import assert from "node:assert/strict";
import test from "node:test";

import { AppStore, MemoryStorage } from "../src/core/store.js";
import { createLocalCommitFocusGate } from "../src/ui/app.js";

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

test("a real stale-tab rejection cannot transfer capture focus to the adopted workspace", () => {
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
  assert.throws(() => gate.run('[data-form="capture-crumb"] textarea', () => {
    stale.update((state) => { state.settings.staleAfterDays = 14; }, Date.parse("2026-08-30T00:02:00.000Z"));
  }), /另一个标签页刚刚更新/u);

  assert.deepEqual(sources, ["external"]);
  assert.deepEqual(focused, []);
  assert.equal(stale.getState().settings.theme, "dark");
  stale.update((state) => { state.settings.staleAfterDays = 14; }, Date.parse("2026-08-30T00:03:00.000Z"));
  assert.deepEqual(sources, ["external", "local"]);
  assert.deepEqual(focused, []);

  gate.run('[data-form="capture-crumb"] textarea', () => {
    stale.update((state) => { state.settings.staleAfterDays = 21; }, Date.parse("2026-08-30T00:04:00.000Z"));
  });
  assert.deepEqual(focused, ['[data-form="capture-crumb"] textarea']);
});
