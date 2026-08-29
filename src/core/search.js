import { compactText, containsUnsafeIdControl } from "./model.js";

const RESULT_LIMIT = 40;
const RESOURCE_LIMIT = 20;
const MAX_RESOURCE_URL_LENGTH = 2_048;
export const RESOURCE_LABEL_LIMIT = 180;
export const RESOURCE_TEXT_SCAN_LIMIT = 4_096;
const HTTP_SCHEME_PATTERN = /https?:\/\//iu;
export const SEARCH_QUERY_LIMIT = 500;
export const SEARCH_TOKEN_LIMIT = 24;
export const SEARCH_TOKEN_LENGTH_LIMIT = 100;

export function searchWorkspace(state, query, options = {}) {
  return searchWorkspaceIndex(buildWorkspaceSearchIndex(state), query, options);
}

export function searchWorkspaceWindow(state, query, options = {}) {
  return searchWorkspaceIndexWindow(buildWorkspaceSearchIndex(state), query, options);
}

export function buildWorkspaceSearchIndex(state) {
  const projects = Array.isArray(state?.projects) ? state.projects : [];
  const crumbs = Array.isArray(state?.crumbs) ? state.crumbs : [];
  const checkpoints = Array.isArray(state?.checkpoints) ? state.checkpoints : [];
  const projectsById = new Map();
  const candidates = [];

  for (const project of projects) {
    projectsById.set(project.id, project);
    candidates.push(indexCandidate({
      id: project.id,
      kind: "project",
      project,
      title: project.title,
      text: joinSearchFields(project.description, project.nextAction),
      createdAt: project.updatedAt ?? project.createdAt
    }));
  }
  for (const crumb of crumbs) {
    const project = projectsById.get(crumb.projectId);
    if (!project) continue;
    candidates.push(indexCandidate({
      id: crumb.id,
      kind: "crumb",
      project,
      title: crumb.text,
      text: "",
      createdAt: crumb.resolvedAt ?? crumb.createdAt,
      subtype: crumb.type
    }));
  }
  for (const checkpoint of checkpoints) {
    const project = projectsById.get(checkpoint.projectId);
    if (!project) continue;
    candidates.push(indexCandidate({
      id: checkpoint.id,
      kind: "checkpoint",
      project,
      title: checkpoint.summary,
      text: joinSearchFields(checkpoint.nextAction, checkpoint.openLoops, checkpoint.returnHint),
      createdAt: checkpoint.createdAt
    }));
  }
  return Object.freeze({ candidates: Object.freeze(candidates) });
}

export function searchWorkspaceIndex(index, query, options = {}) {
  return searchWorkspaceIndexProjection(index, query, options, false).items;
}

export function searchWorkspaceIndexWindow(index, query, options = {}) {
  return searchWorkspaceIndexProjection(index, query, options, true);
}

function searchWorkspaceIndexProjection(index, query, options, countTotal) {
  const tokens = tokenize(query);
  if (!tokens.length) return { items: [], total: 0 };
  const limit = boundedLimit(options.limit, RESULT_LIMIT, 100);
  if ((!limit && !countTotal) || !Array.isArray(index?.candidates)) return { items: [], total: 0 };
  const matches = [];
  let total = 0;
  for (const candidate of index.candidates) {
    const score = scoreCandidate(candidate, tokens);
    if (score <= 0) continue;
    total += 1;
    if (!limit) continue;
    if (matches.length < limit) {
      pushWorstSearchMatch(matches, { result: candidate.result, score });
      continue;
    }
    if (compareSearchPosition(score, candidate.result, matches[0].score, matches[0].result) >= 0) continue;
    matches[0] = { result: candidate.result, score };
    sinkWorstSearchMatch(matches, 0);
  }
  const items = matches
    .sort((left, right) => compareSearchPosition(left.score, left.result, right.score, right.result))
    .map(({ result, score }) => ({ ...result, score }));
  return { items, total };
}

function pushWorstSearchMatch(heap, entry) {
  heap.push(entry);
  let index = heap.length - 1;
  while (index > 0) {
    const parent = Math.floor((index - 1) / 2);
    if (compareSearchEntries(heap[index], heap[parent]) <= 0) break;
    const previous = heap[parent];
    heap[parent] = heap[index];
    heap[index] = previous;
    index = parent;
  }
}

function sinkWorstSearchMatch(heap, start) {
  let index = start;
  while (true) {
    const left = index * 2 + 1;
    if (left >= heap.length) return;
    const right = left + 1;
    let worse = left;
    if (right < heap.length && compareSearchEntries(heap[right], heap[left]) > 0) worse = right;
    if (compareSearchEntries(heap[worse], heap[index]) <= 0) return;
    const previous = heap[index];
    heap[index] = heap[worse];
    heap[worse] = previous;
    index = worse;
  }
}

