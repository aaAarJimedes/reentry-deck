export const SCHEMA_VERSION = 1;

export const PROJECT_STATUSES = Object.freeze(["active", "paused", "blocked", "archived"]);
export const CRUMB_TYPES = Object.freeze(["note", "discovery", "decision", "question", "blocker", "next"]);
export const SESSION_STATUSES = Object.freeze(["active", "completed", "abandoned"]);
export const SESSION_CLOSE_REASONS = Object.freeze(["checkpoint", "quick-dock", "interrupted"]);
export const CHECKPOINT_CAPTURE_MODES = Object.freeze(["manual", "quick"]);

const COLOR_PALETTE = ["fern", "amber", "clay", "sky", "plum", "slate"];
const UNSAFE_TEXT_CONTROL_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200b\u200e\u200f\u202a-\u202e\u2060-\u206f\ufeff]/u;
const UNSAFE_ID_CONTROL_PATTERN = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/u;

export const IMPORT_LIMITS = Object.freeze({
  records: 50_000,
  id: 200,
  projectTitle: 100,
  projectDescription: 800,
  nextAction: 600,
  sessionIntention: 600,
  crumbText: 1_200,
  checkpointSummary: 1_200,
  openLoops: 800,
  returnHint: 400,
  reportedErrors: 50
});

