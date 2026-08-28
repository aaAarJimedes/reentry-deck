import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  QUICK_CAPTURE_PROJECT_LIMIT,
  buildQuickCaptureProjectWindow,
  prepareQuickCapture,
  projectNextActionFromCrumb
} from "../src/core/capture.js";
import { IMPORT_LIMITS, createEmptyState, createProject, createSession } from "../src/core/model.js";

const NOW = Date.parse("2026-08-28T04:00:00.000Z");

describe("prepareQuickCapture", () => {
  test("links to the target project's active session and preserves pin intent", () => {
    const state = createEmptyState(NOW);
    state.projects.push(createProject({ id: "p1", title: "Target" }, NOW), createProject({ id: "p2" }, NOW));
    state.sessions.push(createSession({ id: "other", projectId: "p2" }, NOW), createSession({ id: "target", projectId: "p1" }, NOW));

    const result = prepareQuickCapture(state, { projectId: "p1", type: "decision", text: "  Keep this  ", pinned: "on" }, NOW);

    assert.equal(result.projectTitle, "Target");
    assert.equal(result.linkedToActiveSession, true);
    assert.equal(result.crumb.projectId, "p1");
    assert.equal(result.crumb.sessionId, "target");
    assert.equal(result.crumb.type, "decision");
    assert.equal(result.crumb.text, "Keep this");
    assert.equal(result.crumb.pinned, true);
    assert.equal(result.crumb.createdAt, new Date(NOW).toISOString());
    assert.equal(state.crumbs.length, 0, "preparation must not mutate the workspace");
  });

  test("creates project-level evidence when the selected project has no active session", () => {
    const state = createEmptyState(NOW);
    state.projects.push(createProject({ id: "p1", title: "Target" }, NOW));

    const result = prepareQuickCapture(state, { projectId: "p1", type: "note", text: "note", pinned: false }, NOW);

    assert.equal(result.linkedToActiveSession, false);
    assert.equal(result.crumb.sessionId, null);
    assert.equal(result.crumb.pinned, false);
  });

  test("clamps evidence time to project and session anchors when the system clock moves backward", () => {
    const state = createEmptyState(NOW);
    const anchor = "2026-08-28T06:00:00.000Z";
    state.projects.push(createProject({ id: "p1", title: "Future anchor", updatedAt: anchor }, NOW));
    state.sessions.push(createSession({ id: "s1", projectId: "p1", startedAt: anchor }, NOW));

    const result = prepareQuickCapture(state, { projectId: "p1", type: "note", text: "kept in order" }, NOW);

    assert.equal(result.crumb.createdAt, anchor);
  });

  test("rejects archived or missing projects, invalid types, and blank evidence", () => {
    const state = createEmptyState(NOW);
    state.projects.push(createProject({ id: "archived", status: "archived" }, NOW), createProject({ id: "active" }, NOW));

    assert.throws(() => prepareQuickCapture(state, { projectId: "missing", type: "note", text: "x" }, NOW), /目标项目不可用/);
    assert.throws(() => prepareQuickCapture(state, { projectId: "archived", type: "note", text: "x" }, NOW), /目标项目不可用/);
    assert.throws(() => prepareQuickCapture(state, { projectId: "active", type: "mystery", text: "x" }, NOW), /记录类型不可用/);
    assert.throws(() => prepareQuickCapture(state, { projectId: "active", type: "note", text: "   " }, NOW), /先写下一条记录/);
  });
});

test("projectNextActionFromCrumb preserves full evidence while bounding the project projection", () => {
  const fullText = "动".repeat(IMPORT_LIMITS.nextAction + 5);
  const crumb = { type: "next", text: fullText };
  const projection = projectNextActionFromCrumb(crumb);

  assert.equal(crumb.text, fullText);
  assert.equal(projection.length, IMPORT_LIMITS.nextAction);
  assert.ok(projection.endsWith("…"));
  assert.equal(projectNextActionFromCrumb({ type: "note", text: fullText }), null);
});

describe("buildQuickCaptureProjectWindow", () => {
  test("prioritizes context, excludes archives, and otherwise orders by recent activity", () => {
    const state = createEmptyState(NOW);
    state.projects.push(
      createProject({ id: "older", title: "Older", lastOpenedAt: "2026-08-20T00:00:00.000Z" }, NOW),
      createProject({ id: "preferred", title: "Preferred", lastOpenedAt: "2026-08-19T00:00:00.000Z" }, NOW),
      createProject({ id: "newer", title: "Newer", lastOpenedAt: "2026-08-28T00:00:00.000Z" }, NOW),
      createProject({ id: "archived", title: "Archived", status: "archived", lastOpenedAt: "2026-08-29T00:00:00.000Z" }, NOW)
    );

    const window = buildQuickCaptureProjectWindow(state, { preferredIds: ["preferred"] });

    assert.deepEqual(window.items.map((project) => project.id), ["preferred", "newer", "older"]);
    assert.equal(window.total, 3);
    assert.equal(window.matched, 3);
  });

  test("ranks exact, prefix, title, and contextual matches while keeping the result bounded", () => {
    const state = createEmptyState(NOW);
    state.projects.push(
      createProject({ id: "context", title: "Other", description: "Launch alpha" }, NOW),
      createProject({ id: "contains", title: "My Alpha Work" }, NOW),
      createProject({ id: "prefix", title: "Alpha Notes" }, NOW),
      createProject({ id: "exact", title: "Alpha" }, NOW)
    );

    const window = buildQuickCaptureProjectWindow(state, { query: " ＡＬＰＨＡ ", preferredIds: ["context"], limit: 4 });

    assert.deepEqual(window.items.map((project) => project.id), ["exact", "prefix", "contains", "context"]);
    assert.equal(window.matched, 4);
    assert.equal(window.items.length, 4);
    assert.equal(window.query, "alpha");
  });

  test("finds a late project at the record boundary without source array helpers", () => {
    const projects = Array.from({ length: 50_000 }, (_, index) => ({
      id: `project-${String(index).padStart(5, "0")}`,
      title: index === 49_999 ? "Needle project" : `Ordinary ${index}`,
      description: "",
      nextAction: "",
      status: "active",
      updatedAt: new Date(NOW - index).toISOString(),
      lastOpenedAt: new Date(NOW - index).toISOString()
    }));
    for (const method of ["filter", "map", "sort", "some", "find"]) {
      Object.defineProperty(projects, method, {
        value: () => { throw new Error(`source array ${method} must not be used`); },
        configurable: true
      });
    }

    const window = buildQuickCaptureProjectWindow({ projects }, { query: "needle", limit: 50_000 });

    assert.equal(window.total, 50_000);
    assert.equal(window.matched, 1);
    assert.equal(window.items[0].id, "project-49999");
    assert.ok(window.items.length <= QUICK_CAPTURE_PROJECT_LIMIT);
  });
});
