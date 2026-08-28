import { compactText, containsUnsafeTextControl, normalizeState, validateImportCandidate, validateState } from "./model.js";

const COLLECTION_NAMES = Object.freeze(["projects", "sessions", "crumbs", "checkpoints"]);
const DETAIL_LIMIT = 6;
const CHECKSUM_PATTERN = /^fnv1a32:[0-9a-f]{8}$/u;

export function checksumSnapshotData(value) {
  const serialized = JSON.stringify(value) ?? "";
  let hash = 0x811c9dc5;
  for (let index = 0; index < serialized.length; index += 1) {
    let codePoint = serialized.charCodeAt(index);
    if (codePoint >= 0xd800 && codePoint <= 0xdbff && index + 1 < serialized.length) {
      const low = serialized.charCodeAt(index + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        codePoint = 0x10000 + ((codePoint - 0xd800) << 10) + (low - 0xdc00);
        index += 1;
      }
    }
    if (codePoint <= 0x7f) hash = hashByte(hash, codePoint);
    else if (codePoint <= 0x7ff) {
      hash = hashByte(hash, 0xc0 | (codePoint >> 6));
      hash = hashByte(hash, 0x80 | (codePoint & 0x3f));
    } else if (codePoint <= 0xffff) {
      hash = hashByte(hash, 0xe0 | (codePoint >> 12));
      hash = hashByte(hash, 0x80 | ((codePoint >> 6) & 0x3f));
      hash = hashByte(hash, 0x80 | (codePoint & 0x3f));
    } else {
      hash = hashByte(hash, 0xf0 | (codePoint >> 18));
      hash = hashByte(hash, 0x80 | ((codePoint >> 12) & 0x3f));
      hash = hashByte(hash, 0x80 | ((codePoint >> 6) & 0x3f));
      hash = hashByte(hash, 0x80 | (codePoint & 0x3f));
    }
  }
  return `fnv1a32:${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

export function readImportSnapshot(value, now = Date.now()) {
  let candidate = value;
  let source = { envelope: false, appVersion: null, exportedAt: null, checksumVerified: null };

  if (value && typeof value === "object" && !Array.isArray(value) && "format" in value) {
    if (value.format !== "reentry-deck-backup") throw new Error("导入失败：无法识别这份备份的格式。 ");
    if (!value.data || typeof value.data !== "object" || Array.isArray(value.data)) {
      throw new Error("导入失败：备份信封缺少数据内容。 ");
    }
    let checksumVerified = null;
    if ("checksum" in value) {
      if (typeof value.checksum !== "string" || !CHECKSUM_PATTERN.test(value.checksum)) {
        throw new Error("导入失败：备份校验码格式无效。 ");
      }
      if (checksumSnapshotData(value.data) !== value.checksum) {
        throw new Error("导入失败：备份内容与校验码不一致，文件可能已损坏或被意外修改。 ");
      }
      checksumVerified = true;
    }
    candidate = value.data;
    source = {
      envelope: true,
      appVersion: cleanMetadata(value.appVersion),
      exportedAt: validDate(value.exportedAt) ? value.exportedAt : null,
      checksumVerified
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
  const projectDiff = diffProjects(currentState.projects, incomingState.projects);
  const collections = { projects: projectDiff.collection };
  for (const name of COLLECTION_NAMES) {
    if (name !== "projects") collections[name] = diffCollection(currentState[name], incomingState[name]);
  }
  const projectChanges = projectDiff.details;
  const settingsChanged = !sameValue(currentState.settings, incomingState.settings);
  const selectionChanged = !sameValue(currentState.ui, incomingState.ui);
  const orderChangedCollections = [];
  let hasContentChanges = settingsChanged || selectionChanged;
  for (const name of COLLECTION_NAMES) {
    const change = collections[name];
    if (change.orderChanged) orderChangedCollections.push(name);
    if (change.added || change.removed || change.changed || change.orderChanged) hasContentChanges = true;
  }

  return {
    normalizedSnapshot: incomingState,
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
  const currentById = new Map();
  const incomingById = new Map();
  for (const item of current) currentById.set(item.id, item);
  for (const item of incoming) incomingById.set(item.id, item);
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

  const orderChanged = added === 0 && removed === 0 && hasOrderDifference(current, incoming);
  return { current: current.length, incoming: incoming.length, added, removed, changed, unchanged, orderChanged };
}

function diffProjects(current, incoming) {
  const currentById = new Map();
  const incomingById = new Map();
  for (const project of current) currentById.set(project.id, project);
  for (const project of incoming) incomingById.set(project.id, project);
  const added = [];
  const removed = [];
  const changed = [];
  let addedTotal = 0;
  let removedTotal = 0;
  let changedTotal = 0;
  let unchanged = 0;

  for (const project of incoming) {
    if (!currentById.has(project.id)) {
      addedTotal += 1;
      if (added.length < DETAIL_LIMIT) added.push(projectSummary(project));
      continue;
    }
    const before = currentById.get(project.id);
    if (!sameValue(before, project)) {
      changedTotal += 1;
      if (changed.length < DETAIL_LIMIT) changed.push({
        id: project.id,
        beforeTitle: before.title,
        afterTitle: project.title,
        beforeStatus: before.status,
        afterStatus: project.status
      });
    } else unchanged += 1;
  }
  for (const project of current) {
    if (incomingById.has(project.id)) continue;
    removedTotal += 1;
    if (removed.length < DETAIL_LIMIT) removed.push(projectSummary(project));
  }

  const orderChanged = addedTotal === 0 && removedTotal === 0 && hasOrderDifference(current, incoming);
  return {
    collection: {
      current: current.length,
      incoming: incoming.length,
      added: addedTotal,
      removed: removedTotal,
      changed: changedTotal,
      unchanged,
      orderChanged
    },
    details: {
      added,
      removed,
      changed,
      addedTotal,
      removedTotal,
      changedTotal,
      detailLimit: DETAIL_LIMIT
    }
  };
}

function projectSummary(project) {
  return { id: project.id, title: project.title, status: project.status };
}

function describeActiveSession(state) {
  let session = null;
  for (const item of state.sessions) {
    if (item.status !== "active") continue;
    session = item;
    break;
  }
  if (!session) return null;
  let project = null;
  for (const item of state.projects) {
    if (item.id !== session.projectId) continue;
    project = item;
    break;
  }
  return {
    sessionId: session.id,
    projectId: session.projectId,
    projectTitle: project?.title ?? "未知项目",
    intention: session.intention,
    startedAt: session.startedAt
  };
}

function hasOrderDifference(current, incoming) {
  if (current.length !== incoming.length) return false;
  for (let index = 0; index < current.length; index += 1) {
    if (current[index]?.id !== incoming[index]?.id) return true;
  }
  return false;
}

function cleanMetadata(value) {
  return typeof value === "string" && value.trim() && !containsUnsafeTextControl(value) ? compactText(value, 80) : null;
}

function validDate(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function sameValue(left, right) {
  if (left === right) return true;
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
  let leftFields = 0;
  let rightFields = 0;
  for (const field in left) {
    if (!Object.hasOwn(left, field)) continue;
    leftFields += 1;
    if (!Object.hasOwn(right, field) || left[field] !== right[field]) return false;
  }
  for (const field in right) {
    if (Object.hasOwn(right, field)) rightFields += 1;
  }
  return leftFields === rightFields;
}

function hashByte(hash, byte) {
  return Math.imul(hash ^ byte, 0x01000193);
}
