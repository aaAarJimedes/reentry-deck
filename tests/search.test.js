import test from "node:test";
import assert from "node:assert/strict";

import { extractHttpLinks, getProjectResources, searchWorkspace } from "../src/core/search.js";

const state = {
  projects: [
    { id: "p1", title: "研究结果图", description: "统一图例", nextAction: "打开 notebook", status: "active", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-04T00:00:00.000Z" },
    { id: "p2", title: "归档手册", description: "旧资料", nextAction: "", status: "archived", createdAt: "2025-01-01T00:00:00.000Z", updatedAt: "2025-01-02T00:00:00.000Z" }
  ],
  crumbs: [
    { id: "c1", projectId: "p1", type: "decision", text: "决定保持蓝色映射", createdAt: "2026-01-05T00:00:00.000Z" },
    { id: "c2", projectId: "p1", type: "question", text: "notebook 的导出路径在哪", createdAt: "2026-01-06T00:00:00.000Z" }
  ],
  checkpoints: [
    { id: "cp1", projectId: "p1", summary: "图例已经统一", nextAction: "打开 notebook", openLoops: "确认灰度输出", returnHint: "从末尾单元格开始", createdAt: "2026-01-03T00:00:00.000Z" }
  ]
};

test("searchWorkspace searches all evidence, requires every token, ranks titles, and respects limits", () => {
  assert.deepEqual(searchWorkspace(state, "").map((item) => item.id), []);
  assert.deepEqual(searchWorkspace(state, "notebook").map((item) => item.id), ["c2", "p1", "cp1"]);
  assert.deepEqual(searchWorkspace(state, "notebook 导出").map((item) => item.id), ["c2"]);
  assert.deepEqual(searchWorkspace(state, "研究结果图", { limit: 1 }).map((item) => item.id), ["p1"]);
  assert.deepEqual(searchWorkspace(state, "研究结果图", { limit: 0 }), []);
  assert.equal(searchWorkspace(state, "旧资料")[0].projectStatus, "archived");
});

test("searchWorkspace normalizes full-width and case variants and is deterministic on ties", () => {
  const variant = structuredClone(state);
  variant.crumbs.push(
    { id: "b", projectId: "p1", type: "note", text: "ＡＰＩ Link", createdAt: "invalid" },
    { id: "a", projectId: "p1", type: "note", text: "api link", createdAt: "invalid" }
  );
  assert.deepEqual(searchWorkspace(variant, "API LINK").map((item) => item.id), ["a", "b"]);
});

test("extractHttpLinks accepts only clean HTTP resources and removes prose punctuation and fragments", () => {
  const links = extractHttpLinks("见 https://example.com/docs?q=1#part，备用 http://localhost:8080/a). 重复 https://example.com/docs?q=1#other； javascript:alert(1) https://user:pw@example.com/x");
  assert.deepEqual(links, [
    { url: "https://example.com/docs?q=1", host: "example.com", label: "example.com/docs" },
    { url: "http://localhost:8080/a", host: "localhost:8080", label: "localhost:8080/a" }
  ]);
  assert.deepEqual(extractHttpLinks("https://[broken"), []);
  assert.deepEqual(extractHttpLinks("https://example.com", 0), []);
});

test("getProjectResources deduplicates newest evidence and preserves source metadata", () => {
  const resourceState = structuredClone(state);
  resourceState.projects[0].description = "规范 https://example.com/spec";
  resourceState.crumbs.push({ id: "new-link", projectId: "p1", type: "note", text: "最新规范 https://example.com/spec#v2 与 https://docs.example.org/start", createdAt: "2026-01-10T00:00:00.000Z" });
  resourceState.checkpoints[0].returnHint = "回到 https://example.com/spec";

  const resources = getProjectResources(resourceState, "p1");
  assert.equal(resources.length, 2);
  assert.deepEqual(resources.map((item) => item.url), ["https://example.com/spec", "https://docs.example.org/start"]);
  assert.equal(resources[0].sourceId, "new-link");
  assert.deepEqual(getProjectResources(resourceState, "p1", 0), []);
  assert.deepEqual(getProjectResources(resourceState, "missing"), []);
});
