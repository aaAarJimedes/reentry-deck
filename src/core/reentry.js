import { daysSince } from "./time.js";

export function getProjectActivity(state, projectId) {
  return getIndexedProjectActivity(buildReentryIndex(state), projectId);
}

function getIndexedProjectActivity(index, projectId) {
  const project = index.projects.get(projectId);
  if (!project) return null;
  return { project, lastActivityAt: index.lastActivity.get(projectId) ?? project.createdAt };
}

export function buildReentryCard(state, projectId, now = Date.now()) {
  return buildIndexedReentryCard(buildReentryIndex(state), projectId, now);
}

export function buildReentryCards(state, projectIds, now = Date.now()) {
  const index = buildReentryIndex(state);
  return (Array.isArray(projectIds) ? projectIds : [])
    .map((projectId) => buildIndexedReentryCard(index, projectId, now))
    .filter(Boolean);
}

function buildIndexedReentryCard(index, projectId, now) {
  const activity = getIndexedProjectActivity(index, projectId);
  if (!activity) return null;
  const project = activity.project;
  const projectCrumbs = index.crumbs.get(projectId) ?? [];
  const checkpoints = index.checkpoints.get(projectId) ?? [];
  const sessions = index.sessions.get(projectId) ?? [];
  const checkpoint = checkpoints[0] ?? null;
  const latestNextCrumb = projectCrumbs.find((item) => item.type === "next");
  const latestSummaryCrumb = projectCrumbs.find((item) => ["note", "discovery", "decision"].includes(item.type));
  const activeSession = sessions.find((item) => item.status === "active") ?? null;
  const unresolvedSignals = projectCrumbs
    .filter((item) => ["question", "blocker"].includes(item.type) && !item.resolvedAt)
    .slice(0, 3);
  const decisions = projectCrumbs.filter((item) => item.type === "decision").slice(0, 2);
  const pinnedCrumbs = projectCrumbs.filter((item) => item.pinned).slice(0, 3);
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
  const readinessGaps = [];
  if (contextGapSessions.length) readinessGaps.push(`核对 ${contextGapSessions.length} 段未收拢或中断的会话`);
  if (checkpoint?.captureMode === "quick") readinessGaps.push("复核快速停靠生成的低置信度检查点");
  if (!summaryEvidence) readinessGaps.push("补一条当前状态摘要");
  if (!nextActionEvidence) readinessGaps.push("明确一个可直接执行的下一动作");
  if (!checkpoint) readinessGaps.push("完成一次可靠检查点");
  else if (!checkpoint.returnHint) readinessGaps.push("写下材料入口或恢复提示");

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
    readinessGaps,
    decisions,
    pinnedCrumbs,
    unresolvedSignals,
    changesSinceCheckpoint,
    contextGapSessions,
    recentTrail: projectCrumbs.slice(0, 5)
  };
}

export function rankProjectsForReentry(state, now = Date.now()) {
  const projects = state.projects
    .filter((project) => project.status !== "archived");
  const index = buildReentryIndex(state);
  return projects
    .map((project) => buildIndexedReentryCard(index, project.id, now))
    .filter(Boolean)
    .map((card) => ({ ...card, recommendationScore: reentryScore(card), recommendationReason: reentryReason(card) }))
    .sort((a, b) => b.recommendationScore - a.recommendationScore || timeOf(b.lastActivityAt) - timeOf(a.lastActivityAt));
}

function buildReentryIndex(state) {
  const projects = new Map();
  const sessions = new Map();
  const crumbs = new Map();
  const checkpoints = new Map();
  const lastActivity = new Map();

  for (const project of safeCollection(state?.projects)) {
    projects.set(project.id, project);
    lastActivity.set(project.id, newestDate([project.updatedAt, project.lastOpenedAt, project.createdAt]));
  }
  indexRecords(safeCollection(state?.sessions), sessions, projects, lastActivity, (item) => item.resolvedAt ?? item.endedAt ?? item.createdAt ?? item.startedAt);
  indexRecords(safeCollection(state?.crumbs), crumbs, projects, lastActivity, (item) => item.resolvedAt ?? item.endedAt ?? item.createdAt ?? item.startedAt);
  indexRecords(safeCollection(state?.checkpoints), checkpoints, projects, lastActivity, (item) => item.resolvedAt ?? item.endedAt ?? item.createdAt ?? item.startedAt);

  for (const items of crumbs.values()) items.sort(byNewest);
  for (const items of checkpoints.values()) items.sort(byNewest);
  for (const items of sessions.values()) items.sort((a, b) => timeOf(b.startedAt) - timeOf(a.startedAt));
  return { projects, sessions, crumbs, checkpoints, lastActivity };
}

function indexRecords(records, target, projects, lastActivity, activityOf) {
  for (const item of records) {
    if (!projects.has(item.projectId)) continue;
    if (!target.has(item.projectId)) target.set(item.projectId, []);
    target.get(item.projectId).push(item);
    const candidate = activityOf(item);
    if (timeOf(candidate) > timeOf(lastActivity.get(item.projectId))) lastActivity.set(item.projectId, candidate);
  }
}

function newestDate(values) {
  return values.filter(Boolean).reduce((newest, value) => timeOf(value) > timeOf(newest) ? value : newest, null);
}

function safeCollection(value) {
  return Array.isArray(value) ? value : [];
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
