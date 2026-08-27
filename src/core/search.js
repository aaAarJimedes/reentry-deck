import { compactText, containsUnsafeIdControl } from "./model.js";

const RESULT_LIMIT = 40;
const RESOURCE_LIMIT = 20;
const MAX_RESOURCE_URL_LENGTH = 2_048;
export const SEARCH_QUERY_LIMIT = 500;
export const SEARCH_TOKEN_LIMIT = 24;
export const SEARCH_TOKEN_LENGTH_LIMIT = 100;

export function searchWorkspace(state, query, options = {}) {
  return searchWorkspaceIndex(buildWorkspaceSearchIndex(state), query, options);
}

export function buildWorkspaceSearchIndex(state) {
  const projects = Array.isArray(state?.projects) ? state.projects : [];
  const crumbs = Array.isArray(state?.crumbs) ? state.crumbs : [];
  const checkpoints = Array.isArray(state?.checkpoints) ? state.checkpoints : [];
  const projectsById = new Map(projects.map((project) => [project.id, project]));
  const candidates = [];

  for (const project of projects) {
    candidates.push(indexCandidate({
      id: project.id,
      kind: "project",
      project,
      title: project.title,
      text: [project.description, project.nextAction].filter(Boolean).join(" · "),
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
      text: [checkpoint.nextAction, checkpoint.openLoops, checkpoint.returnHint].filter(Boolean).join(" · "),
      createdAt: checkpoint.createdAt
    }));
  }
  return Object.freeze({ candidates: Object.freeze(candidates) });
}

export function searchWorkspaceIndex(index, query, options = {}) {
  const tokens = tokenize(query);
  if (!tokens.length) return [];
  const limit = boundedLimit(options.limit, RESULT_LIMIT, 100);
  if (!limit || !Array.isArray(index?.candidates)) return [];
  const matches = [];
  for (const candidate of index.candidates) {
    const score = scoreCandidate(candidate, tokens);
    if (score > 0) matches.push({ ...candidate.result, score });
  }
  return matches.sort((a, b) => b.score - a.score || timeOf(b.createdAt) - timeOf(a.createdAt) || a.id.localeCompare(b.id)).slice(0, limit);
}

export function extractHttpLinks(text, limit = RESOURCE_LIMIT) {
  if (typeof text !== "string" || !text) return [];
  const safeLimit = boundedLimit(limit, RESOURCE_LIMIT, 100);
  if (!safeLimit) return [];
  const results = [];
  const seen = new Set();
  const matches = text.match(/https?:\/\/[^\s<>"']+/giu) ?? [];
  for (const rawMatch of matches) {
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
  const project = state.projects.find((item) => item.id === projectId);
  if (!project) return [];
  const safeLimit = boundedLimit(limit, RESOURCE_LIMIT, 100);
  if (!safeLimit) return [];
  const evidence = [
    { sourceType: "project", sourceId: project.id, createdAt: project.updatedAt ?? project.createdAt, text: `${project.description}\n${project.nextAction}` },
    ...state.crumbs
      .filter((item) => item.projectId === projectId)
      .map((item) => ({ sourceType: "crumb", sourceId: item.id, createdAt: item.createdAt, text: item.text })),
    ...state.checkpoints
      .filter((item) => item.projectId === projectId)
      .map((item) => ({ sourceType: "checkpoint", sourceId: item.id, createdAt: item.createdAt, text: [item.summary, item.nextAction, item.openLoops, item.returnHint].join("\n") }))
  ].sort((a, b) => timeOf(b.createdAt) - timeOf(a.createdAt));

  const resources = [];
  const seen = new Set();
  for (const item of evidence) {
    for (const link of extractHttpLinks(item.text, safeLimit)) {
      if (seen.has(link.url)) continue;
      seen.add(link.url);
      resources.push({ ...link, sourceType: item.sourceType, sourceId: item.sourceId, createdAt: item.createdAt });
      if (resources.length >= safeLimit) return resources;
    }
  }
  return resources;
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
  return `${url.host}${path || ""}`;
}

function timeOf(value) {
  const parsed = Date.parse(value ?? "");
  return Number.isFinite(parsed) ? parsed : 0;
}

function boundedLimit(value, fallback, maximum) {
  const requested = Number.isSafeInteger(value) ? value : fallback;
  return Math.max(0, Math.min(requested, maximum));
}
