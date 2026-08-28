import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_SESSION_STALE_AFTER_MS,
  QUICK_DOCK_NOT_RECORDED,
  QUICK_DOCK_RETURN_HINT,
  assertSingleActiveSession,
  deriveQuickDockCheckpointInput,
  inspectActiveSessionInvariant,
  inspectSession,
  isActiveSession,
  isSessionStale,
  locateActiveSessionContext,
  prepareQuickCheckpointReview,
  prepareQuickDock
} from "../src/core/session.js";

const HOUR = 60 * 60 * 1000;
const NOW = Date.parse("2026-06-15T12:00:00.000Z");

function iso(timestamp) {
  return new Date(timestamp).toISOString();
}

function activeSession(overrides = {}) {
  return {
    id: "session-current",
    projectId: "project-current",
    status: "active",
    startedAt: iso(NOW - HOUR),
    endedAt: null,
    ...overrides
  };
}

function stateWith(overrides = {}) {
  return {
    projects: [{ id: "project-current", nextAction: "项目已有下一步" }],
    sessions: [activeSession()],
    crumbs: [],
    checkpoints: [],
    ...overrides
  };
}

test("isActiveSession treats status as authoritative", () => {
  assert.equal(isActiveSession({ status: "active", endedAt: iso(NOW) }), true);
  assert.equal(isActiveSession({ status: "completed", endedAt: null }), false);
  assert.equal(isActiveSession(null), false);
});

test("inspectSession marks an active session stale only after the default 12-hour threshold", () => {
  const sameLocalDayNow = new Date(2026, 5, 15, 23).getTime();
  const atThreshold = activeSession({ startedAt: iso(sameLocalDayNow - DEFAULT_SESSION_STALE_AFTER_MS) });
  const overThreshold = activeSession({ startedAt: iso(sameLocalDayNow - DEFAULT_SESSION_STALE_AFTER_MS - 1) });

  assert.deepEqual(inspectSession(atThreshold, sameLocalDayNow), {
    active: true,
    stale: false,
    staleReasons: [],
    ageMs: DEFAULT_SESSION_STALE_AFTER_MS
  });
  assert.deepEqual(inspectSession(overThreshold, sameLocalDayNow), {
    active: true,
    stale: true,
    staleReasons: ["elapsed"],
    ageMs: DEFAULT_SESSION_STALE_AFTER_MS + 1
  });
});

test("inspectSession marks a session stale as soon as the local calendar day changes", () => {
  const beforeMidnight = new Date(2026, 5, 15, 23, 59, 50).getTime();
  const afterMidnight = new Date(2026, 5, 16, 0, 0, 10).getTime();
  const session = activeSession({ startedAt: iso(beforeMidnight) });

  assert.deepEqual(inspectSession(session, afterMidnight), {
    active: true,
    stale: true,
    staleReasons: ["calendar-day"],
    ageMs: afterMidnight - beforeMidnight
  });
});

test("inspectSession reports every stale reason and fails closed for an invalid start time", () => {
  const oldLocalDay = new Date(2026, 5, 14, 8).getTime();
  const newLocalDay = new Date(2026, 5, 15, 21).getTime();
  assert.deepEqual(inspectSession(activeSession({ startedAt: iso(oldLocalDay) }), newLocalDay).staleReasons, [
    "elapsed",
    "calendar-day"
  ]);

  assert.deepEqual(inspectSession(activeSession({ startedAt: "not-a-date" }), NOW), {
    active: true,
    stale: true,
    staleReasons: ["invalid-started-at"],
    ageMs: null
  });
  assert.equal(isSessionStale(activeSession({ startedAt: "" }), NOW), true);
});

