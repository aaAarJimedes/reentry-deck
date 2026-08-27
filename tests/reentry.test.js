import test from "node:test";
import assert from "node:assert/strict";

import {
  buildReentryCard,
  getProjectActivity,
  getProjectStats,
  rankProjectsForReentry
} from "../src/core/reentry.js";

const DAY = 86_400_000;
const NOW = Date.parse("2026-06-15T12:00:00.000Z");

function at(offsetMs = 0) {
  return new Date(NOW + offsetMs).toISOString();
}

function makeProject(id, overrides = {}) {
  return {
    id,
    title: `Project ${id}`,
    description: "",
    nextAction: "",
    status: "active",
    createdAt: at(-20 * DAY),
    updatedAt: at(-10 * DAY),
    lastOpenedAt: at(-9 * DAY),
    ...overrides
  };
}

function makeState(overrides = {}) {
  return {
    projects: [],
    sessions: [],
    crumbs: [],
    checkpoints: [],
    ...overrides
  };
}

test("getProjectActivity returns null for an unknown project", () => {
  const state = makeState({ projects: [makeProject("known")] });

  assert.equal(getProjectActivity(state, "missing"), null);
});

test("getProjectActivity chooses the newest project, session, crumb, or checkpoint date", async (t) => {
  const project = makeProject("p1");
  const cases = [
    {
      name: "project metadata",
      state: makeState({ projects: [project] }),
      expected: project.lastOpenedAt
    },
    {
      name: "completed session end",
      state: makeState({
        projects: [project],
        sessions: [{
          id: "s1",
          projectId: "p1",
          status: "completed",
          startedAt: at(-5 * DAY),
          endedAt: at(-4 * DAY)
        }]
      }),
      expected: at(-4 * DAY)
    },
    {
      name: "active session start when there is no end",
      state: makeState({
        projects: [project],
        sessions: [{
          id: "s1",
          projectId: "p1",
          status: "active",
          startedAt: at(-3 * DAY),
          endedAt: null
        }]
      }),
      expected: at(-3 * DAY)
    },
    {
      name: "crumb creation",
      state: makeState({
        projects: [project],
        crumbs: [{ id: "c1", projectId: "p1", type: "note", text: "note", createdAt: at(-2 * DAY) }]
      }),
      expected: at(-2 * DAY)
    },
    {
      name: "checkpoint creation",
      state: makeState({
        projects: [project],
        checkpoints: [{ id: "cp1", projectId: "p1", createdAt: at(-DAY) }]
      }),
      expected: at(-DAY)
    }
  ];

  for (const item of cases) {
    await t.test(item.name, () => {
      const activity = getProjectActivity(item.state, "p1");
      assert.equal(activity.project, project);
      assert.equal(activity.lastActivityAt, item.expected);
    });
  }
});

test("getProjectActivity ignores other projects and falls back to createdAt", () => {
  const project = makeProject("p1", { updatedAt: null, lastOpenedAt: "" });
  const unrelatedTime = at(10 * DAY);
  const state = makeState({
    projects: [project, makeProject("p2")],
    sessions: [{ id: "s2", projectId: "p2", status: "active", startedAt: unrelatedTime, endedAt: null }],
    crumbs: [{ id: "c2", projectId: "p2", type: "note", text: "other", createdAt: unrelatedTime }],
    checkpoints: [{ id: "cp2", projectId: "p2", createdAt: unrelatedTime }]
  });

  assert.equal(getProjectActivity(state, "p1").lastActivityAt, project.createdAt);
});

test("buildReentryCard uses the newest timestamped evidence instead of blindly trusting a checkpoint", () => {
  const project = makeProject("p1", {
    description: "project summary",
    nextAction: "project next"
  });
  const olderCheckpoint = {
    id: "cp-old",
    projectId: "p1",
    summary: "old checkpoint summary",
    nextAction: "old checkpoint next",
    openLoops: "old loops",
    returnHint: "old hint",
    createdAt: at(-2 * DAY)
  };
  const latestCheckpoint = {
    id: "cp-new",
    projectId: "p1",
    summary: "checkpoint summary",
    nextAction: "checkpoint next",
    openLoops: "checkpoint loops",
    returnHint: "checkpoint hint",
    createdAt: at(-DAY)
  };
  const state = makeState({
    projects: [project],
    crumbs: [
      { id: "summary", projectId: "p1", type: "discovery", text: "crumb summary", createdAt: at(-3_000) },
      { id: "next", projectId: "p1", type: "next", text: "crumb next", createdAt: at(-2_000) },
      { id: "blocker", projectId: "p1", type: "blocker", text: "crumb blocker", createdAt: at(-1_000) }
    ],
    checkpoints: [olderCheckpoint, latestCheckpoint]
  });

  const card = buildReentryCard(state, "p1", NOW);

  assert.equal(card.checkpoint, latestCheckpoint);
  assert.equal(card.summary, "crumb summary");
  assert.equal(card.summaryEvidence.id, "summary");
  assert.equal(card.nextAction, "crumb next");
  assert.equal(card.nextActionEvidence.id, "next");
  assert.equal(card.openLoops, "checkpoint loops");
  assert.equal(card.returnHint, "checkpoint hint");
  assert.equal(card.completeness, 100);
  assert.deepEqual(card.changesSinceCheckpoint.map((item) => item.id), ["next", "summary"]);
});

