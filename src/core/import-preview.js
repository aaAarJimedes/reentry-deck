import { normalizeState, validateImportCandidate, validateState } from "./model.js";

const COLLECTION_NAMES = Object.freeze(["projects", "sessions", "crumbs", "checkpoints"]);
const DETAIL_LIMIT = 6;

export function readImportSnapshot(value, now = Date.now()) {
  let candidate = value;
  let source = { envelope: false, appVersion: null, exportedAt: null };

  if (value && typeof value === "object" && !Array.isArray(value) && "format" in value) {
    if (value.format !== "reentry-deck-backup") throw new Error("导入失败：无法识别这份备份的格式。 ");
    if (!value.data || typeof value.data !== "object" || Array.isArray(value.data)) {
      throw new Error("导入失败：备份信封缺少数据内容。 ");
    }
    candidate = value.data;
    source = {
      envelope: true,
      appVersion: cleanMetadata(value.appVersion),
      exportedAt: validDate(value.exportedAt) ? value.exportedAt : null
    };
  }

  const candidateErrors = validateImportCandidate(candidate);
  if (candidateErrors.length) throw new Error(`导入失败：${candidateErrors.join("；")}`);
  const state = normalizeState(candidate, now);
  const errors = validateState(state);
  if (errors.length) throw new Error(`导入失败：${errors.join("；")}`);
  return { state, source };
}

export function buildImportPreview(value, currentState, now = Date.now()) {
  const { state: incomingState, source } = readImportSnapshot(value, now);
  const collections = Object.fromEntries(
    COLLECTION_NAMES.map((name) => [name, diffCollection(currentState[name], incomingState[name])])
  );
  const projectChanges = diffProjects(currentState.projects, incomingState.projects);
  const settingsChanged = !sameValue(currentState.settings, incomingState.settings);
  const selectionChanged = !sameValue(currentState.ui, incomingState.ui);
  const orderChangedCollections = Object.entries(collections)
    .filter(([, change]) => change.orderChanged)
    .map(([name]) => name);
  const hasContentChanges = settingsChanged
    || selectionChanged
    || Object.values(collections).some((change) => change.added || change.removed || change.changed || change.orderChanged);

  return {
    source,
    currentRevision: currentState.meta.revision,
    incomingRevision: incomingState.meta.revision,
    collections,
    projectChanges,
    settingsChanged,
    selectionChanged,
    orderChangedCollections,
    hasContentChanges,
    currentActiveSession: describeActiveSession(currentState),
    incomingActiveSession: describeActiveSession(incomingState)
  };
}

function diffCollection(current = [], incoming = []) {
  const currentById = new Map(current.map((item) => [item.id, item]));
  const incomingById = new Map(incoming.map((item) => [item.id, item]));
  let added = 0;
  let removed = 0;
  let changed = 0;
  let unchanged = 0;

  for (const [id, item] of incomingById) {
    if (!currentById.has(id)) added += 1;
    else if (sameValue(currentById.get(id), item)) unchanged += 1;
    else changed += 1;
  }
  for (const id of currentById.keys()) {
    if (!incomingById.has(id)) removed += 1;
  }

  const orderChanged = added === 0 && removed === 0 && current.length === incoming.length
    && current.some((item, index) => item.id !== incoming[index]?.id);
  return { current: current.length, incoming: incoming.length, added, removed, changed, unchanged, orderChanged };
}

function diffProjects(current, incoming) {
  const currentById = new Map(current.map((project) => [project.id, project]));
  const incomingById = new Map(incoming.map((project) => [project.id, project]));
  const added = incoming
    .filter((project) => !currentById.has(project.id))
    .map(projectSummary);
  const removed = current
    .filter((project) => !incomingById.has(project.id))
    .map(projectSummary);
  const changed = incoming
    .filter((project) => currentById.has(project.id) && !sameValue(currentById.get(project.id), project))
    .map((project) => {
      const before = currentById.get(project.id);
      return {
        id: project.id,
        beforeTitle: before.title,
        afterTitle: project.title,
        beforeStatus: before.status,
        afterStatus: project.status
      };
    });

  return {
    added: added.slice(0, DETAIL_LIMIT),
    removed: removed.slice(0, DETAIL_LIMIT),
    changed: changed.slice(0, DETAIL_LIMIT),
    addedTotal: added.length,
    removedTotal: removed.length,
    changedTotal: changed.length,
    detailLimit: DETAIL_LIMIT
  };
}

function projectSummary(project) {
  return { id: project.id, title: project.title, status: project.status };
}

function describeActiveSession(state) {
  const session = state.sessions.find((item) => item.status === "active");
  if (!session) return null;
  const project = state.projects.find((item) => item.id === session.projectId);
  return {
    sessionId: session.id,
    projectId: session.projectId,
    projectTitle: project?.title ?? "未知项目",
    intention: session.intention,
    startedAt: session.startedAt
  };
}

function cleanMetadata(value) {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 80) : null;
}

function validDate(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function sameValue(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}
