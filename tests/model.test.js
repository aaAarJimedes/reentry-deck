import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  CRUMB_TYPES,
  CHECKPOINT_CAPTURE_MODES,
  PROJECT_STATUSES,
  IMPORT_LIMITS,
  SCHEMA_VERSION,
  SESSION_CLOSE_REASONS,
  SESSION_STATUSES,
  compactText,
  createCheckpoint,
  createCrumb,
  createEmptyState,
  createProject,
  createSession,
  isoAtOrAfter,
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

  test("isoAtOrAfter preserves the latest valid business anchor during clock rollback", () => {
    const earlier = "2026-08-27T23:00:00.000Z";
    const later = "2026-08-28T05:00:00.000Z";

    assert.equal(isoAtOrAfter(earlier, NOW_ISO, "invalid", later), later);
    assert.equal(isoAtOrAfter(NOW), NOW_ISO);
    assert.throws(() => isoAtOrAfter("not-a-date"), /无法生成有效时间/);
  });

  test("compactText trims short text and marks bounded projections without overrunning", () => {
    assert.equal(compactText("  short  ", 10), "short");
    assert.equal(compactText("abcdef", 4), "abc…");
    assert.equal(compactText("ab  cd", 4), "ab…");
    assert.equal(compactText("abcdef", 1), "…");
    assert.equal(compactText("abcdef", 0), "");
    assert.equal(compactText(null, 10), "");
    assert.equal(compactText("😀😀😀", 5), "😀😀…");
    assert.doesNotMatch(compactText("😀😀😀", 4), /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/u);
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
      descriptionUpdatedAt: "2020-01-02T00:00:00.000Z",
      nextAction: "",
      nextActionUpdatedAt: null,
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
      resolvedAt: null,
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

  test("rejects an oversized live workspace before traversing its records", () => {
    const state = createEmptyState(NOW);
    state.crumbs = new Array(IMPORT_LIMITS.records + 1);

    assert.deepEqual(validateState(state), [
      `工作区包含 ${IMPORT_LIMITS.records + 1} 条记录，超过 ${IMPORT_LIMITS.records} 条安全上限`
    ]);
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
      "归档项目不能包含活动会话：s1",
      "活动会话不能包含结束检查点：s1"
    ]);
  });

  test("rejects invalid resolution metadata without losing legitimate resolved signals", () => {
    const state = createEmptyState(NOW);
    state.projects.push(createProject({ id: "p1" }, NOW));
    state.crumbs.push(
      createCrumb({ id: "resolved", projectId: "p1", type: "question", text: "done", resolvedAt: NOW_ISO }, NOW),
      createCrumb({ id: "wrong-type", projectId: "p1", type: "note", text: "note", resolvedAt: NOW_ISO }, NOW),
      createCrumb({ id: "bad-date", projectId: "p1", type: "blocker", text: "blocked", resolvedAt: "not-a-date" }, NOW)
    );

    assert.deepEqual(validateImportCandidate(state), [
      "只有问题或阻塞可以标记为已解决：wrong-type",
      "面包屑解决时间无效：bad-date"
    ]);
  });

  test("rejects lossy fields, excessive text, invalid dates, and unsafe workspace metadata", () => {
    const state = createEmptyState(NOW);
    const project = createProject({ id: "p1" }, NOW);
    project.title = 42;
    project.description = "x".repeat(IMPORT_LIMITS.projectDescription + 1);
    project.updatedAt = "not-a-date";
    state.projects.push(project);
    const invalidPinned = createCrumb({ id: "bad-pin", projectId: "p1" }, NOW);
    invalidPinned.pinned = "false";
    state.crumbs.push(invalidPinned);
    state.sessions.push(createSession({
      id: "s1",
      projectId: "p1",
      startedAt: "2026-08-28T03:00:00.000Z",
      endedAt: "2026-08-28T02:00:00.000Z",
      status: "completed"
    }, NOW));
    state.settings.theme = "neon";
    state.settings.staleAfterDays = 0;
    state.settings.reducedMotion = "no";
    state.meta.revision = -1;
    state.ui.selectedProjectId = "missing";

    const errors = validateImportCandidate(state);

    assert.match(errors.join("；"), /项目名称必须是文本/);
    assert.match(errors.join("；"), /项目说明超过 800 字符上限/);
    assert.match(errors.join("；"), /项目时间无效：p1.updatedAt/);
    assert.match(errors.join("；"), /会话结束时间早于开始时间：s1/);
    assert.match(errors.join("；"), /界面主题无效：neon/);
    assert.match(errors.join("；"), /陈旧阈值必须在 1 到 365 天之间/);
    assert.match(errors.join("；"), /减少动态效果设置无效/);
    assert.match(errors.join("；"), /修订号无效/);
    assert.match(errors.join("；"), /当前选中项目引用不存在/);
    assert.match(errors.join("；"), /面包屑置顶状态无效：bad-pin/);
  });

  test("rejects invisible controls in persisted text and identifiers while preserving ordinary layout whitespace", () => {
    const state = createEmptyState(NOW);
    const project = createProject({ id: "project\u202Ehidden", title: "Safe 👩‍💻 title", description: "line one\nline two\tindented" }, NOW);
    project.nextAction = "open\u200Bfile";
    state.projects.push(project);
    state.crumbs.push(createCrumb({ id: "crumb", projectId: project.id, text: "spoof\u2066value" }, NOW));

    const errors = validateImportCandidate(state).join("；");
    assert.match(errors, /项目 ID 过长或包含控制字符/u);
    assert.match(errors, /项目下一步包含不可见控制字符/u);
    assert.match(errors, /面包屑内容包含不可见控制字符/u);
    assert.doesNotMatch(errors, /项目说明包含不可见控制字符/u);
    assert.doesNotMatch(errors, /项目名称包含不可见控制字符/u);
  });

  test("accepts only canonical millisecond UTC timestamps", () => {
    const state = createEmptyState(NOW);
    state.projects.push(createProject({ id: "p1" }, NOW));
    assert.deepEqual(validateImportCandidate(state), []);

    for (const ambiguous of [
      "2026-08-28T08:00:00Z",
      "2026-08-28T16:00:00.000+08:00",
      "08/28/2026 08:00:00",
      "Fri, 28 Aug 2026 08:00:00 GMT"
    ]) {
      const changed = structuredClone(state);
      changed.meta.updatedAt = ambiguous;
      assert.match(validateImportCandidate(changed).join("；"), /元数据时间无效：工作区.updatedAt/, ambiguous);
    }
  });

  test("rejects evidence and checkpoints outside their logical session intervals", () => {
    const start = "2026-08-28T02:00:00.000Z";
    const end = "2026-08-28T03:00:00.000Z";
    const state = createEmptyState(NOW);
    state.projects.push(createProject({ id: "p1" }, NOW));
    state.checkpoints.push(
      createCheckpoint({ id: "source-future", projectId: "p1", createdAt: "2026-08-28T04:00:00.000Z" }, NOW),
      createCheckpoint({ id: "ending-early", projectId: "p1", sessionId: "s1", createdAt: "2026-08-28T01:00:00.000Z" }, NOW),
      createCheckpoint({ id: "active-ending", projectId: "p1", sessionId: "s2", createdAt: start }, NOW)
    );
    state.sessions.push(
      createSession({ id: "s1", projectId: "p1", status: "completed", startedAt: start, endedAt: end, sourceCheckpointId: "source-future", checkpointId: "ending-early" }, NOW),
      createSession({ id: "s2", projectId: "p1", status: "active", startedAt: start, checkpointId: "active-ending" }, NOW)
    );
    state.crumbs.push(
      createCrumb({ id: "too-early", projectId: "p1", sessionId: "s1", createdAt: "2026-08-28T01:30:00.000Z" }, NOW),
      createCrumb({ id: "too-late", projectId: "p1", sessionId: "s1", createdAt: "2026-08-28T03:30:00.000Z" }, NOW),
      createCrumb({ id: "resolved-backward", projectId: "p1", type: "question", createdAt: end, resolvedAt: start }, NOW)
    );

    const errors = validateImportCandidate(state).join("；");

    assert.match(errors, /会话开始时间早于来源检查点：s1/);
    assert.match(errors, /会话结束检查点早于会话开始：s1/);
    assert.match(errors, /活动会话不能包含结束检查点：s2/);
    assert.match(errors, /面包屑早于所属会话开始：too-early/);
    assert.match(errors, /面包屑晚于所属会话结束：too-late/);
    assert.match(errors, /面包屑解决时间早于记录时间：resolved-backward/);
    assert.match(errors, /检查点早于所属会话开始：ending-early/);
  });

  test("rejects workspace, project, and record dates outside their causal windows", () => {
    const createdAt = "2026-08-28T02:00:00.000Z";
    const updatedAt = "2026-08-28T04:00:00.000Z";
    const state = createEmptyState(NOW);
    state.meta.createdAt = updatedAt;
    state.meta.updatedAt = createdAt;
    const project = createProject({ id: "p1", createdAt, updatedAt, lastOpenedAt: "2026-08-28T05:00:00.000Z" }, NOW);
    project.descriptionUpdatedAt = "2026-08-28T01:00:00.000Z";
    state.projects.push(project);
    state.sessions.push(createSession({ id: "s1", projectId: "p1", status: "completed", startedAt: createdAt, endedAt: "2026-08-28T05:00:00.000Z" }, NOW));
    state.crumbs.push(createCrumb({ id: "c1", projectId: "p1", createdAt: "2026-08-28T01:00:00.000Z" }, NOW));
    state.checkpoints.push(createCheckpoint({ id: "cp1", projectId: "p1", createdAt: "2026-08-28T05:00:00.000Z" }, NOW));

    const errors = validateImportCandidate(state).join("；");

    assert.match(errors, /工作区更新时间早于创建时间/);
    assert.match(errors, /项目时间晚于更新时间：p1.lastOpenedAt/);
    assert.match(errors, /项目时间早于创建时间：p1.descriptionUpdatedAt/);
    assert.match(errors, /会话时间超出项目生命周期：s1.endedAt/);
    assert.match(errors, /面包屑时间超出项目生命周期：c1.createdAt/);
    assert.match(errors, /检查点时间超出项目生命周期：cp1.createdAt/);
  });

  test("rejects pathological record counts before traversing individual records", () => {
    const state = createEmptyState(NOW);
    state.crumbs = new Array(IMPORT_LIMITS.records + 1).fill({ id: "duplicate" });

    assert.deepEqual(validateImportCandidate(state), [
      `备份包含 ${IMPORT_LIMITS.records + 1} 条记录，超过 ${IMPORT_LIMITS.records} 条安全上限`
    ]);
  });

  test("caps detailed validation errors", () => {
    const state = createEmptyState(NOW);
    state.projects.push(...Array.from({ length: IMPORT_LIMITS.reportedErrors + 10 }, (_, index) => createProject({
      id: `p${index}`,
      title: "x".repeat(IMPORT_LIMITS.projectTitle + 1)
    }, NOW)));

    const errors = validateImportCandidate(state);

    assert.equal(errors.length, IMPORT_LIMITS.reportedErrors + 1);
    assert.equal(errors.at(-1), "备份还包含更多问题，已停止展开错误列表");
  });

  test("rejects cross-project session, crumb, and checkpoint links", () => {
    const state = createEmptyState(NOW);
    const first = createProject({ id: "p1" }, NOW);
    const second = createProject({ id: "p2" }, NOW);
    second.color = "invalid-color";
    const firstSession = createSession({ id: "s1", projectId: "p1", status: "completed", endedAt: NOW_ISO, checkpointId: "cp2", sourceCheckpointId: "cp2" }, NOW);
    const secondSession = createSession({ id: "s2", projectId: "p2", status: "completed", endedAt: NOW_ISO }, NOW);
    const secondCheckpoint = createCheckpoint({ id: "cp2", projectId: "p2", sessionId: "s2" }, NOW);
    state.projects.push(first, second);
    state.sessions.push(firstSession, secondSession);
    state.checkpoints.push(secondCheckpoint, createCheckpoint({ id: "cp-wrong", projectId: "p1", sessionId: "s2" }, NOW));
    state.crumbs.push(createCrumb({ id: "c-wrong", projectId: "p1", sessionId: "s2" }, NOW));

    const errors = validateImportCandidate(state);

    assert.match(errors.join("；"), /项目颜色无效：invalid-color/);
    assert.match(errors.join("；"), /会话结束检查点属于其他项目：s1/);
    assert.match(errors.join("；"), /会话结束检查点属于其他会话：s1/);
    assert.match(errors.join("；"), /会话来源检查点属于其他项目：s1/);
    assert.match(errors.join("；"), /面包屑会话属于其他项目：c-wrong/);
    assert.match(errors.join("；"), /检查点会话属于其他项目：cp-wrong/);
  });
});
