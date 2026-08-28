import { IMPORT_LIMITS, compactText, createCheckpoint, isoAtOrAfter } from "./model.js";

export const DEFAULT_SESSION_STALE_AFTER_MS = 12 * 60 * 60 * 1000;

export const QUICK_DOCK_NOT_RECORDED = Object.freeze({
  summary: "本次会话状态未记录。",
  nextAction: "下一步行动未记录。",
  openLoops: "未解决的问题或阻塞未记录。"
});

export const QUICK_DOCK_RETURN_HINT = "这是快速停靠生成的低置信度检查点；回来后先核对最近轨迹。";

const SUBSTANTIVE_CRUMB_TYPES = new Set(["note", "discovery", "decision"]);
const OPEN_LOOP_CRUMB_TYPES = new Set(["question", "blocker"]);
const OPEN_LOOP_EVIDENCE_LIMIT = Math.floor(IMPORT_LIMITS.openLoops / 2) + 1;

export function isActiveSession(session) {
  return session?.status === "active";
}

export function inspectSession(session, now = Date.now(), options = {}) {
  const active = isActiveSession(session);
  if (!active) {
    return {
      active: false,
      stale: false,
      staleReasons: [],
      ageMs: null
    };
  }

  const nowTimestamp = requireTimestamp(now, "当前时间");
  const staleAfterMs = normalizeStaleAfterMs(options.staleAfterMs);
  const startedTimestamp = toTimestamp(session.startedAt);

  if (!Number.isFinite(startedTimestamp)) {
    return {
      active: true,
      stale: true,
      staleReasons: ["invalid-started-at"],
      ageMs: null
    };
  }

  const ageMs = Math.max(0, nowTimestamp - startedTimestamp);
  const staleReasons = [];
  if (nowTimestamp - startedTimestamp > staleAfterMs) staleReasons.push("elapsed");
  if (!isSameLocalCalendarDay(startedTimestamp, nowTimestamp)) staleReasons.push("calendar-day");

  return {
    active: true,
    stale: staleReasons.length > 0,
    staleReasons,
    ageMs
  };
}

export function isSessionStale(session, now = Date.now(), options = {}) {
  return inspectSession(session, now, options).stale;
}

export function inspectActiveSessionInvariant(state, now = Date.now(), options = {}) {
  if (!Array.isArray(state?.sessions)) {
    return {
      ok: false,
      activeSession: null,
      activeSessions: [],
      staleSessions: [],
      violations: ["会话列表无效。"]
    };
  }

  const activeSessions = [];
  const staleSessions = [];
  for (const session of state.sessions) {
    if (!isActiveSession(session)) continue;
    activeSessions.push(session);
    if (isSessionStale(session, now, options)) staleSessions.push(session);
  }
  const hasConflict = activeSessions.length > 1;

  return {
    ok: !hasConflict,
    activeSession: activeSessions.length === 1 ? activeSessions[0] : null,
    activeSessions,
    staleSessions,
    violations: hasConflict ? [`检测到 ${activeSessions.length} 个活动会话；系统只允许一个。`] : []
  };
}

export function assertSingleActiveSession(state, now = Date.now(), options = {}) {
  const inspection = inspectActiveSessionInvariant(state, now, options);
  if (!inspection.ok) {
    throw new Error(inspection.violations.join(" "));
  }
  return inspection.activeSession;
}

