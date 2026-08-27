import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  COLLECTION_PAGE_SIZE,
  TIMELINE_PAGE_SIZE,
  buildCollectionWindow,
  buildTimelineWindow
} from "../src/core/timeline.js";

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

describe("buildCollectionWindow", () => {
  test("returns an ordered first page without changing the source", () => {
    const items = Array.from({ length: 29 }, (_, index) => ({ id: `p${index}` }));
    const before = [...items];

    const result = buildCollectionWindow(items);

    assert.equal(COLLECTION_PAGE_SIZE, 12);
    assert.equal(result.total, 29);
    assert.equal(result.shown, 12);
    assert.equal(result.remaining, 17);
    assert.equal(result.nextLimit, 24);
    assert.deepEqual(result.items.map((item) => item.id), Array.from({ length: 12 }, (_, index) => `p${index}`));
    assert.deepEqual(items, before);
  });

  test("expands by a fixed page, caps the final page, and handles invalid input", () => {
    const items = Array.from({ length: 25 }, (_, index) => index);
    const middle = buildCollectionWindow(items, 24);
    const final = buildCollectionWindow(items, middle.nextLimit);

    assert.deepEqual(middle, { items: items.slice(0, 24), total: 25, shown: 24, remaining: 1, nextLimit: 25 });
    assert.deepEqual(final, { items, total: 25, shown: 25, remaining: 0, nextLimit: 25 });
    assert.deepEqual(buildCollectionWindow(null, -1), { items: [], total: 0, shown: 0, remaining: 0, nextLimit: 0 });
  });

  test("keeps a very large collection out of the initial DOM window", () => {
    const items = Array.from({ length: 50_000 }, (_, index) => index);
    const result = buildCollectionWindow(items);

    assert.equal(result.items.length, 12);
    assert.equal(result.remaining, 49_988);
  });
});
