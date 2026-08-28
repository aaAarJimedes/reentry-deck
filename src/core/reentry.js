import { daysSince } from "./time.js";
import { QUICK_DOCK_NOT_RECORDED } from "./session.js";

const OPEN_SIGNAL_TYPES = new Set(["question", "blocker"]);
const SUMMARY_CRUMB_TYPES = new Set(["note", "discovery", "decision"]);
const CHANGE_CRUMB_TYPES = new Set(["note", "discovery", "decision", "next"]);

export function getProjectActivity(state, projectId) {
  return getIndexedProjectActivity(buildReentryIndex(state, [projectId]), projectId);
}

function getIndexedProjectActivity(index, projectId) {
  const project = index.projects.get(projectId);
  if (!project) return null;
  return { project, lastActivityAt: index.lastActivity.get(projectId) ?? project.createdAt };
}

export function buildReentryCard(state, projectId, now = Date.now()) {
  return buildIndexedReentryCard(buildReentryIndex(state, [projectId]), projectId, now);
}

export function buildReentryCardWithStats(state, projectId, now = Date.now()) {
  return buildIndexedReentryCard(buildReentryIndex(state, [projectId]), projectId, now, true);
}

export function getLatestProjectCheckpoint(state, projectId) {
  let latest = null;
  let latestTime = Number.NEGATIVE_INFINITY;
  for (const checkpoint of safeCollection(state?.checkpoints)) {
    if (checkpoint.projectId !== projectId) continue;
    const candidateTime = timeOf(checkpoint.createdAt);
    if (candidateTime < latestTime) continue;
    latest = checkpoint;
    latestTime = candidateTime;
  }
  return latest;
}

export function prepareSessionStart(state, projectId) {
  for (const session of safeCollection(state?.sessions)) {
    if (session.status === "active") throw new Error("已有活动会话，请先为它留下检查点。 ");
  }
  const projects = safeCollection(state?.projects);
  for (let index = 0; index < projects.length; index += 1) {
    const project = projects[index];
    if (project.id !== projectId) continue;
    if (project.status === "archived") throw new Error("项目不可用，无法开始会话。 ");
    return {
      project,
      projectIndex: index,
      sourceCheckpoint: getLatestProjectCheckpoint(state, project.id)
    };
  }
  throw new Error("项目不可用，无法开始会话。 ");
}

export function buildReentryCards(state, projectIds, now = Date.now()) {
  const safeProjectIds = Array.isArray(projectIds) ? projectIds : [];
  const index = buildReentryIndex(state, safeProjectIds);
  const cards = [];
  for (const projectId of safeProjectIds) {
    const card = buildIndexedReentryCard(index, projectId, now);
    if (card) cards.push(card);
  }
  return cards;
}

