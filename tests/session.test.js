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
  isSessionStale
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
