import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  CRUMB_TYPES,
  CHECKPOINT_CAPTURE_MODES,
  PROJECT_STATUSES,
  SCHEMA_VERSION,
  SESSION_CLOSE_REASONS,
  SESSION_STATUSES,
  createCheckpoint,
  createCrumb,
  createEmptyState,
  createProject,
  createSession,
  isoNow,
  makeId,
  normalizeState,
  validateImportCandidate,
  validateState
} from "../src/core/model.js";

const NOW = Date.parse("2026-08-28T01:02:03.456Z");
const NOW_ISO = "2026-08-28T01:02:03.456Z";

describe("model constants and helpers", () => {
  test("published enum lists are frozen and contain the supported values", () => {
    assert.deepEqual(PROJECT_STATUSES, ["active", "paused", "blocked", "archived"]);
    assert.deepEqual(CRUMB_TYPES, ["note", "discovery", "decision", "question", "blocker", "next"]);
    assert.deepEqual(SESSION_STATUSES, ["active", "completed", "abandoned"]);
    assert.deepEqual(SESSION_CLOSE_REASONS, ["checkpoint", "quick-dock", "interrupted"]);
    assert.deepEqual(CHECKPOINT_CAPTURE_MODES, ["manual", "quick"]);
    assert.equal(Object.isFrozen(PROJECT_STATUSES), true);
    assert.equal(Object.isFrozen(CRUMB_TYPES), true);
    assert.equal(Object.isFrozen(SESSION_STATUSES), true);
    assert.equal(Object.isFrozen(SESSION_CLOSE_REASONS), true);
    assert.equal(Object.isFrozen(CHECKPOINT_CAPTURE_MODES), true);
  });

  test("isoNow accepts a timestamp and makeId applies its prefix", () => {
    assert.equal(isoNow(NOW), NOW_ISO);

    const first = makeId("project");
    const second = makeId("project");
    assert.match(first, /^project_.+/);
    assert.match(second, /^project_.+/);
    assert.notEqual(first, second);
  });
});

describe("model factories", () => {
  test("createEmptyState returns a fresh, fully initialized schema", () => {
    const first = createEmptyState(NOW);
    const second = createEmptyState(NOW);

    assert.deepEqual(first, {
      schemaVersion: SCHEMA_VERSION,
      meta: { createdAt: NOW_ISO, updatedAt: NOW_ISO, revision: 0 },
      settings: { theme: "system", staleAfterDays: 7, reducedMotion: false },
      projects: [],
      sessions: [],
      crumbs: [],
      checkpoints: [],
      ui: { selectedProjectId: null }
    });
    assert.notStrictEqual(first, second);
    assert.notStrictEqual(first.meta, second.meta);
    assert.notStrictEqual(first.projects, second.projects);
  });

  test("createProject trims text, applies safe enum defaults, and preserves supplied timestamps", () => {
    const project = createProject(
      {
        id: "p1",
        title: "  Alpha  ",
        description: "  Description\n",
        nextAction: 42,
        color: "not-a-color",
        status: "unknown",
        createdAt: "2020-01-01T00:00:00.000Z",
        updatedAt: "2020-01-02T00:00:00.000Z",
        lastOpenedAt: "2020-01-03T00:00:00.000Z",
        archivedAt: "2020-01-04T00:00:00.000Z"
      },
      NOW
    );

    assert.deepEqual(project, {
      id: "p1",
      title: "Alpha",
      description: "Description",
      nextAction: "",
      color: "fern",
      status: "active",
      createdAt: "2020-01-01T00:00:00.000Z",
      updatedAt: "2020-01-02T00:00:00.000Z",
      lastOpenedAt: "2020-01-03T00:00:00.000Z",
      archivedAt: "2020-01-04T00:00:00.000Z"
    });
  });

  test("createProject supplies a title, palette color, ids, and dates when omitted", () => {
    const project = createProject({ title: "   ", color: "plum", status: "blocked" }, NOW);

    assert.match(project.id, /^project_.+/);
    assert.equal(project.title, "未命名项目");
    assert.equal(project.color, "plum");
    assert.equal(project.status, "blocked");
    assert.equal(project.createdAt, NOW_ISO);
    assert.equal(project.updatedAt, NOW_ISO);
    assert.equal(project.lastOpenedAt, NOW_ISO);
    assert.equal(project.archivedAt, null);
  });

  test("session, crumb, and checkpoint factories normalize their own fields", () => {
    const session = createSession(
      { id: "s1", projectId: "p1", intention: "  focus  ", status: "bad", checkpointId: undefined },
      NOW
    );
    const crumb = createCrumb(
      { id: "c1", projectId: "p1", sessionId: undefined, type: "bad", text: "  note  ", pinned: 1 },
      NOW
    );
    const checkpoint = createCheckpoint(
      {
        id: "cp1",
        projectId: "p1",
        summary: "  summary ",
        nextAction: " next  ",
        openLoops: null,
        returnHint: " hint "
      },
      NOW
    );

    assert.deepEqual(session, {
      id: "s1",
      projectId: "p1",
      intention: "focus",
      status: "active",
      startedAt: NOW_ISO,
      endedAt: null,
      checkpointId: null,
      sourceCheckpointId: null,
      closeReason: null
    });
    assert.deepEqual(crumb, {
      id: "c1",
      projectId: "p1",
      sessionId: null,
      type: "note",
      text: "note",
      pinned: true,
      createdAt: NOW_ISO
    });
    assert.deepEqual(checkpoint, {
      id: "cp1",
      projectId: "p1",
      sessionId: null,
      summary: "summary",
      nextAction: "next",
      openLoops: "",
      returnHint: "hint",
      captureMode: "manual",
      createdAt: NOW_ISO
    });
  });
});