test("inactive sessions are never classified as stale and custom thresholds are supported", () => {
  assert.deepEqual(inspectSession({ status: "completed", startedAt: "not-a-date" }, "not-a-date"), {
    active: false,
    stale: false,
    staleReasons: [],
    ageMs: null
  });
  assert.equal(isSessionStale(activeSession({ startedAt: iso(NOW - 101) }), NOW, { staleAfterMs: 100 }), true);
  assert.throws(
    () => inspectSession(activeSession(), NOW, { staleAfterMs: -1 }),
    /非负有限毫秒数/
  );
  assert.throws(() => inspectSession(activeSession(), "not-a-date"), /当前时间无效/);
});

test("inspectActiveSessionInvariant distinguishes none, one fresh, one stale, and conflicts without mutation", async (t) => {
  await t.test("no active session", () => {
    const result = inspectActiveSessionInvariant({ sessions: [{ id: "done", status: "completed" }] }, NOW);
    assert.deepEqual(result, {
      ok: true,
      activeSession: null,
      activeSessions: [],
      staleSessions: [],
      violations: []
    });
  });

  await t.test("one fresh session", () => {
    const session = activeSession();
    const result = inspectActiveSessionInvariant({ sessions: [session] }, NOW);
    assert.equal(result.ok, true);
    assert.equal(result.activeSession, session);
    assert.deepEqual(result.activeSessions, [session]);
    assert.deepEqual(result.staleSessions, []);
  });

  await t.test("one stale session", () => {
    const session = activeSession({ startedAt: iso(NOW - 13 * HOUR) });
    const result = inspectActiveSessionInvariant({ sessions: [session] }, NOW);
    assert.equal(result.ok, true);
    assert.equal(result.activeSession, session);
    assert.deepEqual(result.staleSessions, [session]);
  });

  await t.test("multiple active sessions", () => {
    const sessions = [
      activeSession({ id: "older", startedAt: iso(NOW - 13 * HOUR) }),
      { id: "done", status: "completed", startedAt: iso(NOW - HOUR) },
      activeSession({ id: "newer", startedAt: iso(NOW - HOUR) })
    ];
    const originalIds = sessions.map(({ id }) => id);
    const result = inspectActiveSessionInvariant({ sessions }, NOW);

    assert.equal(result.ok, false);
    assert.equal(result.activeSession, null, "a conflict must not silently choose a winner");
    assert.deepEqual(result.activeSessions.map(({ id }) => id), ["older", "newer"]);
    assert.deepEqual(result.staleSessions.map(({ id }) => id), ["older"]);
    assert.match(result.violations[0], /2 个活动会话/);
    assert.deepEqual(sessions.map(({ id }) => id), originalIds);
  });

  await t.test("invalid session collection", () => {
    const result = inspectActiveSessionInvariant({ sessions: null }, NOW);
    assert.equal(result.ok, false);
    assert.deepEqual(result.violations, ["会话列表无效。"]);
  });
});

test("assertSingleActiveSession returns zero or one session and rejects invariant violations", () => {
  assert.equal(assertSingleActiveSession({ sessions: [] }, NOW), null);
  const session = activeSession();
  assert.equal(assertSingleActiveSession({ sessions: [session] }, NOW), session);
  assert.throws(
    () => assertSingleActiveSession({ sessions: [session, activeSession({ id: "second" })] }, NOW),
    /系统只允许一个/
  );
  assert.throws(() => assertSingleActiveSession({}, NOW), /会话列表无效/);
});

