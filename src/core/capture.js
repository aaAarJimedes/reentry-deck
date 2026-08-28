import { CRUMB_TYPES, IMPORT_LIMITS, compactText, createCrumb, isoAtOrAfter } from "./model.js";

export const QUICK_CAPTURE_PROJECT_LIMIT = 40;
export const QUICK_CAPTURE_QUERY_LIMIT = IMPORT_LIMITS.projectTitle;

export function buildQuickCaptureProjectWindow(state, options = {}) {
  const queryInput = readQuickCaptureQuery(options.query);
  if (queryInput.rejected) {
    return Object.freeze({ items: Object.freeze([]), total: 0, matched: 0, query: "", queryRejected: true });
  }
  const query = queryInput.query;
  const requestedLimit = Number(options.limit ?? QUICK_CAPTURE_PROJECT_LIMIT);
  const limit = Number.isSafeInteger(requestedLimit) && requestedLimit > 0
    ? Math.min(requestedLimit, QUICK_CAPTURE_PROJECT_LIMIT)
    : QUICK_CAPTURE_PROJECT_LIMIT;
  const preferredRanks = new Map();
  for (const id of Array.isArray(options.preferredIds) ? options.preferredIds : []) {
    if (typeof id === "string" && id && !preferredRanks.has(id)) preferredRanks.set(id, preferredRanks.size);
  }

  const candidates = [];
  let total = 0;
  let matched = 0;
  for (const project of Array.isArray(state?.projects) ? state.projects : []) {
    if (project.status === "archived") continue;
    total += 1;
    const matchRank = quickCaptureMatchRank(project, query);
    if (matchRank === null) continue;
    matched += 1;
    const candidate = {
      project,
      matchRank,
      preferredRank: preferredRanks.get(project.id) ?? Number.POSITIVE_INFINITY,
      activityAt: finiteDate(project.lastOpenedAt) ?? finiteDate(project.updatedAt) ?? Number.NEGATIVE_INFINITY
    };
    let insertion = 0;
    while (insertion < candidates.length && compareQuickCaptureCandidate(candidates[insertion], candidate) <= 0) {
      insertion += 1;
    }
    if (insertion >= limit) continue;
    candidates.splice(insertion, 0, candidate);
    if (candidates.length > limit) candidates.pop();
  }

  const items = [];
  for (const candidate of candidates) items.push(candidate.project);
  return Object.freeze({ items: Object.freeze(items), total, matched, query, queryRejected: false });
}

export function projectNextActionFromCrumb(crumb) {
  return crumb?.type === "next" ? compactText(crumb.text, IMPORT_LIMITS.nextAction) : null;
}

export function prepareQuickCapture(state, input, now = Date.now()) {
  const projects = Array.isArray(state?.projects) ? state.projects : [];
  let project = null;
  let projectIndex = -1;
  for (let index = 0; index < projects.length; index += 1) {
    const candidate = projects[index];
    if (candidate.id !== input?.projectId || candidate.status === "archived") continue;
    project = candidate;
    projectIndex = index;
    break;
  }
  if (!project) throw new Error("目标项目不可用。 ");
  if (!CRUMB_TYPES.includes(input?.type)) throw new Error("记录类型不可用。 ");
  let session = null;
  for (const candidate of Array.isArray(state?.sessions) ? state.sessions : []) {
    if (candidate.projectId === project.id && candidate.status === "active") {
      session = candidate;
      break;
    }
  }
  const crumb = createCrumb({
    projectId: project.id,
    sessionId: session?.id ?? null,
    type: input.type,
    text: input.text,
    pinned: input.pinned === true || input.pinned === "on"
  }, isoAtOrAfter(now, project.updatedAt, session?.startedAt));
  if (!crumb.text) throw new Error("先写下一条记录。 ");

  return {
    crumb,
    projectIndex,
    projectTitle: project.title,
    linkedToActiveSession: Boolean(session)
  };
}

function quickCaptureMatchRank(project, query) {
  if (!query) return 0;
  const title = normalizeQuickCaptureText(project.title);
  if (title === query) return 0;
  if (title.startsWith(query)) return 1;
  if (title.includes(query)) return 2;
  if (normalizeQuickCaptureText(project.description).includes(query)
    || normalizeQuickCaptureText(project.nextAction).includes(query)) return 3;
  return null;
}

function compareQuickCaptureCandidate(left, right) {
  if (left.matchRank !== right.matchRank) return left.matchRank - right.matchRank;
  if (left.preferredRank !== right.preferredRank) return left.preferredRank - right.preferredRank;
  if (left.activityAt !== right.activityAt) return right.activityAt - left.activityAt;
  const titleOrder = compareCodeUnits(left.project.title, right.project.title);
  return titleOrder || compareCodeUnits(left.project.id, right.project.id);
}

function normalizeQuickCaptureText(value) {
  return String(value ?? "").normalize("NFKC").toLocaleLowerCase("zh-CN").trim();
}

function readQuickCaptureQuery(value) {
  const raw = String(value ?? "");
  if (raw.length > QUICK_CAPTURE_QUERY_LIMIT) return { query: "", rejected: true };
  const query = normalizeQuickCaptureText(raw);
  return query.length > QUICK_CAPTURE_QUERY_LIMIT
    ? { query: "", rejected: true }
    : { query, rejected: false };
}

function finiteDate(value) {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function compareCodeUnits(left, right) {
  const a = String(left);
  const b = String(right);
  return a < b ? -1 : a > b ? 1 : 0;
}
