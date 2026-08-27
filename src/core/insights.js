import { buildReentryCards, rankProjectsForReentry } from "./reentry.js";
import { inspectSession } from "./session.js";

const DAY_MS = 86_400_000;
const NEARBY_SWITCH_MS = 4 * 3_600_000;
const MAX_COUNTED_SESSION_MS = 12 * 3_600_000;

export function buildWeeklyReview(state, now = Date.now(), options = {}) {
  const cardProjectIds = state.projects.filter((project) => project.status !== "archived").map((project) => project.id);
  return buildWeeklyReviewWithCards(state, now, options, buildReentryCards(state, cardProjectIds, now));
}

export function buildWorkspaceOverview(state, now = Date.now(), options = {}) {
  const rankedProjects = rankProjectsForReentry(state, now);
  return {
    rankedProjects,
    weeklyReview: buildWeeklyReviewWithCards(state, now, options.weeklyReview ?? {}, rankedProjects),
    attentionDeck: buildAttentionDeckWithCards(state, now, options.attentionDeck ?? {}, rankedProjects)
  };
}

function buildWeeklyReviewWithCards(state, now, options, cards) {
  const windowDays = normalizeWindowDays(options.windowDays);
  const windowStart = now - windowDays * DAY_MS;
  const sessions = state.sessions
    .filter((session) => overlapsWindow(session, windowStart, now))
    .slice()
    .sort((a, b) => timeOf(a.startedAt) - timeOf(b.startedAt) || a.id.localeCompare(b.id));
  const projectMinutes = new Map();
  let focusedMs = 0;
  let cappedSessions = 0;

  for (const session of sessions) {
    const duration = sessionDuration(session, windowStart, now);
    focusedMs += duration.countedMs;
    if (duration.capped) cappedSessions += 1;
    projectMinutes.set(session.projectId, (projectMinutes.get(session.projectId) ?? 0) + duration.countedMs);
  }

  let nearbySwitches = 0;
  for (let index = 1; index < sessions.length; index += 1) {
    const previous = sessions[index - 1];
    const current = sessions[index];
    const previousEnd = timeOf(previous.endedAt) || timeOf(previous.startedAt);
    const gap = timeOf(current.startedAt) - previousEnd;
    if (current.projectId !== previous.projectId && gap >= 0 && gap <= NEARBY_SWITCH_MS) nearbySwitches += 1;
  }

  const recentCrumbs = state.crumbs.filter((crumb) => timeOf(crumb.createdAt) >= windowStart && timeOf(crumb.createdAt) <= now);
  const resolvedSignals = state.crumbs.filter((crumb) => timeOf(crumb.resolvedAt) >= windowStart && timeOf(crumb.resolvedAt) <= now);
  const recoverability = cards.length
    ? Math.round(cards.reduce((sum, card) => sum + card.completeness, 0) / cards.length)
    : 0;
  const topProjectEntry = [...projectMinutes.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
  const topProject = topProjectEntry
    ? state.projects.find((project) => project.id === topProjectEntry[0]) ?? null
    : null;

  return {
    windowDays,
    windowStart: new Date(windowStart).toISOString(),
    sessions: sessions.length,
    focusedMinutes: Math.round(focusedMs / 60_000),
    cappedSessions,
    nearbySwitches,
    interruptions: sessions.filter((session) => session.closeReason === "interrupted").length,
    quickDocks: sessions.filter((session) => session.closeReason === "quick-dock").length,
    activeSessions: sessions.filter((session) => session.status === "active").length,
    records: recentCrumbs.length,
    decisions: recentCrumbs.filter((crumb) => crumb.type === "decision").length,
    resolvedSignals: resolvedSignals.length,
    recoverability,
    topProject: topProject ? { id: topProject.id, title: topProject.title, minutes: Math.round(topProjectEntry[1] / 60_000) } : null
  };
}

export function buildAttentionDeck(state, now = Date.now(), options = {}) {
  const projectIds = state.projects.filter((project) => project.status !== "archived").map((project) => project.id);
  return buildAttentionDeckWithCards(state, now, options, buildReentryCards(state, projectIds, now));
}

function buildAttentionDeckWithCards(state, now, options, reentryCards) {
  const staleAfterDays = Number.isFinite(options.staleAfterDays)
    ? Math.max(1, options.staleAfterDays)
    : Math.max(1, Number(state.settings?.staleAfterDays) || 7);

  const projects = state.projects.filter((project) => project.status !== "archived");
  const cards = new Map(reentryCards.map((card) => [card.project.id, card]));
  return projects
    .map((project) => attentionForProject(project, cards.get(project.id), now, staleAfterDays))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || timeOf(a.card.lastActivityAt) - timeOf(b.card.lastActivityAt) || a.project.id.localeCompare(b.project.id))
    .slice(0, normalizeLimit(options.limit, 4));
}