function compareSearchEntries(left, right) {
  return compareSearchPosition(left.score, left.result, right.score, right.result);
}

function compareSearchPosition(leftScore, leftResult, rightScore, rightResult) {
  return rightScore - leftScore
    || timeOf(rightResult.createdAt) - timeOf(leftResult.createdAt)
    || compareCodeUnits(leftResult.id, rightResult.id);
}

export function extractHttpLinks(text, limit = RESOURCE_LIMIT) {
  if (typeof text !== "string" || !text || text.length > RESOURCE_TEXT_SCAN_LIMIT) return [];
  const safeLimit = boundedLimit(limit, RESOURCE_LIMIT, 100);
  if (!safeLimit) return [];
  const results = [];
  const seen = new Set();
  const matches = text.matchAll(/https?:\/\/[^\s<>"'，。；！？、：（）【】《》〈〉「」『』“”‘’…]+/giu);
  for (const match of matches) {
    const rawMatch = match[0];
    const candidate = rawMatch.replace(/[\])},.;!?，。；！？）】》]+$/u, "");
    try {
      const url = new URL(candidate);
      const decodedTarget = decodeURIComponent(`${url.pathname}${url.search}`);
      const canonicalHostname = url.hostname.replace(/\.+$/u, "");
      if (
        candidate.length > MAX_RESOURCE_URL_LENGTH
        || url.href.length > MAX_RESOURCE_URL_LENGTH
        || containsUnsafeIdControl(candidate)
        || containsUnsafeIdControl(decodedTarget)
        || !["http:", "https:"].includes(url.protocol)
        || !canonicalHostname
        || hasMixedUnicodeHostnameLabel(candidate)
        || url.username
        || url.password
      ) continue;
      url.hostname = canonicalHostname;
      url.hash = "";
      if (seen.has(url.href)) continue;
      seen.add(url.href);
      results.push({ url: url.href, host: url.host, label: readableURL(url) });
      if (results.length >= safeLimit) break;
    } catch {
      // A malformed text fragment is not a usable recovery resource.
    }
  }
  return results;
}

export function getProjectResources(state, projectId, limit = RESOURCE_LIMIT) {
  let project = null;
  for (const item of state.projects) {
    if (item.id !== projectId) continue;
    project = item;
    break;
  }
  if (!project) return [];
  const safeLimit = boundedLimit(limit, RESOURCE_LIMIT, 100);
  if (!safeLimit) return [];
  const selected = [];
  const selectedByUrl = new Map();
  if (hasHttpCandidate(project.description) || hasHttpCandidate(project.nextAction)) {
    addResourceEvidence(selected, selectedByUrl, safeLimit, {
      sourceType: "project",
      sourceId: project.id,
      sourcePriority: 0,
      insertionIndex: 0,
      createdAt: project.updatedAt ?? project.createdAt,
      text: `${project.description}\n${project.nextAction}`
    });
  }
  for (let insertionIndex = 0; insertionIndex < state.crumbs.length; insertionIndex += 1) {
    const item = state.crumbs[insertionIndex];
    if (item.projectId !== projectId || !hasHttpCandidate(item.text)) continue;
    addResourceEvidence(selected, selectedByUrl, safeLimit, {
      sourceType: "crumb", sourceId: item.id, sourcePriority: 1, insertionIndex, createdAt: item.createdAt, text: item.text
    });
  }
  for (let insertionIndex = 0; insertionIndex < state.checkpoints.length; insertionIndex += 1) {
    const item = state.checkpoints[insertionIndex];
    if (item.projectId !== projectId
      || (!hasHttpCandidate(item.summary)
        && !hasHttpCandidate(item.nextAction)
        && !hasHttpCandidate(item.openLoops)
        && !hasHttpCandidate(item.returnHint))) continue;
    addResourceEvidence(selected, selectedByUrl, safeLimit, {
      sourceType: "checkpoint",
      sourceId: item.id,
      sourcePriority: 2,
      insertionIndex,
      createdAt: item.createdAt,
      text: [item.summary, item.nextAction, item.openLoops, item.returnHint].join("\n")
    });
  }
  const resources = [];
  for (const candidate of selected) {
    resources.push({
      ...candidate.link,
      sourceType: candidate.sourceType,
      sourceId: candidate.sourceId,
      createdAt: candidate.createdAt
    });
  }
  return resources;
}

