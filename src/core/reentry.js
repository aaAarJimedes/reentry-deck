import { daysSince } from "./time.js";

export function getProjectActivity(state, projectId) {
  const project = state.projects.find((item) => item.id === projectId);
  if (!project) return null;
  const relatedDates = [project.updatedAt, project.lastOpenedAt];
  for (const collection of [state.sessions, state.crumbs, state.checkpoints]) {
    for (const item of collection) if (item.projectId === projectId) relatedDates.push(item.endedAt ?? item.createdAt ?? item.startedAt);
  }
  const lastActivityAt = relatedDates
    .filter(Boolean)
    .sort((a, b) => new Date(b).getTime() - new Date(a).getTime())[0] ?? project.createdAt;
  return { project, lastActivityAt };
}

export function buildReentryCard(state, projectId, now = Date.now()) {
  const activity = getProjectActivity(state, projectId);
  if (!activity) return null;
  const project = activity.project;
  const projectCrumbs = state.crumbs
    .filter((item) => item.projectId === projectId)
    .sort(byNewest);
  const checkpoints = state.checkpoints
    .filter((item) => item.projectId === projectId)
    .sort(byNewest);
  const sessions = state.sessions
    .filter((item) => item.projectId === projectId)
    .sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt));
  const checkpoint = checkpoints[0] ?? null;
  const latestNextCrumb = projectCrumbs.find((item) => item.type === "next");
  const latestSummaryCrumb = projectCrumbs.find((item) => ["note", "discovery", "decision"].includes(item.type));
  const activeSession = sessions.find((item) => item.status === "active") ?? null;
  const unresolvedSignals = projectCrumbs
    .filter((item) => ["question", "blocker"].includes(item.type))
    .slice(0, 3);
  const decisions = projectCrumbs.filter((item) => item.type === "decision").slice(0, 3);

  const summary = checkpoint?.summary || latestSummaryCrumb?.text || project.description || "还没有留下状态摘要。";
  const nextAction = checkpoint?.nextAction || latestNextCrumb?.text || project.nextAction || "先写下一个足够具体的下一步。";
  const returnHint = checkpoint?.returnHint || "先看最近轨迹，再开始一次短会话。";
  const completenessFields = [checkpoint?.summary, nextAction, checkpoint?.openLoops, checkpoint?.returnHint];
  const rawCompleteness = Math.round((completenessFields.filter(Boolean).length / completenessFields.length) * 100);
  const completeness = checkpoint?.captureMode === "quick" ? Math.min(rawCompleteness, 50) : rawCompleteness;

  return {
    project,
    activeSession,
    checkpoint,
    lastActivityAt: activity.lastActivityAt,
    awayDays: daysSince(activity.lastActivityAt, now),
    summary,
    nextAction,
    openLoops: checkpoint?.openLoops || unresolvedSignals.map((item) => item.text).join("；"),
    returnHint,
    completeness,
    decisions,
    unresolvedSignals,
    recentTrail: projectCrumbs.slice(0, 5)
  };
}

export function rankProjectsForReentry(state, now = Date.now()) {
  return state.projects
    .filter((project) => project.status !== "archived")
    .map((project) => buildReentryCard(state, project.id, now))
    .filter(Boolean)
    .sort((a, b) => reentryScore(b, now) - reentryScore(a, now));
}

export function getProjectStats(state, projectId) {
  const sessions = state.sessions.filter((item) => item.projectId === projectId);
  const crumbs = state.crumbs.filter((item) => item.projectId === projectId);
  return {
    sessions: sessions.length,
    completedSessions: sessions.filter((item) => item.status === "completed").length,
    crumbs: crumbs.length,
    decisions: crumbs.filter((item) => item.type === "decision").length,
    blockers: crumbs.filter((item) => item.type === "blocker").length,
    checkpoints: state.checkpoints.filter((item) => item.projectId === projectId).length
  };
}

function reentryScore(card) {
  const statusWeight = { blocked: 40, active: 30, paused: 10 }[card.project.status] ?? 0;
  const activeWeight = card.activeSession ? 80 : 0;
  const staleWeight = Math.min(card.awayDays, 30) * 1.5;
  const contextWeight = card.checkpoint ? 12 : 0;
  return statusWeight + activeWeight + staleWeight + contextWeight;
}

function byNewest(a, b) {
  return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
}
