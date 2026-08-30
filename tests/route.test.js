import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { ROUTE_HASH_LIMIT, localDaySignature, parseRoute } from "../src/ui/app.js";

describe("parseRoute", () => {
  test("accepts the supported top-level routes and legacy short hashes", () => {
    assert.deepEqual(parseRoute(""), { name: "home" });
    assert.deepEqual(parseRoute("#/"), { name: "home" });
    assert.deepEqual(parseRoute("#/archive"), { name: "archive" });
    assert.deepEqual(parseRoute("#/settings"), { name: "settings" });
    assert.deepEqual(parseRoute("#settings"), { name: "settings" });
    assert.deepEqual(parseRoute(null), { name: "home" });
  });

  test("decodes a bounded project id including an encoded slash", () => {
    assert.deepEqual(parseRoute("#/project/client%2Fbeta"), { name: "project", id: "client/beta" });
    assert.deepEqual(parseRoute(`#/project/${encodeURIComponent("客户门户")}`), { name: "project", id: "客户门户" });
  });

  test("fails closed for malformed, ambiguous, or oversized hashes", () => {
    for (const hash of [
      "#/unknown",
      "#/settings/extra",
      "#/archive/extra",
      "#/project",
      "#/project/",
      "#/project/id/extra",
      "#/project/%",
      "#/project/%00",
      "#/project/%C2%85hidden",
      "#/project/%E2%80%AEhidden",
      `#/project/${"a".repeat(201)}`,
      `#/project/${"%61".repeat(801)}`
    ]) {
      assert.deepEqual(parseRoute(hash), { name: "notFound" }, hash);
    }
  });

  test("rejects the total hash budget before route segmentation", () => {
    const validUnicodeId = "界".repeat(200);
    assert.ok(`#/project/${encodeURIComponent(validUnicodeId)}`.length < ROUTE_HASH_LIMIT);
    assert.deepEqual(parseRoute(`#/project/${encodeURIComponent(validUnicodeId)}`), { name: "project", id: validUnicodeId });
    assert.deepEqual(parseRoute(`#/${"segment/".repeat(ROUTE_HASH_LIMIT)}`), { name: "notFound" });
  });
});

test("localDaySignature changes only at the local calendar boundary", () => {
  const endOfDay = new Date(2026, 7, 28, 23, 59, 59, 999).getTime();
  const nextDay = new Date(2026, 7, 29, 0, 0, 0, 0).getTime();

  assert.equal(localDaySignature(endOfDay), "2026-8-28");
  assert.equal(localDaySignature(nextDay), "2026-8-29");
  assert.equal(localDaySignature("not-a-date"), "invalid");
});
