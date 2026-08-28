import { buildReentryCards, rankReentryCards } from "./reentry.js";
import { inspectSession } from "./session.js";

const DAY_MS = 86_400_000;
const NEARBY_SWITCH_MS = 4 * 3_600_000;
const MAX_COUNTED_SESSION_MS = 12 * 3_600_000;

export function buildWorkspaceCounts(state, now = Date.now()) {
  return buildWorkspaceFrame(state, null, now).counts;
}

export function buildWorkspaceFrame(state, currentProjectId = null, now = Date.now()) {
  const counts = {
    unarchivedProjects: 0,
    activeProjects: 0,
    pausedProjects: 0,
    blockedProjects: 0,
    archivedProjects: 0,
    activeSessions: 0,
    crumbsToday: 0,
    checkpoints: Array.isArray(state?.checkpoints) ? state.checkpoints.length : 0
  };
  let activeSession = null;
  for (const session of Array.isArray(state?.sessions) ? state.sessions : []) {
    if (session?.status !== "active") continue;
    counts.activeSessions += 1;
    if (counts.activeSessions === 1) activeSession = session;
    else activeSession = null;
  }
  let currentProject = null;
  let activeProject = null;
  for (const project of Array.isArray(state?.projects) ? state.projects : []) {
    if (currentProjectId !== null && project.id === currentProjectId) currentProject = project;
    if (activeSession && project.id === activeSession.projectId) activeProject = project;
    if (project.status === "archived") {
      counts.archivedProjects += 1;
      continue;
    }
    counts.unarchivedProjects += 1;
    if (project.status === "active") counts.activeProjects += 1;
    else if (project.status === "paused") counts.pausedProjects += 1;
    else if (project.status === "blocked") counts.blockedProjects += 1;
  }
  const reference = new Date(now);
  const referenceTimestamp = reference.getTime();
  if (Number.isFinite(referenceTimestamp)) {
    const dayStart = new Date(reference.getFullYear(), reference.getMonth(), reference.getDate()).getTime();
    const dayEnd = new Date(reference.getFullYear(), reference.getMonth(), reference.getDate() + 1).getTime();
    for (const crumb of Array.isArray(state?.crumbs) ? state.crumbs : []) {
      const timestamp = timeOf(crumb.createdAt);
      if (timestamp >= dayStart && timestamp < dayEnd) counts.crumbsToday += 1;
    }
  }
  return { counts, currentProject, activeSession, activeProject };
}

export function buildWeeklyReview(state, now = Date.now(), options = {}) {
  const cardProjectIds = activeProjectIds(state.projects);
  return buildWeeklyReviewWithCards(state, now, options, buildReentryCards(state, cardProjectIds, now));
}

export function buildWorkspaceOverview(state, now = Date.now(), options = {}) {
  const projectIds = activeProjectIds(state.projects);
  const cards = buildReentryCards(state, projectIds, now);
  const rankedProjects = rankReentryCards(cards, options.rankedLimit ?? Number.POSITIVE_INFINITY);
  return {
    rankedProjects,
    rankedTotal: cards.length,
    weeklyReview: buildWeeklyReviewWithCards(state, now, options.weeklyReview ?? {}, cards),
    attentionDeck: buildAttentionDeckWithCards(state, now, options.attentionDeck ?? {}, cards)
  };
}

