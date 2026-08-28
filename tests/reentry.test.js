import test from "node:test";
import assert from "node:assert/strict";

import {
  buildReentryCard,
  buildReentryCards,
  buildReentryCardWithStats,
  getLatestProjectCheckpoint,
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

test("getLatestProjectCheckpoint streams only the target checkpoints with deterministic ties", () => {
  const timestamp = at(-1_000);
  const checkpoints = [
    { id: "other", projectId: "p2", createdAt: at(10_000) },
    { id: "older", projectId: "p1", createdAt: at(-2_000) },
    { id: "tie-old", projectId: "p1", createdAt: timestamp },
    { id: "tie-new", projectId: "p1", createdAt: timestamp }
  ];
  for (const method of ["filter", "find", "map", "sort"]) {
    Object.defineProperty(checkpoints, method, {
      value() { throw new Error(`${method} must not be used`); },
      configurable: true
    });
  }

  assert.equal(getLatestProjectCheckpoint({ checkpoints }, "p1")?.id, "tie-new");
  assert.equal(getLatestProjectCheckpoint({ checkpoints }, "missing"), null);
  assert.equal(getLatestProjectCheckpoint({ checkpoints: null }, "p1"), null);
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
  assert.equal(card.historicalOpenLoops, "", "live signals supersede checkpoint free text");
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
  assert.equal(card.historicalOpenLoops, "已有未决");
  assert.deepEqual(card.readinessGaps, ["复核快速停靠生成的低置信度检查点"]);
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
    assert.deepEqual(card.readinessGaps, [
      "补一条当前状态摘要",
      "明确一个可直接执行的下一动作",
      "完成一次可靠检查点"
    ]);
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

test("buildReentryCard treats later insertion as newer when timestamps match", () => {
  const timestamp = at(-1_000);
  const crumbs = [
    { id: "summary-old", projectId: "p1", type: "note", text: "old summary", createdAt: timestamp },
    { id: "next-old", projectId: "p1", type: "next", text: "old next", createdAt: timestamp },
    { id: "summary-new", projectId: "p1", type: "decision", text: "new summary", createdAt: timestamp },
    { id: "next-new", projectId: "p1", type: "next", text: "new next", createdAt: timestamp }
  ];
  const checkpoints = [
    { id: "checkpoint-old", projectId: "p1", summary: "old", nextAction: "old", openLoops: "", returnHint: "old", createdAt: timestamp },
    { id: "checkpoint-new", projectId: "p1", summary: "new", nextAction: "new", openLoops: "", returnHint: "new", createdAt: timestamp }
  ];
  const sessions = [
    { id: "session-old", projectId: "p1", status: "active", startedAt: timestamp, endedAt: null },
    { id: "session-new", projectId: "p1", status: "active", startedAt: timestamp, endedAt: null }
  ];
  const original = {
    crumbs: crumbs.map((item) => item.id),
    checkpoints: checkpoints.map((item) => item.id),
    sessions: sessions.map((item) => item.id)
  };
  const state = makeState({ projects: [makeProject("p1")], crumbs, checkpoints, sessions });

  const card = buildReentryCard(state, "p1", NOW);

  assert.equal(card.checkpoint.id, "checkpoint-new");
  assert.equal(card.summaryEvidence.id, "checkpoint-new");
  assert.equal(card.nextActionEvidence.id, "checkpoint-new");
  assert.equal(card.activeSession.id, "session-new");
  assert.deepEqual(card.recentTrail.map((item) => item.id), ["next-new", "summary-new", "next-old", "summary-old"]);
  assert.deepEqual(crumbs.map((item) => item.id), original.crumbs);
  assert.deepEqual(checkpoints.map((item) => item.id), original.checkpoints);
  assert.deepEqual(sessions.map((item) => item.id), original.sessions);
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

test("rankProjectsForReentry streams source projects and breaks full ties by code unit", () => {
  const projects = [makeProject("ä"), makeProject("z")];
  projects.filter = () => {
    throw new Error("ranking must not filter source projects");
  };
  projects.map = () => {
    throw new Error("ranking must not map source projects");
  };
  const ranked = rankProjectsForReentry(makeState({ projects }), NOW);

  assert.deepEqual(Array.prototype.map.call(ranked, (card) => card.project.id), ["z", "ä"]);
});

test("buildReentryCards indexes shared collections once while preserving per-project evidence", () => {
  const projects = Array.from({ length: 1_000 }, (_, index) => makeProject(`p${index}`, {
    createdAt: at(-index),
    updatedAt: at(-index),
    lastOpenedAt: at(-index)
  }));
  const crumbs = Array.from({ length: 5_000 }, (_, index) => ({
    id: `c${index}`,
    projectId: `p${index % projects.length}`,
    type: index % 2 ? "note" : "next",
    text: `evidence ${index}`,
    createdAt: at(index)
  }));
  let crumbFilterCalls = 0;
  Object.defineProperty(crumbs, "filter", {
    value(...args) {
      crumbFilterCalls += 1;
      return Array.prototype.filter.apply(this, args);
    }
  });
  const data = makeState({ projects, crumbs });

  const cards = buildReentryCards(data, projects.map((project) => project.id), NOW);

  assert.equal(cards.length, 1_000);
  assert.equal(crumbFilterCalls, 0, "batch projection must not rescan the full crumb collection per project");
  assert.equal(cards[0].project.id, "p0");
  assert.equal(cards[0].recentTrail.length, 5);
  assert.equal(cards[999].project.id, "p999");
  assert.deepEqual(buildReentryCards(data, ["missing"], NOW), []);
});

test("a boundary-sized reentry card derives bounded evidence without map or filter projections", () => {
  const crumbs = Array.from({ length: 49_999 }, (_, index) => ({
    id: `large-${index}`,
    projectId: "p1",
    type: "decision",
    text: `evidence ${index}`,
    pinned: true,
    createdAt: at(-1_000)
  }));
  const data = makeState({ projects: [makeProject("p1")], crumbs });
  const originalMap = Array.prototype.map;
  const originalFilter = Array.prototype.filter;
  Array.prototype.map = function () {
    throw new Error("card derivation must not map a full project history");
  };
  Array.prototype.filter = function () {
    throw new Error("card derivation must not filter a full project history");
  };
  let card;
  try {
    card = buildReentryCard(data, "p1", NOW);
  } finally {
    Array.prototype.map = originalMap;
    Array.prototype.filter = originalFilter;
  }

  assert.equal(card.summaryEvidence.id, "large-49998");
  assert.deepEqual(card.decisions.map((item) => item.id), ["large-49998", "large-49997"]);
  assert.deepEqual(card.pinnedCrumbs.map((item) => item.id), ["large-49998", "large-49997", "large-49996"]);
  assert.deepEqual(card.changesSinceCheckpoint.map((item) => item.id), ["large-49998", "large-49997", "large-49996"]);
  assert.deepEqual(card.recentTrail.map((item) => item.id), ["large-49998", "large-49997", "large-49996", "large-49995", "large-49994"]);
});

test("targeted reentry projection never reads or sorts unrelated evidence payloads", () => {
  let unrelatedDateReads = 0;
  const unrelated = {
    id: "unrelated",
    projectId: "p2",
    type: "note",
    text: "must stay untouched",
    get createdAt() {
      unrelatedDateReads += 1;
      return at(-1_000);
    }
  };
  const data = makeState({
    projects: [makeProject("p1"), makeProject("p2")],
    crumbs: [
      unrelated,
      { id: "target", projectId: "p1", type: "note", text: "target evidence", createdAt: at(-2_000) }
    ]
  });

  assert.equal(buildReentryCard(data, "p1", NOW).summary, "target evidence");
  assert.equal(unrelatedDateReads, 0);
  assert.deepEqual(buildReentryCards(data, ["p1"], NOW).map((card) => card.project.id), ["p1"]);
  assert.equal(unrelatedDateReads, 0);

  assert.equal(buildReentryCard(data, "p2", NOW).summary, "must stay untouched");
  assert.ok(unrelatedDateReads > 0, "the payload is read only when its project is requested");
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
  assert.deepEqual(card.readinessGaps, ["核对 1 段未收拢或中断的会话"]);
});

test("a reliable checkpoint without a return route exposes one focused readiness gap", () => {
  const state = makeState({
    projects: [makeProject("p1")],
    checkpoints: [{
      id: "cp",
      projectId: "p1",
      summary: "状态清楚",
      nextAction: "打开草稿",
      returnHint: "",
      captureMode: "manual",
      createdAt: at(-1_000)
    }]
  });

  assert.deepEqual(buildReentryCard(state, "p1", NOW).readinessGaps, ["写下材料入口或恢复提示"]);
});

test("checkpoint-only open loops remain visible as history without overriding live signals", () => {
  const checkpoint = {
    id: "cp",
    projectId: "p1",
    summary: "state",
    nextAction: "next",
    openLoops: "confirm the old dependency",
    returnHint: "hint",
    captureMode: "manual",
    createdAt: at(-2_000)
  };
  const base = makeState({ projects: [makeProject("p1")], checkpoints: [checkpoint] });

  assert.equal(buildReentryCard(base, "p1", NOW).historicalOpenLoops, "confirm the old dependency");
  assert.equal(buildReentryCard({
    ...base,
    crumbs: [{ id: "live", projectId: "p1", type: "question", text: "new question", createdAt: at(-1_000) }]
  }, "p1", NOW).historicalOpenLoops, "");
  assert.equal(buildReentryCard({
    ...base,
    checkpoints: [{ ...checkpoint, openLoops: "未解决的问题或阻塞未记录。", captureMode: "quick" }]
  }, "p1", NOW).historicalOpenLoops, "");
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
  assert.deepEqual(buildReentryCardWithStats(state, "p1", NOW).stats, getProjectStats(state, "p1"));
  assert.deepEqual(getProjectStats(state, "missing"), {
    sessions: 0,
    completedSessions: 0,
    crumbs: 0,
    decisions: 0,
    blockers: 0,
    checkpoints: 0
  });
});

test("a detailed reentry card derives stats during the same source collection pass", () => {
  const state = makeState({
    projects: [makeProject("p1"), makeProject("p2")],
    sessions: [{ id: "s1", projectId: "p1", status: "completed" }, { id: "s2", projectId: "p2", status: "active" }],
    crumbs: [{ id: "c1", projectId: "p1", type: "decision" }, { id: "c2", projectId: "p1", type: "blocker" }],
    checkpoints: [{ id: "cp1", projectId: "p1" }, { id: "cp2", projectId: "p2" }]
  });
  const passes = { sessions: 0, crumbs: 0, checkpoints: 0 };
  for (const name of Object.keys(passes)) {
    const collection = state[name];
    const iterate = collection[Symbol.iterator].bind(collection);
    Object.defineProperty(collection, Symbol.iterator, {
      value() {
        passes[name] += 1;
        return iterate();
      }
    });
  }

  const card = buildReentryCardWithStats(state, "p1", NOW);

  assert.deepEqual(card.stats, {
    sessions: 1,
    completedSessions: 1,
    crumbs: 2,
    decisions: 1,
    blockers: 1,
    checkpoints: 1
  });
  assert.deepEqual(passes, { sessions: 1, crumbs: 1, checkpoints: 1 });
});

test("getProjectStats derives every counter without collection filter rescans", () => {
  const data = makeState({
    sessions: [{ projectId: "p1", status: "completed" }, { projectId: "p2", status: "active" }],
    crumbs: [{ projectId: "p1", type: "decision" }, { projectId: "p1", type: "blocker" }, { projectId: "p2", type: "note" }],
    checkpoints: [{ projectId: "p1" }, { projectId: "p2" }]
  });
  for (const collection of [data.sessions, data.crumbs, data.checkpoints]) {
    Object.defineProperty(collection, "filter", {
      value() {
        throw new Error("stats must use one streaming pass per collection");
      }
    });
  }

  assert.deepEqual(getProjectStats(data, "p1"), {
    sessions: 1,
    completedSessions: 1,
    crumbs: 2,
    decisions: 1,
    blockers: 1,
    checkpoints: 1
  });
});