export function makeId(prefix = "item") {
  const randomPart = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}_${randomPart}`;
}

export function isoNow(now = Date.now()) {
  return new Date(now).toISOString();
}

export function isoAtOrAfter(now = Date.now(), ...anchors) {
  let timestamp = new Date(now).getTime();
  if (!Number.isFinite(timestamp)) throw new RangeError("无法生成有效时间。 ");
  for (const anchor of anchors) {
    const parsed = Date.parse(anchor ?? "");
    if (Number.isFinite(parsed)) timestamp = Math.max(timestamp, parsed);
  }
  return new Date(timestamp).toISOString();
}

export function compactText(value, maximum) {
  const text = cleanText(value);
  if (!Number.isSafeInteger(maximum) || maximum < 1) return "";
  if (text.length <= maximum) return text;
  if (maximum === 1) return "…";
  let prefix = "";
  for (const character of text) {
    if (prefix.length + character.length > maximum - 1) break;
    prefix += character;
  }
  return `${prefix.trimEnd()}…`;
}

export function containsUnsafeTextControl(value) {
  return typeof value === "string" && UNSAFE_TEXT_CONTROL_PATTERN.test(value);
}

export function containsUnsafeIdControl(value) {
  return typeof value === "string" && UNSAFE_ID_CONTROL_PATTERN.test(value);
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
  const description = cleanText(input.description);
  const nextAction = cleanText(input.nextAction);
  return {
    id: input.id ?? makeId("project"),
    title: cleanText(input.title) || "未命名项目",
    description,
    descriptionUpdatedAt: input.descriptionUpdatedAt ?? (description ? input.updatedAt ?? timestamp : null),
    nextAction,
    nextActionUpdatedAt: input.nextActionUpdatedAt ?? (nextAction ? input.updatedAt ?? timestamp : null),
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
    resolvedAt: input.resolvedAt ?? null,
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

  const collections = [state?.projects, state?.sessions, state?.crumbs, state?.checkpoints];
  const recordCount = collections.reduce((total, collection) => total + (Array.isArray(collection) ? collection.length : 0), 0);
  if (recordCount > IMPORT_LIMITS.records) {
    return [`工作区包含 ${recordCount} 条记录，超过 ${IMPORT_LIMITS.records} 条安全上限`];
  }

  const ids = new Set();
  for (const collection of collections) {
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
  if (Array.isArray(state?.crumbs)) {
    for (const crumb of state.crumbs) {
      if (crumb?.resolvedAt && !["question", "blocker"].includes(crumb.type)) errors.push(`只有问题或阻塞可以标记为已解决：${crumb.id ?? "未知"}`);
      if (crumb?.resolvedAt && !isValidDate(crumb.resolvedAt)) errors.push(`面包屑解决时间无效：${crumb.id ?? "未知"}`);
    }
  }
  return errors;
}

export function validateImportCandidate(value) {
  if (!isObject(value)) return ["备份根数据必须是普通对象"];
  const collections = [value.projects, value.sessions, value.crumbs, value.checkpoints];
  const recordCount = collections.reduce((total, collection) => total + (Array.isArray(collection) ? collection.length : 0), 0);
  if (recordCount > IMPORT_LIMITS.records) return [`备份包含 ${recordCount} 条记录，超过 ${IMPORT_LIMITS.records} 条安全上限`];
  const errors = validateState(value);
  if (errors.length) return errors;

  if (value.schemaVersion !== undefined && (!Number.isSafeInteger(value.schemaVersion) || value.schemaVersion < 1)) {
    addImportError(errors, "数据版本号无效");
  }
  validateMetadata(errors, value.meta);
  validateSettings(errors, value.settings);

  const projectIds = new Set(value.projects.map((item) => item?.id));
  const sessionIds = new Set(value.sessions.map((item) => item?.id));
  const checkpointIds = new Set(value.checkpoints.map((item) => item?.id));
  const sessionsById = new Map(value.sessions.map((item) => [item?.id, item]));
  const checkpointsById = new Map(value.checkpoints.map((item) => [item?.id, item]));
  const projectsById = new Map(value.projects.map((item) => [item?.id, item]));
  for (const project of value.projects) {
    if (!isObject(project)) {
      addImportError(errors, "项目记录必须是普通对象");
      continue;
    }
    if (typeof project?.id !== "string" || !project.id) addImportError(errors, "存在无效的项目 ID");
    else validateImportId(errors, project.id, "项目");
    if (project?.status !== undefined && !PROJECT_STATUSES.includes(project.status)) addImportError(errors, `项目状态无效：${project.status}`);
    if (project?.color !== undefined && !COLOR_PALETTE.includes(project.color)) addImportError(errors, `项目颜色无效：${project.color}`);
    validateText(errors, project, "title", "项目名称", IMPORT_LIMITS.projectTitle);
    validateText(errors, project, "description", "项目说明", IMPORT_LIMITS.projectDescription);
    validateText(errors, project, "nextAction", "项目下一步", IMPORT_LIMITS.nextAction);
    validateDates(errors, project, ["createdAt", "updatedAt", "lastOpenedAt", "archivedAt", "descriptionUpdatedAt", "nextActionUpdatedAt"], "项目", project.id);
    if (isValidDate(project?.createdAt) && isValidDate(project?.updatedAt) && Date.parse(project.updatedAt) < Date.parse(project.createdAt)) {
      addImportError(errors, `项目更新时间早于创建时间：${project.id ?? "未知"}`);
    }
    for (const field of ["lastOpenedAt", "archivedAt", "descriptionUpdatedAt", "nextActionUpdatedAt"]) {
      validateProjectDateWindow(errors, project, field);
    }
  }
  for (const session of value.sessions) {
    if (!isObject(session)) {
      addImportError(errors, "会话记录必须是普通对象");
      continue;
    }
    if (typeof session?.id !== "string" || !session.id) addImportError(errors, "存在无效的会话 ID");
    else validateImportId(errors, session.id, "会话");
    if (!projectIds.has(session?.projectId)) addImportError(errors, `会话引用了不存在的项目：${session?.id ?? "未知"}`);
    if (session?.status !== undefined && !SESSION_STATUSES.includes(session.status)) addImportError(errors, `会话状态无效：${session.status}`);
    if (session?.closeReason && !SESSION_CLOSE_REASONS.includes(session.closeReason)) addImportError(errors, `会话关闭原因无效：${session.closeReason}`);
    if (session?.checkpointId && !checkpointIds.has(session.checkpointId)) addImportError(errors, `会话引用了不存在的检查点：${session.id ?? "未知"}`);
    if (session?.sourceCheckpointId && !checkpointIds.has(session.sourceCheckpointId)) addImportError(errors, `会话来源检查点不存在：${session.id ?? "未知"}`);
    if (session?.checkpointId && checkpointIds.has(session.checkpointId) && checkpointsById.get(session.checkpointId)?.projectId !== session.projectId) addImportError(errors, `会话结束检查点属于其他项目：${session.id ?? "未知"}`);
    if (session?.checkpointId && checkpointIds.has(session.checkpointId) && checkpointsById.get(session.checkpointId)?.sessionId && checkpointsById.get(session.checkpointId).sessionId !== session.id) addImportError(errors, `会话结束检查点属于其他会话：${session.id ?? "未知"}`);
    if (session?.sourceCheckpointId && checkpointIds.has(session.sourceCheckpointId) && checkpointsById.get(session.sourceCheckpointId)?.projectId !== session.projectId) addImportError(errors, `会话来源检查点属于其他项目：${session.id ?? "未知"}`);
    if (session?.status === "active" && session?.endedAt) addImportError(errors, `活动会话不能包含结束时间：${session.id ?? "未知"}`);
    if (session?.status === "active" && projectsById.get(session.projectId)?.status === "archived") addImportError(errors, `归档项目不能包含活动会话：${session.id ?? "未知"}`);
    validateText(errors, session, "intention", "会话意图", IMPORT_LIMITS.sessionIntention);
    validateDates(errors, session, ["startedAt", "endedAt"], "会话", session.id);
    validateRecordProjectWindow(errors, session, ["startedAt", "endedAt"], "会话", projectsById.get(session?.projectId));
    if (isValidDate(session?.startedAt) && isValidDate(session?.endedAt) && Date.parse(session.endedAt) < Date.parse(session.startedAt)) {
      addImportError(errors, `会话结束时间早于开始时间：${session.id ?? "未知"}`);
    }
    if (session?.status === "active" && session?.checkpointId) {
      addImportError(errors, `活动会话不能包含结束检查点：${session.id ?? "未知"}`);
    }
    const sourceCheckpoint = checkpointsById.get(session?.sourceCheckpointId);
    if (sourceCheckpoint && isValidDate(sourceCheckpoint.createdAt) && isValidDate(session?.startedAt) && Date.parse(sourceCheckpoint.createdAt) > Date.parse(session.startedAt)) {
      addImportError(errors, `会话开始时间早于来源检查点：${session.id ?? "未知"}`);
    }
    const endingCheckpoint = checkpointsById.get(session?.checkpointId);
    if (endingCheckpoint && isValidDate(endingCheckpoint.createdAt) && isValidDate(session?.startedAt) && Date.parse(endingCheckpoint.createdAt) < Date.parse(session.startedAt)) {
      addImportError(errors, `会话结束检查点早于会话开始：${session.id ?? "未知"}`);
    }
    if (endingCheckpoint && isValidDate(endingCheckpoint.createdAt) && isValidDate(session?.endedAt) && Date.parse(endingCheckpoint.createdAt) > Date.parse(session.endedAt)) {
      addImportError(errors, `会话结束检查点晚于会话结束：${session.id ?? "未知"}`);
    }
  }
  for (const crumb of value.crumbs) {
    if (!isObject(crumb)) {
      addImportError(errors, "面包屑记录必须是普通对象");
      continue;
    }
    if (typeof crumb?.id !== "string" || !crumb.id) addImportError(errors, "存在无效的面包屑 ID");
    else validateImportId(errors, crumb.id, "面包屑");
    if (!projectIds.has(crumb?.projectId)) addImportError(errors, `面包屑引用了不存在的项目：${crumb?.id ?? "未知"}`);
    if (crumb?.sessionId && !sessionIds.has(crumb.sessionId)) addImportError(errors, `面包屑引用了不存在的会话：${crumb.id ?? "未知"}`);
    if (crumb?.sessionId && sessionIds.has(crumb.sessionId) && sessionsById.get(crumb.sessionId)?.projectId !== crumb.projectId) addImportError(errors, `面包屑会话属于其他项目：${crumb.id ?? "未知"}`);
    if (crumb?.type !== undefined && !CRUMB_TYPES.includes(crumb.type)) addImportError(errors, `面包屑类型无效：${crumb.type}`);
    if (crumb?.pinned !== undefined && typeof crumb.pinned !== "boolean") addImportError(errors, `面包屑置顶状态无效：${crumb.id ?? "未知"}`);
    validateText(errors, crumb, "text", "面包屑内容", IMPORT_LIMITS.crumbText);
    validateDates(errors, crumb, ["createdAt", "resolvedAt"], "面包屑", crumb.id);
    validateRecordProjectWindow(errors, crumb, ["createdAt", "resolvedAt"], "面包屑", projectsById.get(crumb?.projectId));
    if (isValidDate(crumb?.createdAt) && isValidDate(crumb?.resolvedAt) && Date.parse(crumb.resolvedAt) < Date.parse(crumb.createdAt)) {
      addImportError(errors, `面包屑解决时间早于记录时间：${crumb.id ?? "未知"}`);
    }
    const crumbSession = sessionsById.get(crumb?.sessionId);
    if (crumbSession && isValidDate(crumb?.createdAt) && isValidDate(crumbSession.startedAt) && Date.parse(crumb.createdAt) < Date.parse(crumbSession.startedAt)) {
      addImportError(errors, `面包屑早于所属会话开始：${crumb.id ?? "未知"}`);
    }
    if (crumbSession && isValidDate(crumb?.createdAt) && isValidDate(crumbSession.endedAt) && Date.parse(crumb.createdAt) > Date.parse(crumbSession.endedAt)) {
      addImportError(errors, `面包屑晚于所属会话结束：${crumb.id ?? "未知"}`);
    }
  }
  for (const checkpoint of value.checkpoints) {
    if (!isObject(checkpoint)) {
      addImportError(errors, "检查点记录必须是普通对象");
      continue;
    }
    if (typeof checkpoint?.id !== "string" || !checkpoint.id) addImportError(errors, "存在无效的检查点 ID");
    else validateImportId(errors, checkpoint.id, "检查点");
    if (!projectIds.has(checkpoint?.projectId)) addImportError(errors, `检查点引用了不存在的项目：${checkpoint?.id ?? "未知"}`);
    if (checkpoint?.sessionId && !sessionIds.has(checkpoint.sessionId)) addImportError(errors, `检查点引用了不存在的会话：${checkpoint.id ?? "未知"}`);
    if (checkpoint?.sessionId && sessionIds.has(checkpoint.sessionId) && sessionsById.get(checkpoint.sessionId)?.projectId !== checkpoint.projectId) addImportError(errors, `检查点会话属于其他项目：${checkpoint.id ?? "未知"}`);
    if (checkpoint?.captureMode && !CHECKPOINT_CAPTURE_MODES.includes(checkpoint.captureMode)) addImportError(errors, `检查点采集方式无效：${checkpoint.captureMode}`);
    validateText(errors, checkpoint, "summary", "检查点摘要", IMPORT_LIMITS.checkpointSummary);
    validateText(errors, checkpoint, "nextAction", "检查点下一步", IMPORT_LIMITS.nextAction);
    validateText(errors, checkpoint, "openLoops", "检查点未决事项", IMPORT_LIMITS.openLoops);
    validateText(errors, checkpoint, "returnHint", "检查点复航提示", IMPORT_LIMITS.returnHint);
    validateDates(errors, checkpoint, ["createdAt"], "检查点", checkpoint.id);
    validateRecordProjectWindow(errors, checkpoint, ["createdAt"], "检查点", projectsById.get(checkpoint?.projectId));
    const checkpointSession = sessionsById.get(checkpoint?.sessionId);
    if (checkpointSession?.status === "active") addImportError(errors, `活动会话不能包含结束检查点：${checkpointSession.id ?? "未知"}`);
    if (checkpointSession && isValidDate(checkpoint?.createdAt) && isValidDate(checkpointSession.startedAt) && Date.parse(checkpoint.createdAt) < Date.parse(checkpointSession.startedAt)) {
      addImportError(errors, `检查点早于所属会话开始：${checkpoint.id ?? "未知"}`);
    }
    if (checkpointSession && isValidDate(checkpoint?.createdAt) && isValidDate(checkpointSession.endedAt) && Date.parse(checkpoint.createdAt) > Date.parse(checkpointSession.endedAt)) {
      addImportError(errors, `检查点晚于所属会话结束：${checkpoint.id ?? "未知"}`);
    }
  }
  if (value.ui !== undefined && !isObject(value.ui)) addImportError(errors, "界面状态对象无效");
  if (value.ui?.selectedProjectId !== undefined && value.ui.selectedProjectId !== null && !projectIds.has(value.ui.selectedProjectId)) {
    addImportError(errors, "当前选中项目引用不存在");
  }
  return [...new Set(errors)].slice(0, IMPORT_LIMITS.reportedErrors + 1);
}

function validateMetadata(errors, meta) {
  if (meta !== undefined && !isObject(meta)) {
    addImportError(errors, "元数据对象无效");
    return;
  }
  if (!meta) return;
  validateDates(errors, meta, ["createdAt", "updatedAt"], "元数据", "工作区");
  if (isValidDate(meta.createdAt) && isValidDate(meta.updatedAt) && Date.parse(meta.updatedAt) < Date.parse(meta.createdAt)) {
    addImportError(errors, "工作区更新时间早于创建时间");
  }
  if (meta.revision !== undefined && (!Number.isSafeInteger(meta.revision) || meta.revision < 0)) addImportError(errors, "修订号无效");
}

function validateProjectDateWindow(errors, project, field) {
  const value = project?.[field];
  if (!isValidDate(value) || !isValidDate(project?.createdAt) || !isValidDate(project?.updatedAt)) return;
  if (Date.parse(value) < Date.parse(project.createdAt)) addImportError(errors, `项目时间早于创建时间：${project.id ?? "未知"}.${field}`);
  if (Date.parse(value) > Date.parse(project.updatedAt)) addImportError(errors, `项目时间晚于更新时间：${project.id ?? "未知"}.${field}`);
}

function validateRecordProjectWindow(errors, record, fields, label, project) {
  if (!project || !isValidDate(project.createdAt) || !isValidDate(project.updatedAt)) return;
  for (const field of fields) {
    const value = record?.[field];
    if (!isValidDate(value)) continue;
    if (Date.parse(value) < Date.parse(project.createdAt) || Date.parse(value) > Date.parse(project.updatedAt)) {
      addImportError(errors, `${label}时间超出项目生命周期：${record?.id ?? "未知"}.${field}`);
    }
  }
}

function validateSettings(errors, settings) {
  if (settings !== undefined && !isObject(settings)) {
    addImportError(errors, "设置对象无效");
    return;
  }
  if (!settings) return;
  if (settings.theme !== undefined && !["system", "light", "dark"].includes(settings.theme)) addImportError(errors, `界面主题无效：${settings.theme}`);
  if (settings.staleAfterDays !== undefined && (!Number.isSafeInteger(settings.staleAfterDays) || settings.staleAfterDays < 1 || settings.staleAfterDays > 365)) addImportError(errors, "陈旧阈值必须是 1 到 365 之间的整数");
  if (settings.reducedMotion !== undefined && typeof settings.reducedMotion !== "boolean") addImportError(errors, "减少动态效果设置无效");
}

function validateImportId(errors, id, label) {
  if (id.length > IMPORT_LIMITS.id || containsUnsafeIdControl(id)) addImportError(errors, `${label} ID 过长或包含控制字符`);
}

function validateText(errors, record, field, label, maximum) {
  const value = record?.[field];
  if (value === undefined) return;
  const suffix = record?.id ? `：${record.id}` : "";
  if (typeof value !== "string") addImportError(errors, `${label}必须是文本${suffix}`);
  else {
    if (value.length > maximum) addImportError(errors, `${label}超过 ${maximum} 字符上限${suffix}`);
    if (containsUnsafeTextControl(value)) addImportError(errors, `${label}包含不可见控制字符${suffix}`);
  }
}

function validateDates(errors, record, fields, label, id) {
  for (const field of fields) {
    const value = record?.[field];
    if (value !== undefined && value !== null && !isValidDate(value)) addImportError(errors, `${label}时间无效：${id ?? "未知"}.${field}`);
  }
}

function addImportError(errors, message) {
  if (errors.length < IMPORT_LIMITS.reportedErrors) errors.push(message);
  else if (errors.length === IMPORT_LIMITS.reportedErrors) errors.push("备份还包含更多问题，已停止展开错误列表");
}

function cleanText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function arrayOf(value) {
  return Array.isArray(value) ? value : [];
}

function isObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function safeInteger(value, fallback) {
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

function isValidDate(value) {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}