function buildWeeklyReviewWithCards(state, now, options, cards) {
  const windowDays = normalizeWindowDays(options.windowDays);
  const windowStart = now - windowDays * DAY_MS;
  const sessions = [];
  for (let index = 0; index < state.sessions.length; index += 1) {
    const session = state.sessions[index];
    if (overlapsWindow(session, windowStart, now)) sessions.push(session);
  }
  sessions.sort((a, b) => timeOf(a.startedAt) - timeOf(b.startedAt) || compareCodeUnits(a.id, b.id));
  const projectMinutes = new Map();
  let focusedMs = 0;
  let cappedSessions = 0;
  let nearbySwitches = 0;
  let interruptions = 0;
  let quickDocks = 0;
  let activeSessions = 0;

  for (let index = 0; index < sessions.length; index += 1) {
    const session = sessions[index];
    const duration = sessionDuration(session, windowStart, now);
    focusedMs += duration.countedMs;
    if (duration.capped) cappedSessions += 1;
    projectMinutes.set(session.projectId, (projectMinutes.get(session.projectId) ?? 0) + duration.countedMs);
    if (session.closeReason === "interrupted") interruptions += 1;
    if (session.closeReason === "quick-dock") quickDocks += 1;
    if (session.status === "active") activeSessions += 1;
    if (!index) continue;
    const previous = sessions[index - 1];
    const previousEnd = timeOf(previous.endedAt) || timeOf(previous.startedAt);
    const gap = timeOf(session.startedAt) - previousEnd;
    if (session.projectId !== previous.projectId && gap >= 0 && gap <= NEARBY_SWITCH_MS) nearbySwitches += 1;
  }

  let records = 0;
  let decisions = 0;
  let resolvedSignals = 0;
  for (let index = 0; index < state.crumbs.length; index += 1) {
    const crumb = state.crumbs[index];
    const createdAt = timeOf(crumb.createdAt);
    if (createdAt >= windowStart && createdAt <= now) {
      records += 1;
      if (crumb.type === "decision") decisions += 1;
    }
    const resolvedAt = timeOf(crumb.resolvedAt);
    if (resolvedAt >= windowStart && resolvedAt <= now) resolvedSignals += 1;
  }
  let completenessTotal = 0;
  for (const card of cards) completenessTotal += card.completeness;
  const recoverability = cards.length ? Math.round(completenessTotal / cards.length) : 0;
  let topProjectId = null;
  let topProjectMs = 0;
  for (const [projectId, minutes] of projectMinutes) {
    if (topProjectId === null || minutes > topProjectMs || (minutes === topProjectMs && compareCodeUnits(projectId, topProjectId) < 0)) {
      topProjectId = projectId;
      topProjectMs = minutes;
    }
  }
  let topProject = null;
  if (topProjectId !== null) {
    for (let index = 0; index < state.projects.length; index += 1) {
      const project = state.projects[index];
      if (project.id !== topProjectId) continue;
      topProject = project;
      break;
    }
  }

  return {
    windowDays,
    windowStart: new Date(windowStart).toISOString(),
    sessions: sessions.length,
    focusedMinutes: Math.round(focusedMs / 60_000),
    cappedSessions,
    nearbySwitches,
    interruptions,
    quickDocks,
    activeSessions,
    records,
    decisions,
    resolvedSignals,
    recoverability,
    topProject: topProject ? { id: topProject.id, title: topProject.title, minutes: Math.round(topProjectMs / 60_000) } : null
  };
}

export function buildAttentionDeck(state, now = Date.now(), options = {}) {
  const projectIds = activeProjectIds(state.projects);
  return buildAttentionDeckWithCards(state, now, options, buildReentryCards(state, projectIds, now));
}

function activeProjectIds(projects) {
  const ids = [];
  for (let index = 0; index < projects.length; index += 1) {
    const project = projects[index];
    if (project.status !== "archived") ids.push(project.id);
  }
  return ids;
}

function buildAttentionDeckWithCards(state, now, options, reentryCards) {
  const staleAfterDays = Number.isFinite(options.staleAfterDays)
    ? Math.max(1, options.staleAfterDays)
    : Math.max(1, Number(state.settings?.staleAfterDays) || 7);
  const limit = normalizeLimit(options.limit, 4);
  if (!limit) return [];
  const attention = [];
  for (const card of reentryCards) {
    const project = card.project;
    if (project.status === "archived") continue;
    const item = attentionForProject(project, card, now, staleAfterDays);
    if (item.score <= 0) continue;
    if (attention.length < limit) {
      pushWorstAttention(attention, item);
      continue;
    }
    if (compareAttention(item, attention[0]) >= 0) continue;
    attention[0] = item;
    sinkWorstAttention(attention, 0);
  }
  return attention.sort(compareAttention);
}

function pushWorstAttention(heap, item) {
  heap.push(item);
  let index = heap.length - 1;
  while (index > 0) {
    const parent = Math.floor((index - 1) / 2);
    if (compareAttention(heap[index], heap[parent]) <= 0) break;
    const previous = heap[parent];
    heap[parent] = heap[index];
    heap[index] = previous;
    index = parent;
  }
}

function sinkWorstAttention(heap, start) {
  let index = start;
  while (true) {
    const left = index * 2 + 1;
    if (left >= heap.length) return;
    const right = left + 1;
    let worse = left;
    if (right < heap.length && compareAttention(heap[right], heap[left]) > 0) worse = right;
    if (compareAttention(heap[worse], heap[index]) <= 0) return;
    const previous = heap[index];
    heap[index] = heap[worse];
    heap[worse] = previous;
    index = worse;
  }
}

function compareAttention(left, right) {
  return right.score - left.score
    || timeOf(left.card.lastActivityAt) - timeOf(right.card.lastActivityAt)
    || compareCodeUnits(left.project.id, right.project.id);
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

function compareCodeUnits(left, right) {
  return left === right ? 0 : left < right ? -1 : 1;
}