export function deriveQuickDockCheckpointInput(state, sessionId, now = Date.now(), options = {}) {
  const activeSession = assertSingleActiveSession(state, now, options);
  if (!activeSession) throw new Error("没有可快速停靠的活动会话。");
  if (sessionId != null && sessionId !== activeSession.id) {
    throw new Error("指定会话不是当前唯一活动会话。");
  }

  const project = findById(arrayOf(state.projects), activeSession.projectId);
  if (!project) throw new Error("活动会话关联的项目不存在，无法生成快速停靠检查点。");

  let summaryCrumb = null;
  let summaryTimestamp = Number.NaN;
  let summaryIndex = -1;
  let nextCrumb = null;
  let nextTimestamp = Number.NaN;
  let nextIndex = -1;
  const openLoops = [];
  const crumbs = arrayOf(state.crumbs);
  for (let index = 0; index < crumbs.length; index += 1) {
    const crumb = crumbs[index];
    if (crumb?.sessionId !== activeSession.id || crumb?.projectId !== project.id) continue;
    const text = cleanText(crumb.text);
    if (!text) continue;
    const timestamp = toTimestamp(crumb.createdAt);
    if (SUBSTANTIVE_CRUMB_TYPES.has(crumb.type)
      && compareEvidencePosition(timestamp, index, summaryTimestamp, summaryIndex) < 0) {
      summaryCrumb = crumb;
      summaryTimestamp = timestamp;
      summaryIndex = index;
    }
    if (crumb.type === "next" && compareEvidencePosition(timestamp, index, nextTimestamp, nextIndex) < 0) {
      nextCrumb = crumb;
      nextTimestamp = timestamp;
      nextIndex = index;
    }
    if (OPEN_LOOP_CRUMB_TYPES.has(crumb.type) && !crumb.resolvedAt) {
      retainNewestOpenLoop(openLoops, { text, timestamp, index });
    }
  }

  return {
    projectId: project.id,
    sessionId: activeSession.id,
    summary: compactText(summaryCrumb?.text, IMPORT_LIMITS.checkpointSummary) || QUICK_DOCK_NOT_RECORDED.summary,
    nextAction: compactText(nextCrumb?.text, IMPORT_LIMITS.nextAction) || compactText(project.nextAction, IMPORT_LIMITS.nextAction) || QUICK_DOCK_NOT_RECORDED.nextAction,
    openLoops: compactText(joinNewestOpenLoops(openLoops), IMPORT_LIMITS.openLoops) || QUICK_DOCK_NOT_RECORDED.openLoops,
    returnHint: QUICK_DOCK_RETURN_HINT,
    captureMode: "quick"
  };
}

export function prepareQuickCheckpointReview(state, input = {}, now = Date.now()) {
  const project = findById(arrayOf(state?.projects), input.projectId);
  if (!project || project.status === "archived") throw new Error("项目不可用，无法复核快速检查点。");
  let latestCheckpoint = null;
  let latestTimestamp = Number.NaN;
  let latestIndex = -1;
  const checkpoints = arrayOf(state?.checkpoints);
  for (let index = 0; index < checkpoints.length; index += 1) {
    const item = checkpoints[index];
    if (item?.projectId !== project.id) continue;
    const timestamp = toTimestamp(item.createdAt);
    if (compareEvidencePosition(timestamp, index, latestTimestamp, latestIndex) >= 0) continue;
    latestCheckpoint = item;
    latestTimestamp = timestamp;
    latestIndex = index;
  }
  if (!latestCheckpoint || latestCheckpoint.captureMode !== "quick") {
    throw new Error("最新检查点已不是待复核的快速停靠记录。");
  }
  if (input.sourceCheckpointId !== latestCheckpoint.id) {
    throw new Error("快速检查点在复核期间发生了变化，请重新打开表单。");
  }
  const summary = cleanText(input.summary);
  const nextAction = cleanText(input.nextAction);
  if (!summary || summary === QUICK_DOCK_NOT_RECORDED.summary) throw new Error("请补充真实的当前状态摘要。");
  if (!nextAction || nextAction === QUICK_DOCK_NOT_RECORDED.nextAction) throw new Error("请补充可直接执行的下一动作。");
  requireTextLimit(summary, IMPORT_LIMITS.checkpointSummary, "当前状态摘要");
  requireTextLimit(nextAction, IMPORT_LIMITS.nextAction, "下一动作");
  requireTextLimit(input.openLoops, IMPORT_LIMITS.openLoops, "未决事项");
  requireTextLimit(input.returnHint, IMPORT_LIMITS.returnHint, "恢复提示");
  const checkpoint = createCheckpoint({
    projectId: project.id,
    sessionId: null,
    summary,
    nextAction,
    openLoops: cleanText(input.openLoops),
    returnHint: cleanText(input.returnHint),
    captureMode: "manual"
  }, isoAtOrAfter(now, project.updatedAt, latestCheckpoint.createdAt));
  return { checkpoint, projectTitle: project.title, sourceCheckpointId: latestCheckpoint.id };
}

