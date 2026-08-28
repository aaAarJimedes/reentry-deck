import test from "node:test";
import assert from "node:assert/strict";

import { buildAttentionDeck, buildWeeklyReview, buildWorkspaceOverview } from "../src/core/insights.js";

const NOW = Date.parse("2026-08-28T12:00:00.000Z");
const HOUR = 3_600_000;
const DAY = 86_400_000;
const at = (offset) => new Date(NOW + offset).toISOString();

function project(id, overrides = {}) {
  return {
    id,
    title: `Project ${id}`,
    description: "",
    nextAction: "",
    status: "active",
    createdAt: at(-20 * DAY),
    updatedAt: at(-2 * DAY),
    lastOpenedAt: at(-2 * DAY),
    ...overrides
  };
}

function state(overrides = {}) {
  return {
    settings: { staleAfterDays: 7 },
    projects: [],
    sessions: [],
    crumbs: [],
    checkpoints: [],
    ...overrides
  };
}

test("buildWeeklyReview calculates bounded local evidence and nearby project switches", () => {
  const data = state({
    projects: [project("p1"), project("p2")],
    sessions: [
      { id: "old", projectId: "p1", status: "completed", startedAt: at(-8 * DAY), endedAt: at(-8 * DAY + HOUR) },
      { id: "s1", projectId: "p1", status: "completed", startedAt: at(-6 * HOUR), endedAt: at(-5 * HOUR) },
      { id: "s2", projectId: "p2", status: "completed", startedAt: at(-4 * HOUR), endedAt: at(-2 * HOUR) },
      { id: "s3", projectId: "p2", status: "abandoned", closeReason: "quick-dock", startedAt: at(-HOUR), endedAt: at(-30 * 60_000) }
    ],
    crumbs: [
      { id: "d", projectId: "p1", type: "decision", createdAt: at(-DAY) },
      { id: "q", projectId: "p2", type: "question", createdAt: at(-DAY), resolvedAt: at(-HOUR) },
      { id: "old-crumb", projectId: "p1", type: "note", createdAt: at(-9 * DAY) }
    ],
    checkpoints: [
      { id: "cp1", projectId: "p1", summary: "state", nextAction: "next", returnHint: "hint", createdAt: at(-2 * DAY) },
      { id: "cp2", projectId: "p2", summary: "state", nextAction: "next", returnHint: "hint", createdAt: at(-2 * DAY) }
    ]
  });

  data.projects.filter = () => {
    throw new Error("weekly review must not filter source projects");
  };
  data.sessions.filter = () => {
    throw new Error("weekly review must not filter source sessions");
  };
  data.crumbs.filter = () => {
    throw new Error("weekly review must not filter source crumbs");
  };

  const review = buildWeeklyReview(data, NOW);
  assert.equal(review.sessions, 3);
  assert.equal(review.focusedMinutes, 210);
  assert.equal(review.nearbySwitches, 1);
  assert.equal(review.interruptions, 0);
  assert.equal(review.quickDocks, 1);
  assert.equal(review.activeSessions, 0);
  assert.equal(review.records, 2);
  assert.equal(review.decisions, 1);
  assert.equal(review.resolvedSignals, 1);
  assert.equal(review.recoverability, 100);
  assert.deepEqual(review.topProject, { id: "p2", title: "Project p2", minutes: 150 });
});

test("workspace insights use code-unit tie breaks independent of host locale", () => {
  const data = state({
    projects: [project("ä"), project("z")],
    sessions: [
      { id: "ä", projectId: "ä", status: "completed", startedAt: at(-2 * HOUR), endedAt: at(-HOUR) },
      { id: "z", projectId: "z", status: "completed", startedAt: at(-2 * HOUR), endedAt: at(-HOUR) }
    ]
  });

  assert.equal(buildWeeklyReview(data, NOW).topProject.id, "z");
  assert.deepEqual(buildAttentionDeck(data, NOW, { limit: 2 }).map((item) => item.project.id), ["z", "ä"]);
});

test("buildWeeklyReview caps implausibly long sessions and normalizes options", () => {
  const data = state({
    projects: [project("p1")],
    sessions: [{ id: "long", projectId: "p1", status: "active", startedAt: at(-20 * HOUR), endedAt: null }]
  });
  const review = buildWeeklyReview(data, NOW, { windowDays: 200 });
  assert.equal(review.windowDays, 90);
  assert.equal(review.focusedMinutes, 720);
  assert.equal(review.cappedSessions, 1);
});