function buildIndexedReentryCard(index, projectId, now, includeStats = false) {
  const activity = getIndexedProjectActivity(index, projectId);
  if (!activity) return null;
  const project = activity.project;
  const projectCrumbs = index.crumbs.get(projectId) ?? [];
  const checkpoints = index.checkpoints.get(projectId) ?? [];
  const sessions = index.sessions.get(projectId) ?? [];
  const checkpoint = checkpoints[0] ?? null;
  const checkpointTime = timeOf(checkpoint?.createdAt);
  const stats = includeStats
    ? { sessions: sessions.length, completedSessions: 0, crumbs: projectCrumbs.length, decisions: 0, blockers: 0, checkpoints: checkpoints.length }
    : null;
  let latestNextCrumb = null;
  let latestSummaryCrumb = null;
  const unresolvedSignals = [];
  const decisions = [];
  const pinnedCrumbs = [];
  const changesSinceCheckpoint = [];
  for (const item of projectCrumbs) {
    if (stats && item.type === "decision") stats.decisions += 1;
    if (stats && item.type === "blocker") stats.blockers += 1;
    if (!latestNextCrumb && item.type === "next") latestNextCrumb = item;
    if (!latestSummaryCrumb && SUMMARY_CRUMB_TYPES.has(item.type)) latestSummaryCrumb = item;
    if (unresolvedSignals.length < 3 && OPEN_SIGNAL_TYPES.has(item.type) && !item.resolvedAt) unresolvedSignals.push(item);
    if (decisions.length < 2 && item.type === "decision") decisions.push(item);
    if (pinnedCrumbs.length < 3 && item.pinned) pinnedCrumbs.push(item);
    if (changesSinceCheckpoint.length < 3 && CHANGE_CRUMB_TYPES.has(item.type) && timeOf(item.createdAt) > checkpointTime) {
      changesSinceCheckpoint.push(item);
    }
  }
  const historicalOpenLoops = unresolvedSignals.length || !checkpoint?.openLoops || checkpoint.openLoops === QUICK_DOCK_NOT_RECORDED.openLoops
    ? ""
    : checkpoint.openLoops;
  let activeSession = null;
  const contextGapSessions = [];
  for (const item of sessions) {
    if (stats && item.status === "completed") stats.completedSessions += 1;
    if (!activeSession && item.status === "active") activeSession = item;
    const evidenceTime = timeOf(item.endedAt ?? item.startedAt);
    const unclosed = item.status === "active";
    const interrupted = item.status === "abandoned" && item.closeReason === "interrupted";
    if ((unclosed || interrupted) && evidenceTime > checkpointTime && item.checkpointId !== checkpoint?.id) contextGapSessions.push(item);
  }

  const summaryEvidence = newestEvidence(
    checkpoint?.summary ? evidence("checkpoint", "可靠检查点", checkpoint.summary, checkpoint.createdAt, checkpoint.id) : null,
    latestSummaryCrumb ? evidence("crumb", CRUMB_SOURCE_LABELS[latestSummaryCrumb.type], latestSummaryCrumb.text, latestSummaryCrumb.createdAt, latestSummaryCrumb.id) : null,
    project.description ? evidence("project", "项目说明", project.description, project.descriptionUpdatedAt ?? project.createdAt, project.id) : null
  );
  const nextActionEvidence = newestEvidence(
    checkpoint?.nextAction ? evidence("checkpoint", "可靠检查点", checkpoint.nextAction, checkpoint.createdAt, checkpoint.id) : null,
    latestNextCrumb ? evidence("crumb", "下一步记录", latestNextCrumb.text, latestNextCrumb.createdAt, latestNextCrumb.id) : null,
    project.nextAction ? evidence("project", "项目动作", project.nextAction, project.nextActionUpdatedAt ?? project.createdAt, project.id) : null
  );

  const summary = summaryEvidence?.text || "还没有留下状态摘要。";
  const nextAction = nextActionEvidence?.text || "先写下一个足够具体的下一步。";
  const returnHint = checkpoint?.returnHint || "先看最近轨迹，再开始一次短会话。";
  const completenessCount = Number(Boolean(summaryEvidence))
    + Number(Boolean(nextActionEvidence))
    + Number(Boolean(checkpoint?.returnHint))
    + Number(Boolean(checkpoint || projectCrumbs.length));
  const rawCompleteness = Math.round((completenessCount / 4) * 100);
  const confidenceCap = checkpoint?.captureMode === "quick" ? 50 : 100;
  const completeness = Math.max(0, Math.min(rawCompleteness, confidenceCap) - Math.min(contextGapSessions.length * 20, 40));
  const readinessGaps = [];
  if (contextGapSessions.length) readinessGaps.push(`核对 ${contextGapSessions.length} 段未收拢或中断的会话`);
  if (checkpoint?.captureMode === "quick") readinessGaps.push("复核快速停靠生成的低置信度检查点");
  if (!summaryEvidence) readinessGaps.push("补一条当前状态摘要");
  if (!nextActionEvidence) readinessGaps.push("明确一个可直接执行的下一动作");
  if (!checkpoint) readinessGaps.push("完成一次可靠检查点");
  else if (!checkpoint.returnHint) readinessGaps.push("写下材料入口或恢复提示");

  const card = {
    project,
    activeSession,
    checkpoint,
    lastActivityAt: activity.lastActivityAt,
    awayDays: daysSince(activity.lastActivityAt, now),
    summary,
    summaryEvidence,
    nextAction,
    nextActionEvidence,
    openLoops: checkpoint?.openLoops || joinCrumbTexts(unresolvedSignals),
    historicalOpenLoops,
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
  if (stats) card.stats = stats;
  return card;
}

export function rankProjectsForReentry(state, now = Date.now()) {
  const projectIds = [];
  for (const project of safeCollection(state?.projects)) {
    if (project.status !== "archived") projectIds.push(project.id);
  }
  return rankReentryCards(buildReentryCards(state, projectIds, now));
}

export function rankReentryCards(cards, limit = Number.POSITIVE_INFINITY) {
  const safeCards = Array.isArray(cards) ? cards : [];
  const safeLimit = limit === Number.POSITIVE_INFINITY
    ? Number.POSITIVE_INFINITY
    : Number.isSafeInteger(limit) && limit > 0 ? limit : 0;
  if (!safeLimit) return [];
  const selected = [];
  for (const card of safeCards) {
    if (!card?.project || card.project.status === "archived") continue;
    const entry = { card, score: reentryScore(card) };
    if (safeLimit === Number.POSITIVE_INFINITY) {
      selected.push(entry);
      continue;
    }
    if (selected.length < safeLimit) {
      pushWorstReentry(selected, entry);
      continue;
    }
    if (compareReentryEntry(entry, selected[0]) >= 0) continue;
    selected[0] = entry;
    sinkWorstReentry(selected, 0);
  }
  selected.sort(compareReentryEntry);
  const ranked = [];
  for (const entry of selected) {
    ranked.push({
      ...entry.card,
      recommendationScore: entry.score,
      recommendationReason: reentryReason(entry.card)
    });
  }
  return ranked;
}

function pushWorstReentry(heap, entry) {
  heap.push(entry);
  let index = heap.length - 1;
  while (index > 0) {
    const parent = Math.floor((index - 1) / 2);
    if (compareReentryEntry(heap[index], heap[parent]) <= 0) return;
    const previous = heap[parent];
    heap[parent] = heap[index];
    heap[index] = previous;
    index = parent;
  }
}

function sinkWorstReentry(heap, start) {
  let index = start;
  while (true) {
    const left = index * 2 + 1;
    if (left >= heap.length) return;
    const right = left + 1;
    let worse = left;
    if (right < heap.length && compareReentryEntry(heap[right], heap[left]) > 0) worse = right;
    if (compareReentryEntry(heap[worse], heap[index]) <= 0) return;
    const previous = heap[index];
    heap[index] = heap[worse];
    heap[worse] = previous;
    index = worse;
  }
}

function compareReentryEntry(left, right) {
  return right.score - left.score
    || timeOf(right.card.lastActivityAt) - timeOf(left.card.lastActivityAt)
    || compareCodeUnits(left.card.project.id, right.card.project.id);
}

function buildReentryIndex(state, projectIds = null) {
  const requested = projectIds === null ? null : new Set(projectIds);
  const projects = new Map();
  const sessions = new Map();
  const crumbs = new Map();
  const checkpoints = new Map();
  const lastActivity = new Map();

  for (const project of safeCollection(state?.projects)) {
    if (requested && !requested.has(project.id)) continue;
    projects.set(project.id, project);
    lastActivity.set(project.id, newestDate(project.updatedAt, project.lastOpenedAt, project.createdAt));
  }
  indexRecords(safeCollection(state?.sessions), sessions, projects, lastActivity, (item) => item.resolvedAt ?? item.endedAt ?? item.createdAt ?? item.startedAt);
  indexRecords(safeCollection(state?.crumbs), crumbs, projects, lastActivity, (item) => item.resolvedAt ?? item.endedAt ?? item.createdAt ?? item.startedAt);
  indexRecords(safeCollection(state?.checkpoints), checkpoints, projects, lastActivity, (item) => item.resolvedAt ?? item.endedAt ?? item.createdAt ?? item.startedAt);

  sortIndexedRecords(crumbs, (item) => item.createdAt);
  sortIndexedRecords(checkpoints, (item) => item.createdAt);
  sortIndexedRecords(sessions, (item) => item.startedAt);
  return { projects, sessions, crumbs, checkpoints, lastActivity };
}

function sortIndexedRecords(index, dateOf) {
  for (const items of index.values()) {
    items.reverse().sort((left, right) => timeOf(dateOf(right)) - timeOf(dateOf(left)));
  }
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

function newestDate(first, second, third) {
  let newest = null;
  if (first && timeOf(first) > timeOf(newest)) newest = first;
  if (second && timeOf(second) > timeOf(newest)) newest = second;
  if (third && timeOf(third) > timeOf(newest)) newest = third;
  return newest;
}

function safeCollection(value) {
  return Array.isArray(value) ? value : [];
}

export function getProjectStats(state, projectId) {
  const stats = { sessions: 0, completedSessions: 0, crumbs: 0, decisions: 0, blockers: 0, checkpoints: 0 };
  for (const session of safeCollection(state?.sessions)) {
    if (session.projectId !== projectId) continue;
    stats.sessions += 1;
    if (session.status === "completed") stats.completedSessions += 1;
  }
  for (const crumb of safeCollection(state?.crumbs)) {
    if (crumb.projectId !== projectId) continue;
    stats.crumbs += 1;
    if (crumb.type === "decision") stats.decisions += 1;
    if (crumb.type === "blocker") stats.blockers += 1;
  }
  for (const checkpoint of safeCollection(state?.checkpoints)) {
    if (checkpoint.projectId === projectId) stats.checkpoints += 1;
  }
  return stats;
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

function newestEvidence(first, second, third) {
  let newest = first ?? null;
  if (second && timeOf(second.createdAt) > timeOf(newest?.createdAt)) newest = second;
  if (third && timeOf(third.createdAt) > timeOf(newest?.createdAt)) newest = third;
  return newest;
}

function joinCrumbTexts(crumbs) {
  let result = "";
  for (const crumb of crumbs) result += `${result ? "；" : ""}${crumb.text}`;
  return result;
}

function timeOf(value) {
  const valueOf = Date.parse(value ?? "");
  return Number.isFinite(valueOf) ? valueOf : 0;
}

function compareCodeUnits(left, right) {
  return left === right ? 0 : left < right ? -1 : 1;
}
