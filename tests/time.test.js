import test from "node:test";
import assert from "node:assert/strict";

import {
  daysSince,
  elapsedSeconds,
  formatDateTime,
  formatDuration,
  formatRelative
} from "../src/core/time.js";

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
const NOW = Date.parse("2026-06-15T12:00:00.000Z");
const shortDateTime = new Intl.DateTimeFormat("zh-CN", {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit"
});

function at(offsetMs = 0) {
  return new Date(NOW + offsetMs).toISOString();
}

test("elapsedSeconds accepts numeric and date-like ends, floors partial seconds, and clamps negative time", () => {
  assert.equal(elapsedSeconds(at(-5_999), NOW), 5);
  assert.equal(elapsedSeconds(at(-5_999), at(0)), 5);
  assert.equal(elapsedSeconds(NOW - 1_001, NOW), 1);
  assert.equal(elapsedSeconds(at(1), NOW), 0);
  assert.equal(elapsedSeconds(at(0), NOW), 0);
});

test("elapsedSeconds returns zero for invalid endpoints", () => {
  assert.equal(elapsedSeconds("not-a-date", NOW), 0);
  assert.equal(elapsedSeconds(at(-1_000), "not-a-date"), 0);
  assert.equal(elapsedSeconds(undefined, NOW), 0);
});

test("elapsedSeconds uses Date.now when the end is omitted", (t) => {
  t.mock.method(Date, "now", () => NOW);

  assert.equal(elapsedSeconds(at(-2_500)), 2);
});

test("formatDuration formats zero, boundaries, long durations, numeric strings, and fractions", () => {
  const cases = [
    [undefined, "00:00:00"],
    ["invalid", "00:00:00"],
    [-1, "00:00:00"],
    [0, "00:00:00"],
    [0.99, "00:00:00"],
    [59.99, "00:00:59"],
    [60, "00:01:00"],
    [3_599, "00:59:59"],
    [3_600, "01:00:00"],
    [3_661.99, "01:01:01"],
    ["61", "00:01:01"],
    [90_061, "25:01:01"]
  ];

  for (const [input, expected] of cases) assert.equal(formatDuration(input), expected, `input: ${String(input)}`);
});

test("formatDuration compact mode selects the largest useful units", () => {
  assert.equal(formatDuration(0, { compact: true }), "0秒");
  assert.equal(formatDuration(59.99, { compact: true }), "59秒");
  assert.equal(formatDuration(60, { compact: true }), "1分");
  assert.equal(formatDuration(3_599, { compact: true }), "59分");
  assert.equal(formatDuration(3_600, { compact: true }), "1时0分");
  assert.equal(formatDuration(3_661, { compact: true }), "1时1分");
});

test("formatDuration normalizes non-finite durations instead of leaking Infinity/NaN", () => {
  assert.equal(formatDuration(Infinity), "00:00:00");
  assert.equal(formatDuration(-Infinity), "00:00:00");
  assert.equal(formatDuration(Infinity, { compact: true }), "0秒");
});

test("formatRelative returns unknown for invalid input and just-now inside the first minute", () => {
  assert.equal(formatRelative("not-a-date", NOW), "时间未知");
  assert.equal(formatRelative(at(0), "not-a-date"), "时间未知");
  assert.equal(formatRelative(at(0), Infinity), "时间未知");
  assert.equal(formatRelative(at(-MINUTE), new Date(NOW)), "1分钟前");
  assert.equal(formatRelative(at(0), NOW), "刚刚");
  assert.equal(formatRelative(at(-MINUTE + 1), NOW), "刚刚");
  assert.equal(formatRelative(at(MINUTE - 1), NOW), "刚刚");
});

test("formatRelative switches units exactly at minute, hour, and day boundaries", () => {
  const cases = [
    [-MINUTE, "1分钟前"],
    [MINUTE, "1分钟后"],
    [-HOUR + 1, "60分钟前"],
    [HOUR - 1, "60分钟后"],
    [-HOUR, "1小时前"],
    [HOUR, "1小时后"],
    [-DAY + 1, "24小时前"],
    [DAY - 1, "24小时后"],
    [-DAY, "昨天"],
    [DAY, "明天"],
    [-29 * DAY, "29天前"],
    [29 * DAY, "29天后"]
  ];

  for (const [offset, expected] of cases) {
    assert.equal(formatRelative(at(offset), NOW), expected, `offset: ${offset}`);
  }
});

test("formatRelative switches to an absolute short date at 30 days", () => {
  for (const offset of [-30 * DAY, 30 * DAY, -365 * DAY]) {
    const date = new Date(NOW + offset);
    assert.equal(formatRelative(date, NOW), shortDateTime.format(date));
  }
});

test("formatDateTime formats valid values and rejects invalid dates", () => {
  const date = new Date("2026-01-15T03:04:00.000Z");

  assert.equal(formatDateTime(date), shortDateTime.format(date));
  assert.equal(formatDateTime(date.toISOString()), shortDateTime.format(date));
  assert.equal(formatDateTime("not-a-date"), "时间未知");
});

test("daysSince returns elapsed fractional days and clamps future/invalid dates", () => {
  assert.equal(daysSince(at(0), NOW), 0);
  assert.equal(daysSince(at(-DAY), NOW), 1);
  assert.equal(daysSince(at(-1.5 * DAY), NOW), 1.5);
  assert.equal(daysSince(at(DAY), NOW), 0);
  assert.equal(daysSince("not-a-date", NOW), 0);
  assert.equal(daysSince(at(-DAY), "not-a-date"), 0);
  assert.equal(daysSince(at(-DAY), Infinity), 0);
  assert.equal(daysSince(at(-DAY), new Date(NOW)), 1);
});
