import { daysSince } from "./time.js";

export function getProjectActivity(state, projectId) {
  const project = state.projects.find((item) => item.id === projectId);
  if (!project) return null;
  const relatedDates = [project.updatedAt, project.lastOpenedAt];
  for (const collection of [state.sessions, state.crumbs, state.checkpoints]) {
    for (const item of collection) if (item.projectId === projectId) relatedDates.push(item.resolvedAt ?? item.endedAt ?? item.createdAt ?? item.startedAt);
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
    .filter((item) => ["question", "blocker"].includes(item.type) && !item.resolvedAt)
    .slice(0, 3);
  const decisions = projectCrumbs.filter((item) => item.type === "decision").slice(0, 2);
  const checkpointTime = timeOf(checkpoint?.createdAt);
  const changesSinceCheckpoint = projectCrumbs
    .filter((item) => ["note", "discovery", "decision", "next"].includes(item.type) && timeOf(item.createdAt) > checkpointTime)
    .slice(0, 3);
  const contextGapSessions = sessions.filter((item) => {
    const evidenceTime = timeOf(item.endedAt ?? item.startedAt);
    const unclosed = item.status === "active";
    const interrupted = item.status === "abandoned" && item.closeReason === "interrupted";
    return (unclosed || interrupted) && evidenceTime > checkpointTime && item.checkpointId !== checkpoint?.id;
  });

  const summaryEvidence = newestEvidence([
    checkpoint?.summary && evidence("checkpoint", "可靠检查点", checkpoint.summary, checkpoint.createdAt, checkpoint.id),
    latestSummaryCrumb && evidence("crumb", CRUMB_SOURCE_LABELS[latestSummaryCrumb.type], latestSummaryCrumb.text, latestSummaryCrumb.createdAt, latestSummaryCrumb.id),
    project.description && evidence("project", "项目说明", project.description, project.descriptionUpdatedAt ?? project.createdAt, project.id)
  ]);
  const nextActionEvidence = newestEvidence([
    checkpoint?.nextAction && evidence("checkpoint", "可靠检查点", checkpoint.nextAction, checkpoint.createdAt, checkpoint.id),
    latestNextCrumb && evidence("crumb", "下一步记录", latestNextCrumb.text, latestNextCrumb.createdAt, latestNextCrumb.id),
    project.nextAction && evidence("project", "项目动作", project.nextAction, project.nextActionUpdatedAt ?? project.createdAt, project.id)
  ]);

  const summary = summaryEvidence?.text || "还没有留下状态摘要。";
  const nextAction = nextActionEvidence?.text || "先写下一个足够具体的下一步。";
  const returnHint = checkpoint?.returnHint || "先看最近轨迹，再开始一次短会话。";
  const completenessFields = [summaryEvidence, nextActionEvidence, checkpoint?.returnHint, checkpoint || projectCrumbs.length];
  const rawCompleteness = Math.round((completenessFields.filter(Boolean).length / completenessFields.length) * 100);
  const confidenceCap = checkpoint?.captureMode === "quick" ? 50 : 100;
  const completeness = Math.max(0, Math.min(rawCompleteness, confidenceCap) - Math.min(contextGapSessions.length * 20, 40));

  return {
    project,
    activeSession,
    checkpoint,
    lastActivityAt: activity.lastActivityAt,
    awayDays: daysSince(activity.lastActivityAt, now),
    summary,
    summaryEvidence,
    nextAction,
    nextActionEvidence,
    openLoops: checkpoint?.openLoops || unresolvedSignals.map((item) => item.text).join("；"),
    returnHint,
    completeness,
    decisions,
    unresolvedSignals,
    changesSinceCheckpoint,
    contextGapSessions,
    recentTrail: projectCrumbs.slice(0, 5)
  };
}

export function rankProjectsForReentry(state, now = Date.now()) {
  return state.projects
    .filter((project) => project.status !== "archived")
    .map((project) => buildReentryCard(state, project.id, now))
    .filter(Boolean)
    .map((card) => ({ ...card, recommendationScore: reentryScore(card), recommendationReason: reentryReason(card) }))
    .sort((a, b) => b.recommendationScore - a.recommendationScore || timeOf(b.lastActivityAt) - timeOf(a.lastActivityAt));
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
  const statusWeight = { blocked: 40, active: 55, paused: 15 }[card.project.status] ?? 0;
  const activeWeight = card.activeSession ? 100 : 0;
  const staleWeight = Math.min(card.awayDays, 20) * 0.5;
  const contextWeight = card.checkpoint ? 5 : 0;
  return statusWeight + activeWeight + staleWeight + contextWeight;
}

function reentryReason(card) {
  if (card.activeSession) return "有尚未收拢的活动会话";
  if (card.project.status === "blocked") return card.unresolvedSignals.length ? `有 ${card.unresolvedSignals.length} 条待解阻证据` : "项目状态为受阻";
  if (card.awayDays >= 7) return `已离开 ${Math.floor(card.awayDays)} 天，且复航证据可用`;
  if (card.project.status === "active") return "推进中且最近现场可恢复";
  return "暂泊项目，保留在候选队列";
}

const CRUMB_SOURCE_LABELS = Object.freeze({ note: "随记", discovery: "发现", decision: "决定" });

function evidence(kind, label, text, createdAt, id) {
  return { kind, label, text, createdAt, id };
}

function newestEvidence(candidates) {
  return candidates.filter(Boolean).sort((a, b) => timeOf(b.createdAt) - timeOf(a.createdAt))[0] ?? null;
}

function timeOf(value) {
  const valueOf = Date.parse(value ?? "");
  return Number.isFinite(valueOf) ? valueOf : 0;
}

function byNewest(a, b) {
  return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
}