test("quick-dock checkpoints are visibly capped at low-confidence readiness", () => {
  const state = makeState();
  state.projects.push(makeProject("p1"));
  state.checkpoints.push({
    id: "quick",
    projectId: "p1",
    sessionId: null,
    summary: "已有状态",
    nextAction: "已有下一步",
    openLoops: "已有未决",
    returnHint: "回来先复核",
    captureMode: "quick",
    createdAt: at(-1_000)
  });

  const card = buildReentryCard(state, "p1", NOW);

  assert.equal(card.completeness, 50);
  assert.equal(card.checkpoint.captureMode, "quick");
});

test("buildReentryCard applies crumb, project, and default fallbacks independently", async (t) => {
  await t.test("eligible crumbs beat project fields and unresolved signals form open loops", () => {
    const project = makeProject("p1", {
      description: "project summary",
      nextAction: "project next"
    });
    const state = makeState({
      projects: [project],
      crumbs: [
        { id: "old-note", projectId: "p1", type: "note", text: "old note", createdAt: at(-8_000) },
        { id: "decision", projectId: "p1", type: "decision", text: "new summary", createdAt: at(-7_000) },
        { id: "next-old", projectId: "p1", type: "next", text: "old next", createdAt: at(-6_000) },
        { id: "next-new", projectId: "p1", type: "next", text: "new next", createdAt: at(-5_000) },
        { id: "question", projectId: "p1", type: "question", text: "open question", createdAt: at(-4_000) },
        { id: "blocker", projectId: "p1", type: "blocker", text: "open blocker", createdAt: at(-3_000) }
      ],
      checkpoints: [{
        id: "cp",
        projectId: "p1",
        summary: "",
        nextAction: "",
        openLoops: "",
        returnHint: "",
        createdAt: at(-2_000)
      }]
    });

    const card = buildReentryCard(state, "p1", NOW);
    assert.equal(card.summary, "new summary");
    assert.equal(card.nextAction, "new next");
    assert.equal(card.openLoops, "open blocker；open question");
    assert.equal(card.returnHint, "先看最近轨迹，再开始一次短会话。");
    assert.equal(card.completeness, 75, "readiness counts actual evidence and does not count fallback prose");
  });

  await t.test("project fields are used when no eligible crumbs exist", () => {
    const card = buildReentryCard(makeState({
      projects: [makeProject("p1", { description: "project summary", nextAction: "project next" })],
      crumbs: [{ id: "q", projectId: "p1", type: "question", text: "question only", createdAt: at(-1_000) }]
    }), "p1", NOW);

    assert.equal(card.summary, "project summary");
    assert.equal(card.nextAction, "project next");
    assert.equal(card.openLoops, "question only");
  });

  await t.test("human-readable defaults are used when no context exists", () => {
    const card = buildReentryCard(makeState({ projects: [makeProject("p1")] }), "p1", NOW);

    assert.equal(card.summary, "还没有留下状态摘要。");
    assert.equal(card.nextAction, "先写下一个足够具体的下一步。");
    assert.equal(card.openLoops, "");
    assert.equal(card.returnHint, "先看最近轨迹，再开始一次短会话。");
    assert.equal(card.completeness, 0);
  });
});