describe("normalizeState", () => {
  test("rejects non-object roots and data from a future schema", () => {
    for (const value of [null, undefined, false, 0, "json", []]) {
      assert.throws(() => normalizeState(value, NOW), {
        name: "TypeError",
        message: /不是有效的数据对象/
      });
    }

    assert.throws(() => normalizeState({ schemaVersion: SCHEMA_VERSION + 1 }, NOW), {
      name: "RangeError",
      message: /来自更新版本/
    });
    assert.throws(() => normalizeState({ schemaVersion: String(SCHEMA_VERSION + 1) }, NOW), RangeError);
  });

  test("fills all defaults for a minimal legacy object without sharing arrays", () => {
    const normalized = normalizeState({}, NOW);
    const empty = createEmptyState(NOW);

    assert.deepEqual(normalized, empty);
    assert.notStrictEqual(normalized.projects, empty.projects);
    assert.notStrictEqual(normalized.settings, empty.settings);
  });

  test("normalizes records, preserves supported values, and merges metadata/settings", () => {
    const normalized = normalizeState(
      {
        schemaVersion: 0,
        meta: {
          createdAt: "2025-01-01T00:00:00.000Z",
          updatedAt: "2025-02-01T00:00:00.000Z",
          revision: 12
        },
        settings: { theme: "dark", staleAfterDays: 30, reducedMotion: true },
        projects: [
          {
            id: "p1",
            title: " Project ",
            description: " Context ",
            nextAction: " Next ",
            color: "amber",
            status: "paused"
          }
        ],
        sessions: [
          { id: "s1", projectId: "p1", intention: " Intent ", status: "completed" }
        ],
        crumbs: [
          { id: "c1", projectId: "p1", sessionId: "s1", type: "decision", text: " Choice " }
        ],
        checkpoints: [
          { id: "cp1", projectId: "p1", sessionId: "s1", summary: " State " }
        ],
        ui: { selectedProjectId: "p1" }
      },
      NOW
    );

    assert.equal(normalized.schemaVersion, SCHEMA_VERSION);
    assert.deepEqual(normalized.meta, {
      createdAt: "2025-01-01T00:00:00.000Z",
      updatedAt: "2025-02-01T00:00:00.000Z",
      revision: 12
    });
    assert.deepEqual(normalized.settings, { theme: "dark", staleAfterDays: 30, reducedMotion: true });
    assert.equal(normalized.projects[0].title, "Project");
    assert.equal(normalized.projects[0].status, "paused");
    assert.equal(normalized.sessions[0].intention, "Intent");
    assert.equal(normalized.sessions[0].status, "completed");
    assert.equal(normalized.crumbs[0].type, "decision");
    assert.equal(normalized.crumbs[0].sessionId, "s1");
    assert.equal(normalized.checkpoints[0].summary, "State");
    assert.equal(normalized.checkpoints[0].sessionId, "s1");
    assert.equal(normalized.ui.selectedProjectId, "p1");
  });

  test("drops orphaned records and clears dangling optional session references", () => {
    const normalized = normalizeState(
      {
        projects: [{ id: "kept", title: "Kept" }],
        sessions: [
          { id: "kept-session", projectId: "kept" },
          { id: "orphan-session", projectId: "missing" },
          { id: "no-project-session" }
        ],
        crumbs: [
          { id: "valid-crumb", projectId: "kept", sessionId: "kept-session", text: "valid" },
          { id: "dangling-session-crumb", projectId: "kept", sessionId: "missing-session", text: "kept" },
          { id: "orphan-crumb", projectId: "missing", text: "dropped" }
        ],
        checkpoints: [
          { id: "valid-checkpoint", projectId: "kept", sessionId: "kept-session" },
          { id: "dangling-session-checkpoint", projectId: "kept", sessionId: "missing-session" },
          { id: "orphan-checkpoint", projectId: "missing" }
        ],
        ui: { selectedProjectId: "missing" }
      },
      NOW
    );

    assert.deepEqual(normalized.sessions.map(({ id }) => id), ["kept-session"]);
    assert.deepEqual(normalized.crumbs.map(({ id }) => id), ["valid-crumb", "dangling-session-crumb"]);
    assert.deepEqual(normalized.checkpoints.map(({ id }) => id), [
      "valid-checkpoint",
      "dangling-session-checkpoint"
    ]);
    assert.equal(normalized.crumbs[0].sessionId, "kept-session");
    assert.equal(normalized.crumbs[1].sessionId, null);
    assert.equal(normalized.checkpoints[0].sessionId, "kept-session");
    assert.equal(normalized.checkpoints[1].sessionId, null);
    assert.equal(normalized.ui.selectedProjectId, null);
  });

  test("coerces absent collections to arrays and unsafe revisions to zero", () => {
    for (const revision of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, "3", null]) {
      const normalized = normalizeState(
        {
          meta: { revision },
          projects: {},
          sessions: "sessions",
          crumbs: null,
          checkpoints: 42
        },
        NOW
      );
      assert.equal(normalized.meta.revision, 0);
      assert.deepEqual(normalized.projects, []);
      assert.deepEqual(normalized.sessions, []);
      assert.deepEqual(normalized.crumbs, []);
      assert.deepEqual(normalized.checkpoints, []);
    }
  });
});

