export const SCHEMA_VERSION = 1;

export const PROJECT_STATUSES = Object.freeze(["active", "paused", "blocked", "archived"]);
export const CRUMB_TYPES = Object.freeze(["note", "discovery", "decision", "question", "blocker", "next"]);
export const SESSION_STATUSES = Object.freeze(["active", "completed", "abandoned"]);

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
    checkpointId: input.checkpointId ?? null
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
  return errors;
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