test("locateActiveSessionContext streams stable session and project positions", () => {
  const sessions = [
    { id: "done", projectId: "other", status: "completed" },
    activeSession()
  ];
  const projects = [
    { id: "other", status: "active" },
    { id: "project-current", status: "active" }
  ];
  Object.defineProperty(sessions, "find", { value() { throw new Error("session find must not be used"); } });
  Object.defineProperty(projects, "find", { value() { throw new Error("project find must not be used"); } });

  const context = locateActiveSessionContext({ sessions, projects });

  assert.equal(context.session, sessions[1]);
  assert.equal(context.sessionIndex, 1);
  assert.equal(context.project, projects[1]);
  assert.equal(context.projectIndex, 1);
  assert.equal(locateActiveSessionContext({ sessions: [], projects }), null);
  assert.throws(
    () => locateActiveSessionContext({ sessions: [activeSession(), activeSession({ id: "second" })], projects }),
    /多个活动会话/u
  );
  assert.throws(() => locateActiveSessionContext({ sessions: [activeSession()], projects: [] }), /项目不存在/u);
  assert.throws(
    () => locateActiveSessionContext({ sessions: [activeSession()], projects: [{ id: "project-current", status: "archived" }] }),
    /项目已归档/u
  );
});

test("deriveQuickDockCheckpointInput uses only newest current-session evidence with documented precedence", () => {
  const crumbs = [
    { id: "old-note", projectId: "project-current", sessionId: "session-current", type: "note", text: "较早状态", createdAt: iso(NOW - 9000) },
    { id: "other-session", projectId: "project-current", sessionId: "session-old", type: "decision", text: "别的会话状态", createdAt: iso(NOW - 1000) },
    { id: "other-project", projectId: "other-project", sessionId: "session-current", type: "decision", text: "错误项目状态", createdAt: iso(NOW - 500) },
    { id: "decision", projectId: "project-current", sessionId: "session-current", type: "decision", text: "  已定位真实故障点  ", createdAt: iso(NOW - 8000) },
    { id: "newer-question", projectId: "project-current", sessionId: "session-current", type: "question", text: "  是否需要迁移旧数据？  ", createdAt: iso(NOW - 2000) },
    { id: "old-next", projectId: "project-current", sessionId: "session-current", type: "next", text: "旧的下一步", createdAt: iso(NOW - 7000) },
    { id: "new-next", projectId: "project-current", sessionId: "session-current", type: "next", text: "  先补失败用例  ", createdAt: iso(NOW - 3000) },
    { id: "older-blocker", projectId: "project-current", sessionId: "session-current", type: "blocker", text: "等待接口样本", createdAt: iso(NOW - 6000) },
    { id: "newest-note", projectId: "project-current", sessionId: "session-current", type: "note", text: "新状态证据", createdAt: iso(NOW - 4000) }
  ];
  const originalOrder = crumbs.map(({ id }) => id);
  const state = stateWith({ crumbs });

  assert.deepEqual(deriveQuickDockCheckpointInput(state, "session-current", NOW), {
    projectId: "project-current",
    sessionId: "session-current",
    summary: "新状态证据",
    nextAction: "先补失败用例",
    openLoops: "是否需要迁移旧数据？；等待接口样本",
    returnHint: QUICK_DOCK_RETURN_HINT,
    captureMode: "quick"
  });
  assert.deepEqual(crumbs.map(({ id }) => id), originalOrder, "derivation must not reorder stored evidence");
});

test("deriveQuickDockCheckpointInput falls back only to recorded project nextAction", () => {
  const state = stateWith({
    crumbs: [
      { projectId: "project-current", sessionId: "session-current", type: "question", text: "   ", createdAt: iso(NOW - 1) },
      { projectId: "project-current", sessionId: "session-current", type: "next", text: "", createdAt: iso(NOW) }
    ]
  });

  const checkpoint = deriveQuickDockCheckpointInput(state, undefined, NOW);
  assert.deepEqual(checkpoint, {
    projectId: "project-current",
    sessionId: "session-current",
    summary: QUICK_DOCK_NOT_RECORDED.summary,
    nextAction: "项目已有下一步",
    openLoops: QUICK_DOCK_NOT_RECORDED.openLoops,
    returnHint: QUICK_DOCK_RETURN_HINT,
    captureMode: "quick"
  });
  assert.equal("status" in checkpoint, false, "quick docking must not claim the session completed");
  assert.equal("endedAt" in checkpoint, false, "quick docking derives evidence, not lifecycle facts");
});