function attentionForProject(project, card, now, staleAfterDays) {
  const signals = card.unresolvedSignals;
  const blockers = signals.filter((item) => item.type === "blocker").length;
  const questions = signals.filter((item) => item.type === "question").length;
  const reasons = [];
  let score = 0;

  const sessionHealth = card.activeSession ? inspectSession(card.activeSession, now) : null;
  if (sessionHealth?.stale) {
    score += 100;
    reasons.push("活动会话可能没有收拢");
  } else if (card.activeSession) {
    score += 70;
    reasons.push("有正在进行的会话");
  }
  if (project.status === "blocked") {
    score += 55;
    reasons.push("项目标记为受阻");
  }
  if (blockers) {
    score += Math.min(blockers * 20, 40);
    reasons.push(`${blockers} 条阻塞仍未解决`);
  }
  if (questions) {
    score += Math.min(questions * 8, 24);
    reasons.push(`${questions} 个问题仍待确认`);
  }
  if (!card.checkpoint) {
    score += 25;
    reasons.push("还没有可靠检查点");
  } else if (card.checkpoint.captureMode === "quick") {
    score += 18;
    reasons.push("最近一次是低置信度停靠");
  }
  if (!card.nextActionEvidence) {
    score += 20;
    reasons.push("缺少可执行的下一步证据");
  }
  if (card.awayDays >= staleAfterDays) {
    score += Math.min(10 + Math.floor(card.awayDays - staleAfterDays), 25);
    reasons.push(`已离开 ${Math.floor(card.awayDays)} 天`);
  }

  return {
    project,
    card,
    score,
    level: score >= 90 ? "high" : score >= 45 ? "medium" : "low",
    reasons: reasons.slice(0, 3)
  };
}

function overlapsWindow(session, windowStart, now) {
  const start = timeOf(session.startedAt);
  const naturalEnd = session.status === "active" ? now : timeOf(session.endedAt);
  return Boolean(start && naturalEnd && start <= now && naturalEnd >= start && naturalEnd > windowStart);
}

function sessionDuration(session, windowStart, now) {
  const start = Math.max(timeOf(session.startedAt), windowStart);
  const naturalEnd = Math.min(session.status === "active" ? now : timeOf(session.endedAt), now);
  if (!start || !naturalEnd || naturalEnd <= start) return { countedMs: 0, capped: false };
  const rawMs = naturalEnd - start;
  return { countedMs: Math.min(rawMs, MAX_COUNTED_SESSION_MS), capped: rawMs > MAX_COUNTED_SESSION_MS };
}

function normalizeWindowDays(value) {
  return Number.isSafeInteger(value) ? Math.max(1, Math.min(value, 90)) : 7;
}

function normalizeLimit(value, fallback) {
  return Number.isSafeInteger(value) ? Math.max(0, Math.min(value, 20)) : fallback;
}

function timeOf(value) {
  const parsed = Date.parse(value ?? "");
  return Number.isFinite(parsed) ? parsed : 0;
}