test("buildReentryCard sorts and limits active sessions, signals, decisions, and trail", () => {
  const crumbSpecs = [
    ["note-old", "note", -10_000],
    ["decision-old", "decision", -9_000],
    ["question-old", "question", -8_000],
    ["decision-mid", "decision", -7_000],
    ["blocker-mid", "blocker", -6_000],
    ["decision-new", "decision", -5_000],
    ["question-mid", "question", -4_000],
    ["decision-newest", "decision", -3_000],
    ["blocker-new", "blocker", -2_000],
    ["note-new", "note", -1_000]
  ];
  const crumbs = crumbSpecs.map(([id, type, offset]) => ({
    id,
    projectId: "p1",
    type,
    text: id,
    createdAt: at(offset)
  }));
  const sessions = [
    { id: "active-old", projectId: "p1", status: "active", startedAt: at(-30_000), endedAt: null },
    { id: "active-new", projectId: "p1", status: "active", startedAt: at(-10_000), endedAt: null },
    { id: "completed-newest", projectId: "p1", status: "completed", startedAt: at(-5_000), endedAt: at(-1_000) }
  ];
  const originalCrumbOrder = crumbs.map((item) => item.id);
  const originalSessionOrder = sessions.map((item) => item.id);
  const state = makeState({ projects: [makeProject("p1")], crumbs, sessions });

  const card = buildReentryCard(state, "p1", NOW);

  assert.equal(card.activeSession.id, "active-new");
  assert.deepEqual(card.unresolvedSignals.map((item) => item.id), ["blocker-new", "question-mid", "blocker-mid"]);
  assert.deepEqual(card.decisions.map((item) => item.id), ["decision-newest", "decision-new"]);
  assert.deepEqual(card.changesSinceCheckpoint.map((item) => item.id), ["note-new", "decision-newest", "decision-new"]);
  assert.deepEqual(card.recentTrail.map((item) => item.id), ["note-new", "blocker-new", "decision-newest", "question-mid", "decision-new"]);
  assert.deepEqual(crumbs.map((item) => item.id), originalCrumbOrder, "building a card must not reorder state crumbs");
  assert.deepEqual(sessions.map((item) => item.id), originalSessionOrder, "building a card must not reorder state sessions");
});

test("buildReentryCard exposes at most three pinned crumbs in evidence order", () => {
  const state = makeState({
    projects: [makeProject("p1")],
    crumbs: [
      { id: "old", projectId: "p1", type: "note", text: "old", pinned: true, createdAt: at(-4_000) },
      { id: "not-pinned", projectId: "p1", type: "decision", text: "skip", pinned: false, createdAt: at(-3_500) },
      { id: "mid", projectId: "p1", type: "decision", text: "mid", pinned: true, createdAt: at(-3_000) },
      { id: "new", projectId: "p1", type: "discovery", text: "new", pinned: true, createdAt: at(-2_000) },
      { id: "newest", projectId: "p1", type: "next", text: "newest", pinned: true, createdAt: at(-1_000) }
    ]
  });

  const card = buildReentryCard(state, "p1", NOW);

  assert.deepEqual(card.pinnedCrumbs.map((item) => item.id), ["newest", "new", "mid"]);
});

test("buildReentryCard reports activity age and returns null for an unknown project", () => {
  const latestActivity = at(-1.5 * DAY);
  const state = makeState({
    projects: [makeProject("p1")],
    crumbs: [{ id: "latest", projectId: "p1", type: "note", text: "latest", createdAt: latestActivity }]
  });

  const card = buildReentryCard(state, "p1", NOW);
  assert.equal(card.lastActivityAt, latestActivity);
  assert.equal(card.awayDays, 1.5);
  assert.equal(buildReentryCard(state, "missing", NOW), null);
});