test("deriveQuickDockCheckpointInput uses explicit 未记录 text for every missing evidence field", () => {
  const state = stateWith({ projects: [{ id: "project-current", nextAction: "   " }] });
  const checkpoint = deriveQuickDockCheckpointInput(state, "session-current", NOW);

  assert.deepEqual(checkpoint, {
    projectId: "project-current",
    sessionId: "session-current",
    summary: QUICK_DOCK_NOT_RECORDED.summary,
    nextAction: QUICK_DOCK_NOT_RECORDED.nextAction,
    openLoops: QUICK_DOCK_NOT_RECORDED.openLoops,
    returnHint: QUICK_DOCK_RETURN_HINT,
    captureMode: "quick"
  });
  assert.match(checkpoint.summary, /未记录/);
  assert.match(checkpoint.nextAction, /未记录/);
  assert.match(checkpoint.openLoops, /未记录/);
});

test("deriveQuickDockCheckpointInput bounds projections and omits resolved loops", () => {
  const state = stateWith({
    crumbs: [
      { id: "summary", projectId: "project-current", sessionId: "session-current", type: "note", text: "摘".repeat(1_205), createdAt: iso(NOW - 5_000) },
      { id: "next", projectId: "project-current", sessionId: "session-current", type: "next", text: "动".repeat(605), createdAt: iso(NOW - 4_000) },
      { id: "loop-old", projectId: "project-current", sessionId: "session-current", type: "question", text: "问".repeat(500), createdAt: iso(NOW - 3_000) },
      { id: "loop-new", projectId: "project-current", sessionId: "session-current", type: "blocker", text: "阻".repeat(500), createdAt: iso(NOW - 2_000) },
      { id: "resolved", projectId: "project-current", sessionId: "session-current", type: "question", text: "已经解决", resolvedAt: iso(NOW - 500), createdAt: iso(NOW - 1_000) }
    ]
  });

  const checkpoint = deriveQuickDockCheckpointInput(state, "session-current", NOW);

  assert.equal(checkpoint.summary.length, 1_200);
  assert.equal(checkpoint.nextAction.length, 600);
  assert.equal(checkpoint.openLoops.length, 800);
  assert.ok(checkpoint.summary.endsWith("…"));
  assert.ok(checkpoint.nextAction.endsWith("…"));
  assert.ok(checkpoint.openLoops.endsWith("…"));
  assert.doesNotMatch(checkpoint.openLoops, /已经解决/);
});

test("quick docking bounds open-loop selection at the 50,000-record workspace edge", () => {
  const crumbs = Array.from({ length: 49_998 }, (_, index) => ({
    id: `loop-${index}`,
    projectId: "project-current",
    sessionId: "session-current",
    type: "question",
    text: "问",
    createdAt: iso(NOW - HOUR)
  }));
  const state = stateWith({ crumbs });
  const originalMap = Array.prototype.map;
  const originalFilter = Array.prototype.filter;
  const originalSort = Array.prototype.sort;
  let largestSortedLength = 0;
  Array.prototype.map = function () {
    throw new Error("quick docking must not map the full evidence history");
  };
  Array.prototype.filter = function () {
    throw new Error("quick docking must not filter the full evidence history");
  };
  Array.prototype.sort = function (...args) {
    largestSortedLength = Math.max(largestSortedLength, this.length);
    return originalSort.apply(this, args);
  };
  let checkpoint;
  try {
    checkpoint = deriveQuickDockCheckpointInput(state, "session-current", NOW);
  } finally {
    Array.prototype.map = originalMap;
    Array.prototype.filter = originalFilter;
    Array.prototype.sort = originalSort;
  }

  assert.equal(checkpoint.openLoops.length, 800);
  assert.ok(checkpoint.openLoops.endsWith("…"));
  assert.equal(largestSortedLength, 401);
});

