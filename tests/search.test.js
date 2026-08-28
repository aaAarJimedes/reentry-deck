import test from "node:test";
import assert from "node:assert/strict";

import {
  RESOURCE_LABEL_LIMIT,
  RESOURCE_TEXT_SCAN_LIMIT,
  SEARCH_QUERY_LIMIT,
  SEARCH_TOKEN_LENGTH_LIMIT,
  SEARCH_TOKEN_LIMIT,
  buildWorkspaceSearchIndex,
  extractHttpLinks,
  getProjectResources,
  searchWorkspace,
  searchWorkspaceIndex
} from "../src/core/search.js";

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
    { id: "a", projectId: "p1", type: "note", text: "api link", createdAt: "invalid" },
    { id: "ä", projectId: "p1", type: "note", text: "stable unicode tie", createdAt: "invalid" },
    { id: "z", projectId: "p1", type: "note", text: "stable unicode tie", createdAt: "invalid" }
  );
  assert.deepEqual(searchWorkspace(variant, "API LINK").map((item) => item.id), ["a", "b"]);
  assert.deepEqual(searchWorkspace(variant, "stable unicode tie").map((item) => item.id), ["z", "ä"]);
});

test("searchWorkspace rejects queries outside the bounded comparison budget", () => {
  const index = buildWorkspaceSearchIndex(state);
  const tooManyTokens = Array.from({ length: SEARCH_TOKEN_LIMIT + 1 }, (_, index) => `词${index}`).join(" ");

  assert.deepEqual(searchWorkspaceIndex(index, "n".repeat(SEARCH_TOKEN_LENGTH_LIMIT + 1)), []);
  assert.deepEqual(searchWorkspaceIndex(index, tooManyTokens), []);
  assert.deepEqual(searchWorkspaceIndex(index, "x".repeat(SEARCH_QUERY_LIMIT + 1)), []);
  assert.ok("ﷺ".repeat(30).length < SEARCH_QUERY_LIMIT);
  assert.ok("ﷺ".repeat(30).normalize("NFKC").length > SEARCH_QUERY_LIMIT);
  assert.deepEqual(searchWorkspaceIndex(index, "ﷺ".repeat(30)), []);
  assert.deepEqual(searchWorkspaceIndex(index, `${"notebook ".repeat(SEARCH_TOKEN_LIMIT)}notebook`).map((item) => item.id), ["c2", "p1", "cp1"]);
});

test("a reusable search index preserves results across queries and snapshots normalized evidence", () => {
  const indexedState = structuredClone(state);
  const index = buildWorkspaceSearchIndex(indexedState);

  assert.deepEqual(searchWorkspaceIndex(index, "notebook").map((item) => item.id), ["c2", "p1", "cp1"]);
  assert.deepEqual(searchWorkspaceIndex(index, "研究结果图", { limit: 1 }).map((item) => item.id), ["p1"]);
  assert.deepEqual(searchWorkspaceIndex(index, "", { limit: 20 }), []);
  assert.deepEqual(searchWorkspaceIndex(null, "notebook"), []);

  indexedState.crumbs[1].text = "changed after indexing";
  assert.deepEqual(searchWorkspaceIndex(index, "notebook 导出").map((item) => item.id), ["c2"]);
  assert.deepEqual(searchWorkspaceIndex(index, "changed after indexing"), []);
});

test("search snippets collapse whitespace and never split a Unicode code point", () => {
  const unicodeState = structuredClone(state);
  unicodeState.crumbs.push({
    id: "unicode",
    projectId: "p1",
    type: "note",
    text: `needle\n\t${"😀".repeat(100)}`,
    createdAt: "2026-01-07T00:00:00.000Z"
  });

  const [result] = searchWorkspace(unicodeState, "needle");
  assert.equal(result.id, "unicode");
  assert.ok(result.snippet.length <= 150);
  assert.match(result.snippet, /^needle 😀+…$/u);
  assert.equal(result.snippet.includes("\n"), false);
});