test("buildWeeklyReview includes sessions that overlap the window and counts only the overlap", () => {
  const data = state({
    projects: [project("p1"), project("p2")],
    sessions: [
      { id: "outside", projectId: "p1", status: "completed", startedAt: at(-8 * DAY), endedAt: at(-7 * DAY) },
      { id: "crossing", projectId: "p1", status: "completed", startedAt: at(-7 * DAY - 2 * HOUR), endedAt: at(-7 * DAY + HOUR) },
      { id: "inside", projectId: "p2", status: "completed", startedAt: at(-7 * DAY + 2 * HOUR), endedAt: at(-7 * DAY + 3 * HOUR) }
    ]
  });

  const review = buildWeeklyReview(data, NOW);

  assert.equal(review.sessions, 2);
  assert.equal(review.focusedMinutes, 120);
  assert.equal(review.nearbySwitches, 1);
  assert.deepEqual(review.topProject, { id: "p1", title: "Project p1", minutes: 60 });
});

test("buildWeeklyReview retains a long-running active session that began before the window", () => {
  const data = state({
    projects: [project("p1")],
    sessions: [{ id: "old-active", projectId: "p1", status: "active", startedAt: at(-8 * DAY), endedAt: null }]
  });

  const review = buildWeeklyReview(data, NOW);

  assert.equal(review.sessions, 1);
  assert.equal(review.activeSessions, 1);
  assert.equal(review.focusedMinutes, 720);
  assert.equal(review.cappedSessions, 1);
});

test("buildAttentionDeck explains risk without including healthy or archived work", () => {
  const data = state({
    projects: [
      project("stale-session", { status: "active" }),
      project("blocked", { status: "blocked", updatedAt: at(-10 * DAY), lastOpenedAt: at(-10 * DAY) }),
      project("healthy", { nextAction: "continue", nextActionUpdatedAt: at(-DAY) }),
      project("archived", { status: "archived" })
    ],
    sessions: [{ id: "open", projectId: "stale-session", status: "active", startedAt: at(-13 * HOUR), endedAt: null }],
    crumbs: [
      { id: "b", projectId: "blocked", type: "blocker", text: "dependency", createdAt: at(-9 * DAY), resolvedAt: null },
      { id: "q", projectId: "blocked", type: "question", text: "unknown", createdAt: at(-8 * DAY), resolvedAt: null }
    ],
    checkpoints: [{ id: "healthy-cp", projectId: "healthy", summary: "good", nextAction: "continue", returnHint: "open file", createdAt: at(-DAY) }]
  });

  const deck = buildAttentionDeck(data, NOW);
  assert.deepEqual(deck.map((item) => item.project.id), ["stale-session", "blocked"]);
  assert.equal(deck[0].level, "high");
  assert.match(deck[0].reasons.join("；"), /没有收拢/);
  assert.match(deck[1].reasons.join("；"), /受阻/);
  assert.equal(deck.some((item) => item.project.id === "archived"), false);
  assert.deepEqual(buildAttentionDeck(data, NOW, { limit: 0 }), []);
});

test("buildWorkspaceOverview shares one reentry index across ranking, review, and attention", () => {
  const projects = Array.from({ length: 1_000 }, (_, index) => project(`p${index}`, {
    status: index % 17 === 0 ? "blocked" : "active"
  }));
  const crumbs = Array.from({ length: 5_000 }, (_, index) => ({
    id: `c${index}`,
    projectId: `p${index % projects.length}`,
    type: index % 11 === 0 ? "blocker" : "note",
    text: `evidence ${index}`,
    createdAt: at(-index)
  }));
  const originalIterator = crumbs[Symbol.iterator].bind(crumbs);
  let iteratorCalls = 0;
  Object.defineProperty(crumbs, Symbol.iterator, {
    value() {
      iteratorCalls += 1;
      return originalIterator();
    }
  });
  const data = state({ projects, crumbs });

  const overview = buildWorkspaceOverview(data, NOW);

  assert.equal(iteratorCalls, 1, "the shared overview must index evidence only once");
  assert.equal(overview.rankedProjects.length, 1_000);
  assert.equal(overview.weeklyReview.records, 5_000);
  assert.equal(overview.attentionDeck.length, 4);
  assert.equal(overview.attentionDeck[0].project.status, "blocked");
});