test("prepareQuickCheckpointReview creates a detached reliable project checkpoint", () => {
  const state = stateWith({
    projects: [{ id: "project-current", title: "Focus", status: "active", updatedAt: iso(NOW - HOUR) }],
    sessions: [],
    checkpoints: [{
      id: "quick",
      projectId: "project-current",
      sessionId: "old-session",
      captureMode: "quick",
      summary: "rough state",
      nextAction: "rough next",
      openLoops: "rough loop",
      returnHint: QUICK_DOCK_RETURN_HINT,
      createdAt: iso(NOW - HOUR)
    }]
  });

  const result = prepareQuickCheckpointReview(state, {
    projectId: "project-current",
    sourceCheckpointId: "quick",
    summary: "  verified state  ",
    nextAction: "  open the failing test  ",
    openLoops: "  confirm fixture  ",
    returnHint: "  tests/session.test.js  "
  }, NOW);

  assert.equal(result.projectTitle, "Focus");
  assert.equal(result.sourceCheckpointId, "quick");
  assert.deepEqual(result.checkpoint, {
    id: result.checkpoint.id,
    projectId: "project-current",
    sessionId: null,
    summary: "verified state",
    nextAction: "open the failing test",
    openLoops: "confirm fixture",
    returnHint: "tests/session.test.js",
    captureMode: "manual",
    createdAt: iso(NOW)
  });
  assert.equal(result.projectIndex, 0);
  assert.equal(state.checkpoints.length, 1);
});

test("prepareQuickCheckpointReview streams project lookup and returns its stable position", () => {
  const projects = [
    { id: "other", title: "Other", status: "active", updatedAt: iso(NOW - HOUR) },
    { id: "project-current", title: "Focus", status: "active", updatedAt: iso(NOW - HOUR) }
  ];
  Object.defineProperty(projects, "find", { value() { throw new Error("project find must not be used"); } });
  const state = stateWith({
    projects,
    sessions: [],
    checkpoints: [{
      id: "quick",
      projectId: "project-current",
      captureMode: "quick",
      createdAt: iso(NOW - HOUR)
    }]
  });

  const result = prepareQuickCheckpointReview(state, {
    projectId: "project-current",
    sourceCheckpointId: "quick",
    summary: "verified",
    nextAction: "continue"
  }, NOW);

  assert.equal(result.projectIndex, 1);
  assert.equal(result.projectTitle, "Focus");
});

test("prepareQuickCheckpointReview rejects stale forms, placeholders, and unavailable targets", () => {
  const quick = {
    id: "quick",
    projectId: "project-current",
    captureMode: "quick",
    createdAt: iso(NOW - HOUR)
  };
  const state = stateWith({ sessions: [], checkpoints: [quick] });
  assert.throws(() => prepareQuickCheckpointReview(state, { projectId: "missing", sourceCheckpointId: "quick" }, NOW), /项目不可用/);
  assert.throws(() => prepareQuickCheckpointReview(state, { projectId: "project-current", sourceCheckpointId: "older" }, NOW), /复核期间发生了变化/);
  assert.throws(() => prepareQuickCheckpointReview(state, {
    projectId: "project-current",
    sourceCheckpointId: "quick",
    summary: QUICK_DOCK_NOT_RECORDED.summary,
    nextAction: "next"
  }, NOW), /真实的当前状态摘要/);
  assert.throws(() => prepareQuickCheckpointReview(state, {
    projectId: "project-current",
    sourceCheckpointId: "quick",
    summary: "state",
    nextAction: QUICK_DOCK_NOT_RECORDED.nextAction
  }, NOW), /可直接执行的下一动作/);
  const newerManual = { ...quick, id: "manual", captureMode: "manual", createdAt: iso(NOW) };
  assert.throws(() => prepareQuickCheckpointReview({ ...state, checkpoints: [quick, newerManual] }, {
    projectId: "project-current",
    sourceCheckpointId: "quick",
    summary: "state",
    nextAction: "next"
  }, NOW), /最新检查点已不是/);
});

