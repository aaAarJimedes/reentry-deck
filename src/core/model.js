export const SCHEMA_VERSION = 1;

export const PROJECT_STATUSES = Object.freeze(["active", "paused", "blocked", "archived"]);
export const CRUMB_TYPES = Object.freeze(["note", "discovery", "decision", "question", "blocker", "next"]);
export const SESSION_STATUSES = Object.freeze(["active", "completed", "abandoned"]);
export const SESSION_CLOSE_REASONS = Object.freeze(["checkpoint", "quick-dock", "interrupted"]);
export const CHECKPOINT_CAPTURE_MODES = Object.freeze(["manual", "quick"]);

const COLOR_PALETTE = ["fern", "amber", "clay", "sky", "plum", "slate"];

export function makeId(prefix = "item") {
  const randomPart = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}_${randomPart}`;
}

export function isoNow(now = Date.now()) {
  return new Date(now).toISOString();
}

export function createEmptyState(now = Date.now()) {
  const timestamp = isoNow(now);
  return {
    schemaVersion: SCHEMA_VERSION,
    meta: {
      createdAt: timestamp,
      updatedAt: timestamp,
      revision: 0
    },
    settings: {
      theme: "system",
      staleAfterDays: 7,
      reducedMotion: false
    },
    projects: [],
    sessions: [],
    crumbs: [],
    checkpoints: [],
    ui: {
      selectedProjectId: null
    }
  };
}

export function createProject(input = {}, now = Date.now()) {
  const timestamp = isoNow(now);
  return {
    id: input.id ?? makeId("project"),
    title: cleanText(input.title) || "未命名项目",
    description: cleanText(input.description),
    nextAction: cleanText(input.nextAction),
    color: COLOR_PALETTE.includes(input.color) ? input.color : COLOR_PALETTE[0],
    status: PROJECT_STATUSES.includes(input.status) ? input.status : "active",
    createdAt: input.createdAt ?? timestamp,
    updatedAt: input.updatedAt ?? timestamp,
    lastOpenedAt: input.lastOpenedAt ?? timestamp,
    archivedAt: input.archivedAt ?? null
  };
}

export function createSession(input = {}, now = Date.now()) {
  const timestamp = isoNow(now);
  return {
    id: input.id ?? makeId("session"),
    projectId: input.projectId,
    intention: cleanText(input.intention),
    status: SESSION_STATUSES.includes(input.status) ? input.status : "active",
    startedAt: input.startedAt ?? timestamp,
    endedAt: input.endedAt ?? null,
    checkpointId: input.checkpointId ?? null,
    sourceCheckpointId: input.sourceCheckpointId ?? null,
    closeReason: SESSION_CLOSE_REASONS.includes(input.closeReason) ? input.closeReason : null
  };
}

export function createCrumb(input = {}, now = Date.now()) {
  return {
    id: input.id ?? makeId("crumb"),
    projectId: input.projectId,
    sessionId: input.sessionId ?? null,
    type: CRUMB_TYPES.includes(input.type) ? input.type : "note",
    text: cleanText(input.text),
    pinned: Boolean(input.pinned),
    createdAt: input.createdAt ?? isoNow(now)
  };
}

export function createCheckpoint(input = {}, now = Date.now()) {
  return {
    id: input.id ?? makeId("checkpoint"),
    projectId: input.projectId,
    sessionId: input.sessionId ?? null,
    summary: cleanText(input.summary),
    nextAction: cleanText(input.nextAction),
    openLoops: cleanText(input.openLoops),
    returnHint: cleanText(input.returnHint),
    captureMode: CHECKPOINT_CAPTURE_MODES.includes(input.captureMode) ? input.captureMode : "manual",
    createdAt: input.createdAt ?? isoNow(now)
  };
}

export function normalizeState(value, now = Date.now()) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("备份内容不是有效的数据对象。 ");
  }

  const base = createEmptyState(now);
  const version = Number(value.schemaVersion ?? 1);
  if (version > SCHEMA_VERSION) {
    throw new RangeError(`这份数据来自更新版本（v${version}），当前程序无法安全读取。`);
  }

  const projects = arrayOf(value.projects).map((item) => createProject(item, now));
  const projectIds = new Set(projects.map((item) => item.id));
  const sessions = arrayOf(value.sessions)
    .filter((item) => item?.projectId && projectIds.has(item.projectId))
    .map((item) => createSession(item, now));
  const sessionIds = new Set(sessions.map((item) => item.id));

  return {
    ...base,
    schemaVersion: SCHEMA_VERSION,
    meta: {
      ...base.meta,
      ...(isObject(value.meta) ? value.meta : {}),
      revision: safeInteger(value.meta?.revision, 0)
    },
    settings: {
      ...base.settings,
      ...(isObject(value.settings) ? value.settings : {})
    },
    projects,
    sessions,
    crumbs: arrayOf(value.crumbs)
      .filter((item) => item?.projectId && projectIds.has(item.projectId))
      .map((item) => createCrumb({ ...item, sessionId: sessionIds.has(item.sessionId) ? item.sessionId : null }, now)),
    checkpoints: arrayOf(value.checkpoints)
      .filter((item) => item?.projectId && projectIds.has(item.projectId))
      .map((item) => createCheckpoint({ ...item, sessionId: sessionIds.has(item.sessionId) ? item.sessionId : null }, now)),
    ui: {
      selectedProjectId: projectIds.has(value.ui?.selectedProjectId) ? value.ui.selectedProjectId : null
    }
  };
}

export function validateState(state) {
  const errors = [];
  if (!state || typeof state !== "object") errors.push("根数据缺失");
  if (!Array.isArray(state?.projects)) errors.push("项目列表无效");
  if (!Array.isArray(state?.sessions)) errors.push("会话列表无效");
  if (!Array.isArray(state?.crumbs)) errors.push("面包屑列表无效");
  if (!Array.isArray(state?.checkpoints)) errors.push("检查点列表无效");

  const ids = new Set();
  for (const collection of [state?.projects, state?.sessions, state?.crumbs, state?.checkpoints]) {
    if (!Array.isArray(collection)) continue;
    for (const item of collection) {
      if (!item?.id) errors.push("存在缺少 ID 的记录");
      else if (ids.has(item.id)) errors.push(`记录 ID 重复：${item.id}`);
      else ids.add(item.id);
    }
  }
  if (Array.isArray(state?.sessions) && state.sessions.filter((item) => item?.status === "active").length > 1) {
    errors.push("同一时间只能有一个活动会话");
  }
  return errors;
}

export function validateImportCandidate(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return ["备份根数据必须是对象"];
  const errors = validateState(value);
  if (errors.length) return errors;

  const projectIds = new Set(value.projects.map((item) => item?.id));
  const sessionIds = new Set(value.sessions.map((item) => item?.id));
  const checkpointIds = new Set(value.checkpoints.map((item) => item?.id));
  const projectsById = new Map(value.projects.map((item) => [item?.id, item]));
  for (const project of value.projects) {
    if (typeof project?.id !== "string" || !project.id) errors.push("存在无效的项目 ID");
    if (project?.status !== undefined && !PROJECT_STATUSES.includes(project.status)) errors.push(`项目状态无效：${project.status}`);
  }
  for (const session of value.sessions) {
    if (typeof session?.id !== "string" || !session.id) errors.push("存在无效的会话 ID");
    if (!projectIds.has(session?.projectId)) errors.push(`会话引用了不存在的项目：${session?.id ?? "未知"}`);
    if (session?.status !== undefined && !SESSION_STATUSES.includes(session.status)) errors.push(`会话状态无效：${session.status}`);
    if (session?.closeReason && !SESSION_CLOSE_REASONS.includes(session.closeReason)) errors.push(`会话关闭原因无效：${session.closeReason}`);
    if (session?.checkpointId && !checkpointIds.has(session.checkpointId)) errors.push(`会话引用了不存在的检查点：${session.id ?? "未知"}`);
    if (session?.sourceCheckpointId && !checkpointIds.has(session.sourceCheckpointId)) errors.push(`会话来源检查点不存在：${session.id ?? "未知"}`);
    if (session?.status === "active" && session?.endedAt) errors.push(`活动会话不能包含结束时间：${session.id ?? "未知"}`);
    if (session?.status === "active" && projectsById.get(session.projectId)?.status === "archived") errors.push(`归档项目不能包含活动会话：${session.id ?? "未知"}`);
  }
  for (const crumb of value.crumbs) {
    if (typeof crumb?.id !== "string" || !crumb.id) errors.push("存在无效的面包屑 ID");
    if (!projectIds.has(crumb?.projectId)) errors.push(`面包屑引用了不存在的项目：${crumb?.id ?? "未知"}`);
    if (crumb?.sessionId && !sessionIds.has(crumb.sessionId)) errors.push(`面包屑引用了不存在的会话：${crumb.id ?? "未知"}`);
    if (crumb?.type !== undefined && !CRUMB_TYPES.includes(crumb.type)) errors.push(`面包屑类型无效：${crumb.type}`);
  }
  for (const checkpoint of value.checkpoints) {
    if (typeof checkpoint?.id !== "string" || !checkpoint.id) errors.push("存在无效的检查点 ID");
    if (!projectIds.has(checkpoint?.projectId)) errors.push(`检查点引用了不存在的项目：${checkpoint?.id ?? "未知"}`);
    if (checkpoint?.sessionId && !sessionIds.has(checkpoint.sessionId)) errors.push(`检查点引用了不存在的会话：${checkpoint.id ?? "未知"}`);
    if (checkpoint?.captureMode && !CHECKPOINT_CAPTURE_MODES.includes(checkpoint.captureMode)) errors.push(`检查点采集方式无效：${checkpoint.captureMode}`);
  }
  return [...new Set(errors)];
}

function cleanText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function arrayOf(value) {
  return Array.isArray(value) ? value : [];
}

function isObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function safeInteger(value, fallback) {
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}
