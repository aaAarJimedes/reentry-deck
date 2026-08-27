import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { prepareQuickCapture } from "../src/core/capture.js";
import { createEmptyState, createProject, createSession } from "../src/core/model.js";

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

  test("rejects archived or missing projects, invalid types, and blank evidence", () => {
    const state = createEmptyState(NOW);
    state.projects.push(createProject({ id: "archived", status: "archived" }, NOW), createProject({ id: "active" }, NOW));

    assert.throws(() => prepareQuickCapture(state, { projectId: "missing", type: "note", text: "x" }, NOW), /目标项目不可用/);
    assert.throws(() => prepareQuickCapture(state, { projectId: "archived", type: "note", text: "x" }, NOW), /目标项目不可用/);
    assert.throws(() => prepareQuickCapture(state, { projectId: "active", type: "mystery", text: "x" }, NOW), /记录类型不可用/);
    assert.throws(() => prepareQuickCapture(state, { projectId: "active", type: "note", text: "   " }, NOW), /先写下一条记录/);
  });
});
