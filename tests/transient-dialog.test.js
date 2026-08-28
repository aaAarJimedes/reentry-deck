import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_TRANSIENT_CONTROL_VALUE_LENGTH,
  boundTransientControlValue,
  normalizeTransientSelection
} from "../src/ui/app.js";

test("transient dialog values obey both control and global memory limits", () => {
  const long = "x".repeat(MAX_TRANSIENT_CONTROL_VALUE_LENGTH + 100);

  assert.equal(boundTransientControlValue(long).length, MAX_TRANSIENT_CONTROL_VALUE_LENGTH);
  assert.equal(boundTransientControlValue(long, 12), "x".repeat(12));
  assert.equal(boundTransientControlValue(long, MAX_TRANSIENT_CONTROL_VALUE_LENGTH + 1).length, MAX_TRANSIENT_CONTROL_VALUE_LENGTH);
  assert.equal(boundTransientControlValue(42, -1), "42");
  assert.equal(boundTransientControlValue(null, 10), "");
  assert.equal(boundTransientControlValue("a🚀b", 2), "a");
  assert.equal(boundTransientControlValue("a🚀b", 3), "a🚀");
  assert.equal(boundTransientControlValue("a\ud83d", 2), "a\ud83d", "an existing unmatched unit is not mistaken for a cut pair");
});

test("transient selections normalize order and clamp to the restored text", () => {
  assert.deepEqual(normalizeTransientSelection("abcd", 1, 3), [1, 3]);
  assert.deepEqual(normalizeTransientSelection("abcd", 20, 2), [2, 4]);
  assert.deepEqual(normalizeTransientSelection("abcd", 20, 30), [4, 4]);
  assert.equal(normalizeTransientSelection("abcd", -1, 2), null);
  assert.equal(normalizeTransientSelection("abcd", 1.5, 2), null);
  assert.equal(normalizeTransientSelection("abcd", null, null), null);
});
