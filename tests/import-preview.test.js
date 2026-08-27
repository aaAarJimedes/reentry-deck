import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { buildImportPreview, readImportSnapshot } from "../src/core/import-preview.js";
import { createCheckpoint, createCrumb, createEmptyState, createProject, createSession } from "../src/core/model.js";

const T0 = Date.parse("2026-08-20T08:00:00.000Z");
const T1 = Date.parse("2026-08-28T08:00:00.000Z");

function workspace(projects = []) {
  const state = createEmptyState(T0);
  state.projects.push(...projects);
  return state;
}

describe("import snapshot inspection", () => {
  test("reads envelope metadata while returning a detached normalized state", () => {
    const raw = workspace([createProject({ id: "p1", title: "  Alpha  " }, T0)]);
    raw.projects[0].title = "  Alpha  ";

    const result = readImportSnapshot({
      format: "reentry-deck-backup",
      appVersion: " 0.6.0 ",
      exportedAt: "2026-08-27T12:00:00.000Z",
      data: raw
    }, T1);

    assert.equal(result.state.projects[0].title, "Alpha");
    assert.notStrictEqual(result.state, raw);
    assert.deepEqual(result.source, {
      envelope: true,
      appVersion: "0.6.0",
      exportedAt: "2026-08-27T12:00:00.000Z"
    });
  });

  test("rejects malformed envelopes and invalid references before previewing", () => {
    assert.throws(() => readImportSnapshot({ format: "unknown", data: {} }, T1), /无法识别/);
    assert.throws(() => readImportSnapshot({ format: "reentry-deck-backup" }, T1), /缺少数据内容/);

    const orphan = workspace();
    orphan.sessions.push(createSession({ id: "s1", projectId: "missing" }, T0));
    assert.throws(() => buildImportPreview(orphan, workspace(), T1), /会话引用了不存在的项目/);
  });
});

describe("import difference preview", () => {
  test("counts additions, removals, same-id updates, and unchanged records", () => {
    const shared = createProject({ id: "shared", title: "Before", status: "active" }, T0);
    const removed = createProject({ id: "removed", title: "Only here" }, T0);
    const current = workspace([shared, removed]);
    current.crumbs.push(createCrumb({ id: "same-crumb", projectId: "shared", text: "same" }, T0));
    current.checkpoints.push(createCheckpoint({ id: "old-cp", projectId: "removed", summary: "old" }, T0));

    const changed = createProject({ ...shared, title: "After", status: "blocked" }, T0);
    const added = createProject({ id: "added", title: "New project" }, T1);
    const incoming = workspace([changed, added]);
    incoming.crumbs.push(createCrumb({ id: "same-crumb", projectId: "shared", text: "same" }, T0));
    incoming.sessions.push(createSession({ id: "new-session", projectId: "added", status: "completed" }, T1));

    const preview = buildImportPreview(incoming, current, T1);

    assert.deepEqual(preview.collections.projects, {
      current: 2, incoming: 2, added: 1, removed: 1, changed: 1, unchanged: 0, orderChanged: false
    });
    assert.deepEqual(preview.collections.crumbs, {
      current: 1, incoming: 1, added: 0, removed: 0, changed: 0, unchanged: 1, orderChanged: false
    });
    assert.equal(preview.collections.sessions.added, 1);
    assert.equal(preview.collections.checkpoints.removed, 1);
    assert.deepEqual(preview.projectChanges.added.map((item) => item.title), ["New project"]);
    assert.deepEqual(preview.projectChanges.removed.map((item) => item.title), ["Only here"]);
    assert.deepEqual(preview.projectChanges.changed[0], {
      id: "shared",
      beforeTitle: "Before",
      afterTitle: "After",
      beforeStatus: "active",
      afterStatus: "blocked"
    });
    assert.equal(preview.hasContentChanges, true);
  });

  test("reports active-session replacement and content-identical imports", () => {
    const project = createProject({ id: "p1", title: "Focus" }, T0);
    const current = workspace([project]);
    current.sessions.push(createSession({ id: "current", projectId: "p1", intention: "Current work" }, T0));
    const incoming = structuredClone(current);
    incoming.sessions[0] = createSession({ id: "incoming", projectId: "p1", intention: "Backup work" }, T1);

    const replacement = buildImportPreview(incoming, current, T1);
    assert.equal(replacement.currentActiveSession.projectTitle, "Focus");
    assert.equal(replacement.currentActiveSession.intention, "Current work");
    assert.equal(replacement.incomingActiveSession.intention, "Backup work");

    const identical = buildImportPreview(structuredClone(current), current, T1);
    assert.equal(identical.hasContentChanges, false);
    assert.equal(identical.collections.projects.unchanged, 1);
    assert.equal(identical.collections.sessions.unchanged, 1);
  });

  test("treats record ordering as a visible import difference", () => {
    const first = createProject({ id: "first", title: "First" }, T0);
    const second = createProject({ id: "second", title: "Second" }, T0);
    const current = workspace([first, second]);
    const incoming = workspace([structuredClone(second), structuredClone(first)]);

    const preview = buildImportPreview(incoming, current, T1);

    assert.equal(preview.collections.projects.orderChanged, true);
    assert.deepEqual(preview.orderChangedCollections, ["projects"]);
    assert.equal(preview.hasContentChanges, true);
  });

  test("limits project-name detail without losing total counts", () => {
    const incoming = workspace(Array.from({ length: 10 }, (_, index) => createProject({ id: `p${index}`, title: `Project ${index}` }, T0)));
    const preview = buildImportPreview(incoming, workspace(), T1);

    assert.equal(preview.projectChanges.addedTotal, 10);
    assert.equal(preview.projectChanges.added.length, 6);
    assert.equal(preview.projectChanges.detailLimit, 6);
  });
});