test("a 50,000-record index only materializes and sorts the bounded result window", () => {
  const large = {
    projects: [{ ...state.projects[0] }],
    crumbs: Array.from({ length: 49_999 }, (_, index) => ({
      id: `large-${String(49_998 - index).padStart(5, "0")}`,
      projectId: "p1",
      type: "note",
      text: index % 5_000 === 0 ? `needle common ${index}` : `common evidence ${index}`,
      createdAt: "2026-01-01T00:00:00.000Z"
    })),
    checkpoints: []
  };
  large.projects.map = () => {
    throw new Error("search indexing must not map source collections");
  };
  const originalFilter = Array.prototype.filter;
  Array.prototype.filter = function () {
    throw new Error("search indexing must not allocate field filter arrays");
  };
  let index;
  try {
    index = buildWorkspaceSearchIndex(large);
  } finally {
    Array.prototype.filter = originalFilter;
  }
  const results = searchWorkspaceIndex(index, "needle", { limit: 100 });

  assert.equal(index.candidates.length, 50_000);
  assert.equal(results.length, 10);
  assert.ok(results.every((item) => item.title.startsWith("needle")));

  const originalSort = Array.prototype.sort;
  let largestSortedLength = 0;
  Array.prototype.sort = function (...args) {
    largestSortedLength = Math.max(largestSortedLength, this.length);
    return originalSort.apply(this, args);
  };
  try {
    const broadResults = searchWorkspaceIndex(index, "common");
    assert.equal(broadResults.length, 40);
    assert.equal(broadResults[0].id, "large-00000");
    assert.equal(broadResults.at(-1).id, "large-00039");
  } finally {
    Array.prototype.sort = originalSort;
  }
  assert.equal(largestSortedLength, 40);
});

test("extractHttpLinks accepts only clean HTTP resources and removes prose punctuation and fragments", () => {
  const links = extractHttpLinks("见 https://example.com/docs?q=1#part，备用 http://localhost:8080/a). 重复 https://example.com/docs?q=1#other； javascript:alert(1) https://user:pw@example.com/x https://example.com/%00hidden https://example.com/%E2%80%AEtxt");
  assert.deepEqual(links, [
    { url: "https://example.com/docs?q=1", host: "example.com", label: "example.com/docs" },
    { url: "http://localhost:8080/a", host: "localhost:8080", label: "localhost:8080/a" }
  ]);
  assert.deepEqual(extractHttpLinks("https://[broken"), []);
  assert.deepEqual(extractHttpLinks(`https://example.com/${"a".repeat(2_049)}`), []);
  assert.deepEqual(extractHttpLinks("https://example.com/\u202Etxt"), []);
  assert.deepEqual(extractHttpLinks("https://example.com/%C2%85hidden"), []);
  assert.deepEqual(extractHttpLinks("https://example.com/path\u0085hidden"), []);
  assert.deepEqual(extractHttpLinks("https://example.com", 0), []);
});

test("extractHttpLinks canonicalizes equivalent DNS trailing dots before deduplication", () => {
  assert.deepEqual(extractHttpLinks("https://example.com./guide#one https://example.com/guide#two https://example.com../guide"), [
    { url: "https://example.com/guide", host: "example.com", label: "example.com/guide" }
  ]);
  assert.deepEqual(extractHttpLinks("https://./guide"), []);
});

test("extractHttpLinks retains a safe target while bounding its human-readable label", () => {
  const path = "a".repeat(1_000);
  const [link] = extractHttpLinks(`https://example.com/${path}`);

  assert.equal(link.url, `https://example.com/${path}`);
  assert.ok(link.label.length <= RESOURCE_LABEL_LIMIT);
  assert.match(link.label, /^example\.com\/a+…$/u);
});

test("extractHttpLinks rejects oversized evidence before starting a regex scan", (t) => {
  t.mock.method(String.prototype, "matchAll", () => { throw new Error("regex scan must not start"); });

  assert.deepEqual(extractHttpLinks("x".repeat(RESOURCE_TEXT_SCAN_LIMIT + 1)), []);
});

