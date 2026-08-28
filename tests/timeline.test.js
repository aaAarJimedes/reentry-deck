import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  COLLECTION_PAGE_SIZE,
  TIMELINE_PAGE_SIZE,
  buildCollectionWindow,
  buildProjectCollectionWindow,
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

  test("shows later insertions first when timestamps match", () => {
    const timestamp = "2026-08-28T02:00:00.000Z";
    const crumbs = [crumb("first", "p1", timestamp), crumb("second", "p1", timestamp)];

    assert.deepEqual(buildTimelineWindow(crumbs, "p1").items.map((item) => item.id), ["second", "first"]);
  });

  test("caps DOM-facing output even for very large histories", () => {
    const start = Date.parse("2026-08-01T00:00:00.000Z");
    const crumbs = Array.from({ length: 50_000 }, (_, index) => crumb(`c${index}`, "large", new Date(start + index).toISOString()));
    const nativeSort = Array.prototype.sort;
    let largestSortedArray = 0;
    Array.prototype.sort = function (...args) {
      largestSortedArray = Math.max(largestSortedArray, this.length);
      return nativeSort.apply(this, args);
    };
    let result;
    try {
      result = buildTimelineWindow(crumbs, "large");
    } finally {
      Array.prototype.sort = nativeSort;
    }

    assert.equal(result.total, 50_000);
    assert.equal(result.items.length, 30);
    assert.equal(result.remaining, 49_970);
    assert.equal(result.items[0].id, "c49999");
    assert.equal(result.items.at(-1).id, "c49970");
    assert.equal(largestSortedArray, 30, "only the visible window should reach Array.sort");
  });

  test("filters the target project before allocating sortable entries", () => {
    const crumbs = Array.from({ length: 50_000 }, (_, index) => crumb(`other-${index}`, "other", String(index)));
    crumbs.splice(123, 0, crumb("target-old", "target", "2026-08-27T00:00:00.000Z"));
    crumbs.push(crumb("target-new", "target", "2026-08-28T00:00:00.000Z"));
    Object.defineProperty(crumbs, "map", {
      value() {
        throw new Error("timeline must not map the full workspace");
      }
    });

    const result = buildTimelineWindow(crumbs, "target");

    assert.equal(result.total, 2);
    assert.deepEqual(result.items.map((item) => item.id), ["target-new", "target-old"]);
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

describe("buildProjectCollectionWindow", () => {
  test("streams the requested project scope while retaining only the visible window", () => {
    const projects = Array.from({ length: 50_000 }, (_, index) => ({
      id: `p${index}`,
      status: index % 2 ? "archived" : "active"
    }));
    for (const method of ["filter", "map", "slice"]) {
      Object.defineProperty(projects, method, {
        value: () => { throw new Error(`source array ${method} must not be used`); },
        configurable: true
      });
    }

    const archived = buildProjectCollectionWindow(projects, "archive");
    const home = buildProjectCollectionWindow(projects, "home", 24);

    assert.equal(archived.total, 25_000);
    assert.equal(archived.items.length, COLLECTION_PAGE_SIZE);
    assert.deepEqual(archived.items.map((project) => project.id), Array.from({ length: 12 }, (_, index) => `p${index * 2 + 1}`));
    assert.equal(archived.remaining, 24_988);
    assert.equal(archived.nextLimit, 24);
    assert.equal(home.total, 25_000);
    assert.equal(home.items.length, 24);
    assert.equal(home.items[0].id, "p0");
    assert.equal(home.items.at(-1).id, "p46");
  });

  test("fails closed for unknown scopes and invalid collections", () => {
    assert.deepEqual(buildProjectCollectionWindow(null, "archive", -1), {
      items: [], total: 0, shown: 0, remaining: 0, nextLimit: 0
    });
    assert.deepEqual(buildProjectCollectionWindow([{ id: "p1", status: "active" }], "other"), {
      items: [], total: 0, shown: 0, remaining: 0, nextLimit: 0
    });
  });
});