function retainNewestOpenLoop(heap, entry) {
  if (heap.length < OPEN_LOOP_EVIDENCE_LIMIT) {
    heap.push(entry);
    bubbleWorstOpenLoop(heap, heap.length - 1);
    return;
  }
  if (compareDatedEntries(entry, heap[0]) >= 0) return;
  heap[0] = entry;
  sinkWorstOpenLoop(heap, 0);
}

function bubbleWorstOpenLoop(heap, start) {
  let index = start;
  while (index > 0) {
    const parent = Math.floor((index - 1) / 2);
    if (compareDatedEntries(heap[index], heap[parent]) <= 0) return;
    const previous = heap[parent];
    heap[parent] = heap[index];
    heap[index] = previous;
    index = parent;
  }
}

function sinkWorstOpenLoop(heap, start) {
  let index = start;
  while (true) {
    const left = index * 2 + 1;
    if (left >= heap.length) return;
    const right = left + 1;
    let worse = left;
    if (right < heap.length && compareDatedEntries(heap[right], heap[left]) > 0) worse = right;
    if (compareDatedEntries(heap[worse], heap[index]) <= 0) return;
    const previous = heap[index];
    heap[index] = heap[worse];
    heap[worse] = previous;
    index = worse;
  }
}

function joinNewestOpenLoops(entries) {
  entries.sort(compareDatedEntries);
  let result = "";
  for (const entry of entries) {
    result += `${result ? "；" : ""}${entry.text}`;
    if (result.length > IMPORT_LIMITS.openLoops) break;
  }
  return result;
}

function compareDatedEntries(left, right) {
  return compareEvidencePosition(left.timestamp, left.index, right.timestamp, right.index);
}

function compareEvidencePosition(leftTimestamp, leftIndex, rightTimestamp, rightIndex) {
  const left = Number.isFinite(leftTimestamp) ? leftTimestamp : Number.NEGATIVE_INFINITY;
  const right = Number.isFinite(rightTimestamp) ? rightTimestamp : Number.NEGATIVE_INFINITY;
  return right - left || rightIndex - leftIndex;
}

function findById(items, id) {
  for (const item of items) {
    if (item?.id === id) return item;
  }
  return null;
}

function isSameLocalCalendarDay(leftTimestamp, rightTimestamp) {
  const left = new Date(leftTimestamp);
  const right = new Date(rightTimestamp);
  return left.getFullYear() === right.getFullYear()
    && left.getMonth() === right.getMonth()
    && left.getDate() === right.getDate();
}

function normalizeStaleAfterMs(value) {
  if (value == null) return DEFAULT_SESSION_STALE_AFTER_MS;
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError("会话过期时长必须是非负有限毫秒数。");
  }
  return value;
}

function requireTimestamp(value, label) {
  const timestamp = toTimestamp(value);
  if (!Number.isFinite(timestamp)) throw new TypeError(`${label}无效。`);
  return timestamp;
}

function toTimestamp(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim()) return new Date(value).getTime();
  return Number.NaN;
}

function cleanText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function requireTextLimit(value, maximum, label) {
  if (cleanText(value).length > maximum) throw new Error(`${label}不能超过 ${maximum} 字符。`);
}

function arrayOf(value) {
  return Array.isArray(value) ? value : [];
}