test("extractHttpLinks stops at CJK prose punctuation and rejects mixed-label host ambiguity", () => {
  assert.deepEqual(
    extractHttpLinks("见 https://example.com、下一步 https://example.org（文档） https://example.net/路径：说明"),
    [
      { url: "https://example.com/", host: "example.com", label: "example.com" },
      { url: "https://example.org/", host: "example.org", label: "example.org" },
      { url: "https://example.net/%E8%B7%AF%E5%BE%84", host: "example.net", label: "example.net/路径" }
    ]
  );
  assert.deepEqual(extractHttpLinks("https://example.com下一步"), []);
  assert.deepEqual(extractHttpLinks("https://例子.测试/路径"), [
    { url: "https://xn--fsqu00a.xn--0zwm56d/%E8%B7%AF%E5%BE%84", host: "xn--fsqu00a.xn--0zwm56d", label: "xn--fsqu00a.xn--0zwm56d/路径" }
  ]);
  assert.deepEqual(extractHttpLinks("https://例子.com/路径"), [
    { url: "https://xn--fsqu00a.com/%E8%B7%AF%E5%BE%84", host: "xn--fsqu00a.com", label: "xn--fsqu00a.com/路径" }
  ]);
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

test("getProjectResources prefers reliable sources and later insertions when evidence times tie", () => {
  for (const timestamp of ["2026-01-10T00:00:00.000Z", "invalid"]) {
    const resourceState = structuredClone(state);
    resourceState.projects[0].description = "项目 https://shared.example/ 与 https://project.example/";
    resourceState.projects[0].updatedAt = timestamp;
    resourceState.crumbs = [
      { id: "crumb-old", projectId: "p1", type: "note", text: "旧随记 https://shared.example/ 与 https://crumb-old.example/", createdAt: timestamp },
      { id: "crumb-new", projectId: "p1", type: "note", text: "新随记 https://shared.example/ 与 https://crumb-new.example/", createdAt: timestamp }
    ];
    resourceState.checkpoints = [
      { id: "checkpoint-old", projectId: "p1", summary: "旧检查点 https://shared.example/ 与 https://checkpoint-old.example/", nextAction: "", openLoops: "", returnHint: "", createdAt: timestamp },
      { id: "checkpoint-new", projectId: "p1", summary: "新检查点 https://shared.example/ 与 https://checkpoint-new.example/", nextAction: "", openLoops: "", returnHint: "", createdAt: timestamp }
    ];

    const resources = getProjectResources(resourceState, "p1");

    assert.deepEqual(resources.map((item) => item.sourceId), [
      "checkpoint-new",
      "checkpoint-new",
      "checkpoint-old",
      "crumb-new",
      "crumb-old",
      "p1"
    ]);
    assert.equal(resources[0].url, "https://shared.example/");
  }
});

test("getProjectResources skips no-link history before reading timestamps or allocating sort entries", () => {
  let irrelevantTimestampReads = 0;
  const noLink = {
    id: "plain",
    projectId: "p1",
    type: "note",
    text: "ordinary evidence without a resource",
    get createdAt() {
      irrelevantTimestampReads += 1;
      throw new Error("irrelevant timestamp was read");
    }
  };
  const resourceState = {
    projects: [{ ...state.projects[0], description: "", nextAction: "" }],
    sessions: [],
    crumbs: [
      ...new Array(50_000).fill(noLink),
      { id: "linked", projectId: "p1", type: "note", text: "Guide HTTPS://docs.example.org/start", createdAt: "2026-01-10T00:00:00.000Z" }
    ],
    checkpoints: []
  };

  const resources = getProjectResources(resourceState, "p1");

  assert.deepEqual(resources.map((item) => item.url), ["https://docs.example.org/start"]);
  assert.equal(irrelevantTimestampReads, 0);
});

test("getProjectResources retains only the best unique resource window at the record boundary", () => {
  const crumbs = Array.from({ length: 49_999 }, (_, index) => ({
    id: `crumb-${index}`,
    projectId: "p1",
    type: "note",
    text: `resource https://docs.example/${index}`,
    createdAt: new Date(Date.parse("2026-01-01T00:00:00.000Z") + index).toISOString()
  }));
  for (const method of ["filter", "map", "sort", "find"]) {
    Object.defineProperty(crumbs, method, {
      value: () => { throw new Error(`source array ${method} must not be used`); },
      configurable: true
    });
  }
  const projects = [{ id: "p1", description: "", nextAction: "", createdAt: "2026-01-01T00:00:00.000Z" }];
  Object.defineProperty(projects, "find", {
    value: () => { throw new Error("source project find must not be used"); },
    configurable: true
  });

  const resources = getProjectResources({ projects, crumbs, checkpoints: [] }, "p1");

  assert.equal(resources.length, 20);
  assert.deepEqual(resources.map((item) => item.sourceId), Array.from({ length: 20 }, (_, index) => `crumb-${49_998 - index}`));
  assert.equal(resources[0].url, "https://docs.example/49998");
  assert.equal(resources.at(-1).url, "https://docs.example/49979");
});

test("getProjectResources upgrades selected duplicate URLs when stronger evidence appears later", () => {
  const timestamp = "2026-01-10T00:00:00.000Z";
  const resourceState = {
    projects: [{ id: "p1", description: "https://shared.example/", nextAction: "", updatedAt: timestamp }],
    crumbs: [{ id: "crumb", projectId: "p1", text: "https://shared.example/ https://crumb.example/", createdAt: timestamp }],
    checkpoints: [{
      id: "checkpoint",
      projectId: "p1",
      summary: "https://shared.example/ https://checkpoint.example/",
      nextAction: "",
      openLoops: "",
      returnHint: "",
      createdAt: timestamp
    }]
  };

  const resources = getProjectResources(resourceState, "p1", 2);

  assert.deepEqual(resources.map((item) => item.url), ["https://shared.example/", "https://checkpoint.example/"]);
  assert.equal(resources[0].sourceId, "checkpoint");
});