function addResourceEvidence(selected, selectedByUrl, limit, evidence) {
  let linkIndex = 0;
  for (const link of extractHttpLinks(evidence.text, limit)) {
    const candidate = { ...evidence, link, linkIndex, time: timeOf(evidence.createdAt) };
    linkIndex += 1;
    const existing = selectedByUrl.get(link.url);
    if (existing && compareResourceCandidate(existing, candidate) <= 0) continue;
    if (existing) {
      selected.splice(selected.indexOf(existing), 1);
      selectedByUrl.delete(link.url);
    }
    let insertion = 0;
    while (insertion < selected.length && compareResourceCandidate(selected[insertion], candidate) <= 0) insertion += 1;
    if (insertion >= limit) continue;
    selected.splice(insertion, 0, candidate);
    selectedByUrl.set(link.url, candidate);
    if (selected.length > limit) {
      const removed = selected.pop();
      selectedByUrl.delete(removed.link.url);
    }
  }
}

function compareResourceCandidate(left, right) {
  return right.time - left.time
    || right.sourcePriority - left.sourcePriority
    || right.insertionIndex - left.insertionIndex
    || left.linkIndex - right.linkIndex;
}

function hasHttpCandidate(value) {
  return typeof value === "string" && HTTP_SCHEME_PATTERN.test(value);
}

function joinSearchFields(first, second, third) {
  let result = first ? String(first) : "";
  if (second) result += `${result ? " · " : ""}${String(second)}`;
  if (third) result += `${result ? " · " : ""}${String(third)}`;
  return result;
}

function indexCandidate(input) {
  const title = String(input.title ?? "");
  const text = String(input.text ?? "");
  const projectTitle = input.project.title;
  const normalizedTitle = normalizeText(title);
  const normalizedText = normalizeText(`${text} ${projectTitle}`);
  return Object.freeze({
    normalizedTitle,
    normalizedText,
    result: Object.freeze({
      id: input.id,
      kind: input.kind,
      subtype: input.subtype ?? null,
      projectId: input.project.id,
      projectTitle,
      projectStatus: input.project.status,
      title,
      snippet: compact(text || title),
      createdAt: input.createdAt
    })
  });
}

function scoreCandidate(candidate, tokens) {
  const { normalizedTitle, normalizedText } = candidate;
  if (!tokens.every((token) => normalizedTitle.includes(token) || normalizedText.includes(token))) return 0;
  let score = 0;
  for (const token of tokens) {
    if (normalizedTitle === token) score += 100;
    else if (normalizedTitle.startsWith(token)) score += 60;
    else if (normalizedTitle.includes(token)) score += 40;
    else score += 15;
  }
  if (candidate.result.kind === "project") score += 12;
  if (candidate.result.projectStatus === "archived") score -= 4;
  return score;
}

function tokenize(query) {
  const raw = String(query ?? "");
  if (raw.length > SEARCH_QUERY_LIMIT) return [];
  const normalized = normalizeText(raw);
  if (normalized.length > SEARCH_QUERY_LIMIT) return [];
  const tokens = [...new Set(normalized.split(/\s+/u).filter(Boolean))];
  if (tokens.length > SEARCH_TOKEN_LIMIT || tokens.some((token) => token.length > SEARCH_TOKEN_LENGTH_LIMIT)) return [];
  return tokens;
}

function normalizeText(value) {
  return String(value ?? "").normalize("NFKC").toLocaleLowerCase("zh-CN").trim();
}

function compact(value) {
  const text = String(value ?? "").replace(/\s+/gu, " ").trim();
  return compactText(text, 150);
}

function readableURL(url) {
  const path = decodeURIComponent(url.pathname).replace(/\/$/u, "");
  return compactText(`${url.host}${path || ""}`, RESOURCE_LABEL_LIMIT);
}

function hasMixedUnicodeHostnameLabel(candidate) {
  const authority = candidate.slice(candidate.indexOf("//") + 2).split(/[/?#]/u, 1)[0];
  const hostname = authority.slice(authority.lastIndexOf("@") + 1).replace(/:\d*$/u, "");
  if (hostname.startsWith("[")) return false;
  return hostname
    .split(/[.\u3002\uff0e\uff61]/u)
    .some((label) => /[a-z0-9]/iu.test(label) && /[^\u0000-\u007f]/u.test(label));
}

function timeOf(value) {
  const parsed = Date.parse(value ?? "");
  return Number.isFinite(parsed) ? parsed : 0;
}

function boundedLimit(value, fallback, maximum) {
  const requested = Number.isSafeInteger(value) ? value : fallback;
  return Math.max(0, Math.min(requested, maximum));
}

function compareCodeUnits(left, right) {
  return left === right ? 0 : left < right ? -1 : 1;
}