describe("validateState", () => {
  test("accepts an empty valid state and factory-produced linked records", () => {
    const state = createEmptyState(NOW);
    state.projects.push(createProject({ id: "p1" }, NOW));
    state.sessions.push(createSession({ id: "s1", projectId: "p1" }, NOW));
    state.crumbs.push(createCrumb({ id: "c1", projectId: "p1", sessionId: "s1" }, NOW));
    state.checkpoints.push(createCheckpoint({ id: "cp1", projectId: "p1", sessionId: "s1" }, NOW));

    assert.deepEqual(validateState(state), []);
  });

  test("reports invalid roots and every missing collection", () => {
    assert.deepEqual(validateState(null), [
      "根数据缺失",
      "项目列表无效",
      "会话列表无效",
      "面包屑列表无效",
      "检查点列表无效"
    ]);
    assert.deepEqual(validateState({ projects: [], sessions: {}, crumbs: [], checkpoints: undefined }), [
      "会话列表无效",
      "检查点列表无效"
    ]);
  });

  test("reports missing ids and duplicate ids within or across collections", () => {
    const state = createEmptyState(NOW);
    state.projects = [{ id: "same" }, {}, { id: "same" }];
    state.sessions = [{ id: "same" }];
    state.crumbs = [{ id: "" }];

    assert.deepEqual(validateState(state), [
      "存在缺少 ID 的记录",
      "记录 ID 重复：same",
      "记录 ID 重复：same",
      "存在缺少 ID 的记录"
    ]);
  });

  test("rejects multiple simultaneous active sessions", () => {
    const state = createEmptyState(NOW);
    state.projects.push(createProject({ id: "p1" }, NOW));
    state.sessions.push(
      createSession({ id: "s1", projectId: "p1" }, NOW),
      createSession({ id: "s2", projectId: "p1" }, NOW)
    );

    assert.deepEqual(validateState(state), ["同一时间只能有一个活动会话"]);
  });
});

describe("validateImportCandidate", () => {
  test("rejects lossy collection coercion and orphaned records before normalization", () => {
    const malformed = createEmptyState(NOW);
    malformed.sessions = {};
    assert.match(validateImportCandidate(malformed).join("；"), /会话列表无效/);

    const orphaned = createEmptyState(NOW);
    orphaned.sessions.push(createSession({ id: "s1", projectId: "missing" }, NOW));
    assert.deepEqual(validateImportCandidate(orphaned), ["会话引用了不存在的项目：s1"]);
  });

  test("rejects dangling session references and unsupported enum values", () => {
    const state = createEmptyState(NOW);
    state.projects.push(createProject({ id: "p1" }, NOW));
    state.crumbs.push({ id: "c1", projectId: "p1", sessionId: "missing", type: "mystery" });

    assert.deepEqual(validateImportCandidate(state), [
      "面包屑引用了不存在的会话：c1",
      "面包屑类型无效：mystery"
    ]);
  });

  test("rejects broken session lifecycle and checkpoint references", () => {
    const state = createEmptyState(NOW);
    state.projects.push(createProject({ id: "p1", status: "archived" }, NOW));
    const brokenSession = createSession({
      id: "s1",
      projectId: "p1",
      endedAt: NOW_ISO,
      checkpointId: "missing-close",
      sourceCheckpointId: "missing-source"
    }, NOW);
    brokenSession.closeReason = "not-a-reason";
    state.sessions.push(brokenSession);

    assert.deepEqual(validateImportCandidate(state), [
      "会话关闭原因无效：not-a-reason",
      "会话引用了不存在的检查点：s1",
      "会话来源检查点不存在：s1",
      "活动会话不能包含结束时间：s1",
      "归档项目不能包含活动会话：s1"
    ]);
  });
});