test("rankProjectsForReentry keeps active work ahead of stale paused work and explains every recommendation", () => {
  const projects = [
    makeProject("active-fresh", { status: "active", createdAt: at(0), updatedAt: at(0), lastOpenedAt: at(0) }),
    makeProject("blocked-stale-context", { status: "blocked", createdAt: at(-40 * DAY), updatedAt: at(-40 * DAY), lastOpenedAt: at(-40 * DAY) }),
    makeProject("paused-active-session", { status: "paused", createdAt: at(-20 * DAY), updatedAt: at(-20 * DAY), lastOpenedAt: at(-20 * DAY) }),
    makeProject("paused-very-stale", { status: "paused", createdAt: at(-100 * DAY), updatedAt: at(-100 * DAY), lastOpenedAt: at(-100 * DAY) }),
    makeProject("paused-fresh-context", { status: "paused", createdAt: at(0), updatedAt: at(0), lastOpenedAt: at(0) }),
    makeProject("paused-fresh", { status: "paused", createdAt: at(0), updatedAt: at(0), lastOpenedAt: at(0) }),
    makeProject("archived", { status: "archived", createdAt: at(-100 * DAY), updatedAt: at(-100 * DAY), lastOpenedAt: at(-100 * DAY) })
  ];
  const state = makeState({
    projects,
    sessions: [
      { id: "running", projectId: "paused-active-session", status: "active", startedAt: at(-3_600_000), endedAt: null },
      { id: "archived-running", projectId: "archived", status: "active", startedAt: at(0), endedAt: null }
    ],
    checkpoints: [
      { id: "stale-cp", projectId: "blocked-stale-context", summary: "context", createdAt: at(-40 * DAY) },
      { id: "fresh-cp", projectId: "paused-fresh-context", summary: "context", createdAt: at(0) }
    ]
  });

  const ranked = rankProjectsForReentry(state, NOW);

  assert.deepEqual(ranked.map((card) => card.project.id), [
    "paused-active-session",
    "active-fresh",
    "blocked-stale-context",
    "paused-very-stale",
    "paused-fresh-context",
    "paused-fresh"
  ]);
  assert.equal(ranked[0].recommendationReason, "有尚未收拢的活动会话");
  assert.ok(ranked.every((card) => card.recommendationScore >= 0 && card.recommendationReason));
  assert.equal(ranked.some((card) => card.project.id === "archived"), false);
  assert.deepEqual(state.projects.map((project) => project.id), projects.map((project) => project.id));
});

test("resolved questions disappear from open evidence and can be reconstructed from timestamps", () => {
  const state = makeState({
    projects: [makeProject("p1")],
    crumbs: [
      { id: "open", projectId: "p1", type: "question", text: "still open", resolvedAt: null, createdAt: at(-2_000) },
      { id: "done", projectId: "p1", type: "blocker", text: "fixed", resolvedAt: at(-500), createdAt: at(-1_000) }
    ]
  });

  const card = buildReentryCard(state, "p1", NOW);
  assert.deepEqual(card.unresolvedSignals.map((item) => item.id), ["open"]);
  assert.equal(card.lastActivityAt, at(-500), "resolution time is itself meaningful project activity");
});

test("an unclosed session after the checkpoint lowers readiness and old next records never override it", () => {
  const checkpoint = {
    id: "cp",
    projectId: "p1",
    summary: "checkpoint summary",
    nextAction: "checkpoint next",
    returnHint: "known route",
    captureMode: "manual",
    createdAt: at(-5_000)
  };
  const state = makeState({
    projects: [makeProject("p1", { nextAction: "initial next", nextActionUpdatedAt: at(-10_000) })],
    checkpoints: [checkpoint],
    crumbs: [{ id: "old-next", projectId: "p1", type: "next", text: "obsolete", createdAt: at(-6_000) }],
    sessions: [{ id: "open-session", projectId: "p1", status: "active", startedAt: at(-4_000), endedAt: null, checkpointId: null }]
  });

  const card = buildReentryCard(state, "p1", NOW);
  assert.equal(card.nextAction, "checkpoint next");
  assert.equal(card.nextActionEvidence.id, "cp");
  assert.deepEqual(card.contextGapSessions.map((item) => item.id), ["open-session"]);
  assert.equal(card.completeness, 80);
});

test("getProjectStats counts only matching records and recognized statuses/types", () => {
  const state = makeState({
    projects: [makeProject("p1"), makeProject("p2")],
    sessions: [
      { id: "s1", projectId: "p1", status: "completed" },
      { id: "s2", projectId: "p1", status: "completed" },
      { id: "s3", projectId: "p1", status: "active" },
      { id: "s4", projectId: "p1", status: "abandoned" },
      { id: "s5", projectId: "p2", status: "completed" }
    ],
    crumbs: [
      { id: "c1", projectId: "p1", type: "decision" },
      { id: "c2", projectId: "p1", type: "decision" },
      { id: "c3", projectId: "p1", type: "blocker" },
      { id: "c4", projectId: "p1", type: "question" },
      { id: "c5", projectId: "p2", type: "blocker" }
    ],
    checkpoints: [
      { id: "cp1", projectId: "p1" },
      { id: "cp2", projectId: "p1" },
      { id: "cp3", projectId: "p2" }
    ]
  });

  assert.deepEqual(getProjectStats(state, "p1"), {
    sessions: 4,
    completedSessions: 2,
    crumbs: 4,
    decisions: 2,
    blockers: 1,
    checkpoints: 2
  });
  assert.deepEqual(getProjectStats(state, "missing"), {
    sessions: 0,
    completedSessions: 0,
    crumbs: 0,
    decisions: 0,
    blockers: 0,
    checkpoints: 0
  });
});
