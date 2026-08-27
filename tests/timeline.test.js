import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { TIMELINE_PAGE_SIZE, buildTimelineWindow } from "../src/core/timeline.js";

function crumb(id, projectId, createdAt) {
  return { id, projectId, createdAt };
}

describe("buildTimelineWindow", () => {
  test("returns the newest first page with truthful totals and continuation", () => {
    const crumbs = Array.from({ length: 75 }, (_, index) => crumb(
      `c${index}`,
      "p1",
      new Date(Date.parse("2026-08-01T00:00:00.000Z") + index * 1000).toISOString()
    ));
    crumbs.push(crumb("other", "p2", "2026-09-01T00:00:00.000Z"));

    const result = buildTimelineWindow(crumbs, "p1");

    assert.equal(TIMELINE_PAGE_SIZE, 30);
    assert.equal(result.total, 75);
    assert.equal(result.shown, 30);
    assert.equal(result.remaining, 45);
    assert.equal(result.nextLimit, 60);
    assert.deepEqual(result.items.map((item) => item.id), Array.from({ length: 30 }, (_, index) => `c${74 - index}`));
  });

  test("expands to the requested boundary and caps the final page", () => {
    const crumbs = Array.from({ length: 65 }, (_, index) => crumb(`c${index}`, "p1", `2026-08-28T00:${String(index).padStart(2, "0")}:00.000Z`));

    const middle = buildTimelineWindow(crumbs, "p1", 60);
    const final = buildTimelineWindow(crumbs, "p1", middle.nextLimit);

    assert.equal(middle.shown, 60);
    assert.equal(middle.remaining, 5);
    assert.equal(middle.nextLimit, 65);
    assert.equal(final.shown, 65);
    assert.equal(final.remaining, 0);
    assert.equal(final.nextLimit, 65);
  });

  test("falls back for invalid inputs and leaves source order untouched", () => {
    const crumbs = [
      crumb("invalid-a", "p1", "not-a-date"),
      crumb("newest", "p1", "2026-08-28T02:00:00.000Z"),
      crumb("invalid-b", "p1", null),
      crumb("older", "p1", "2026-08-28T01:00:00.000Z")
    ];
    const before = [...crumbs];

    const result = buildTimelineWindow(crumbs, "p1", -20);

    assert.deepEqual(result.items.map((item) => item.id), ["newest", "older", "invalid-a", "invalid-b"]);
    assert.deepEqual(crumbs, before);
    assert.deepEqual(buildTimelineWindow(null, "p1"), { items: [], total: 0, shown: 0, remaining: 0, nextLimit: 0 });
  });

  test("caps DOM-facing output even for very large histories", () => {
    const crumbs = Array.from({ length: 10_000 }, (_, index) => crumb(`c${index}`, "large", String(index)));
    const result = buildTimelineWindow(crumbs, "large");

    assert.equal(result.total, 10_000);
    assert.equal(result.items.length, 30);
    assert.equal(result.remaining, 9_970);
  });
});
