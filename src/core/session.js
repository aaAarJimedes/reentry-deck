import { createCheckpoint, isoAtOrAfter } from "./model.js";

export const DEFAULT_SESSION_STALE_AFTER_MS = 12 * 60 * 60 * 1000;

export const QUICK_DOCK_NOT_RECORDED = Object.freeze({
  summary: "本次会话状态未记录。",
  nextAction: "下一步行动未记录。",
  openLoops: "未解决的问题或阻塞未记录。"
});

export const QUICK_DOCK_RETURN_HINT = "这是快速停靠生成的低置信度检查点；回来后先核对最近轨迹。";

const SUBSTANTIVE_CRUMB_TYPES = new Set(["note", "discovery", "decision"]);
const OPEN_LOOP_CRUMB_TYPES = new Set(["question", "blocker"]);

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

  const activeSessions = state.sessions.filter(isActiveSession);
  const staleSessions = activeSessions.filter((session) => isSessionStale(session, now, options));
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

  const project = arrayOf(state.projects).find((item) => item?.id === activeSession.projectId);
  if (!project) throw new Error("活动会话关联的项目不存在，无法生成快速停靠检查点。");

  const currentSessionCrumbs = newestFirst(
    arrayOf(state.crumbs).filter((crumb) => (
      crumb?.sessionId === activeSession.id
      && crumb?.projectId === project.id
      && cleanText(crumb.text)
    ))
  );
  const summaryCrumb = currentSessionCrumbs.find((crumb) => SUBSTANTIVE_CRUMB_TYPES.has(crumb.type));
  const nextCrumb = currentSessionCrumbs.find((crumb) => crumb.type === "next");
  const openLoopTexts = currentSessionCrumbs
    .filter((crumb) => OPEN_LOOP_CRUMB_TYPES.has(crumb.type))
    .map((crumb) => cleanText(crumb.text));

  return {
    projectId: project.id,
    sessionId: activeSession.id,
    summary: cleanText(summaryCrumb?.text) || QUICK_DOCK_NOT_RECORDED.summary,
    nextAction: cleanText(nextCrumb?.text) || cleanText(project.nextAction) || QUICK_DOCK_NOT_RECORDED.nextAction,
    openLoops: openLoopTexts.join("；") || QUICK_DOCK_NOT_RECORDED.openLoops,
    returnHint: QUICK_DOCK_RETURN_HINT,
    captureMode: "quick"
  };
}

export function prepareQuickCheckpointReview(state, input = {}, now = Date.now()) {
  const project = arrayOf(state?.projects).find((item) => item?.id === input.projectId);
  if (!project || project.status === "archived") throw new Error("项目不可用，无法复核快速检查点。");
  const latestCheckpoint = newestFirst(
    arrayOf(state?.checkpoints).filter((item) => item?.projectId === project.id)
  )[0];
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

function newestFirst(items) {
  return items
    .map((item, index) => ({ item, index, timestamp: toTimestamp(item.createdAt) }))
    .sort((a, b) => {
      const aTimestamp = Number.isFinite(a.timestamp) ? a.timestamp : Number.NEGATIVE_INFINITY;
      const bTimestamp = Number.isFinite(b.timestamp) ? b.timestamp : Number.NEGATIVE_INFINITY;
      return bTimestamp - aTimestamp || b.index - a.index;
    })
    .map(({ item }) => item);
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

function arrayOf(value) {
  return Array.isArray(value) ? value : [];
}