test("prepareQuickCheckpointReview rejects fields beyond persisted checkpoint limits", () => {
  const quick = {
    id: "quick",
    projectId: "project-current",
    captureMode: "quick",
    createdAt: iso(NOW - HOUR)
  };
  const state = stateWith({ sessions: [], checkpoints: [quick] });
  const base = { projectId: "project-current", sourceCheckpointId: "quick", summary: "state", nextAction: "next" };

  assert.throws(() => prepareQuickCheckpointReview(state, { ...base, summary: "x".repeat(1_201) }, NOW), /当前状态摘要不能超过 1200 字符/);
  assert.throws(() => prepareQuickCheckpointReview(state, { ...base, nextAction: "x".repeat(601) }, NOW), /下一动作不能超过 600 字符/);
  assert.throws(() => prepareQuickCheckpointReview(state, { ...base, openLoops: "x".repeat(801) }, NOW), /未决事项不能超过 800 字符/);
  assert.throws(() => prepareQuickCheckpointReview(state, { ...base, returnHint: "x".repeat(401) }, NOW), /恢复提示不能超过 400 字符/);
});

test("newest evidence is deterministic for equal or invalid timestamps", () => {
  const state = stateWith({
    crumbs: [
      { projectId: "project-current", sessionId: "session-current", type: "note", text: "无效时间证据", createdAt: "invalid" },
      { projectId: "project-current", sessionId: "session-current", type: "decision", text: "同刻较早", createdAt: iso(NOW - 1000) },
      { projectId: "project-current", sessionId: "session-current", type: "discovery", text: "同刻较晚", createdAt: iso(NOW - 1000) },
      { projectId: "project-current", sessionId: "session-current", type: "next", text: "明确下一步", createdAt: iso(NOW - 500) }
    ]
  });

  assert.equal(deriveQuickDockCheckpointInput(state, undefined, NOW).summary, "同刻较晚");
});

test("deriveQuickDockCheckpointInput refuses ambiguous or broken docking targets", async (t) => {
  await t.test("no active session", () => {
    assert.throws(
      () => deriveQuickDockCheckpointInput(stateWith({ sessions: [] }), undefined, NOW),
      /没有可快速停靠/
    );
  });

  await t.test("requested session is not the active one", () => {
    assert.throws(
      () => deriveQuickDockCheckpointInput(stateWith(), "session-old", NOW),
      /不是当前唯一活动会话/
    );
  });

  await t.test("multiple sessions violate the invariant", () => {
    assert.throws(
      () => deriveQuickDockCheckpointInput(stateWith({
        sessions: [activeSession(), activeSession({ id: "session-second" })]
      }), undefined, NOW),
      /系统只允许一个/
    );
  });

  await t.test("active session points to no project", () => {
    assert.throws(
      () => deriveQuickDockCheckpointInput(stateWith({ projects: [] }), undefined, NOW),
      /关联的项目不存在/
    );
  });
});

test("prepareQuickDock returns the same input with stable active-context positions", () => {
  const state = stateWith({
    projects: [{ id: "other", status: "active" }, { id: "project-current", status: "active", nextAction: "fallback" }],
    sessions: [{ id: "done", projectId: "other", status: "completed" }, activeSession()]
  });
  Object.defineProperty(state.projects, "find", { value() { throw new Error("project find must not be used"); } });
  Object.defineProperty(state.sessions, "find", { value() { throw new Error("session find must not be used"); } });

  const plan = prepareQuickDock(state, "session-current", NOW);

  assert.equal(plan.sessionIndex, 1);
  assert.equal(plan.projectIndex, 1);
  assert.equal(plan.session, state.sessions[1]);
  assert.equal(plan.project, state.projects[1]);
  assert.deepEqual(plan.input, deriveQuickDockCheckpointInput(state, "session-current", NOW));
});
