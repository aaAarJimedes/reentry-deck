const RESULT_LIMIT = 40;
const RESOURCE_LIMIT = 20;

export function searchWorkspace(state, query, options = {}) {
  const tokens = tokenize(query);
  if (!tokens.length) return [];
  const projectsById = new Map(state.projects.map((project) => [project.id, project]));
  const candidates = [];

  for (const project of state.projects) {
    candidates.push(makeCandidate({
      id: project.id,
      kind: "project",
      project,
      title: project.title,
      text: [project.description, project.nextAction].filter(Boolean).join(" · "),
      createdAt: project.updatedAt ?? project.createdAt
    }, tokens));
  }
  for (const crumb of state.crumbs) {
    const project = projectsById.get(crumb.projectId);
    if (!project) continue;
    candidates.push(makeCandidate({
      id: crumb.id,
      kind: "crumb",
      project,
      title: crumb.text,
      text: "",
      createdAt: crumb.resolvedAt ?? crumb.createdAt,
      subtype: crumb.type
    }, tokens));
  }
  for (const checkpoint of state.checkpoints) {
    const project = projectsById.get(checkpoint.projectId);
    if (!project) continue;
    candidates.push(makeCandidate({
      id: checkpoint.id,
      kind: "checkpoint",
      project,
      title: checkpoint.summary,
      text: [checkpoint.nextAction, checkpoint.openLoops, checkpoint.returnHint].filter(Boolean).join(" · "),
      createdAt: checkpoint.createdAt
    }, tokens));
  }

  const limit = boundedLimit(options.limit, RESULT_LIMIT, 100);
  return candidates
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || timeOf(b.createdAt) - timeOf(a.createdAt) || a.id.localeCompare(b.id))
    .slice(0, limit);
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
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) continue;
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

function makeCandidate(input, tokens) {
  const title = String(input.title ?? "");
  const text = String(input.text ?? "");
  const projectTitle = input.project.title;
  const normalizedTitle = normalizeText(title);
  const normalizedText = normalizeText(`${text} ${projectTitle}`);
  if (!tokens.every((token) => normalizedTitle.includes(token) || normalizedText.includes(token))) return { ...input, score: 0 };

  let score = 0;
  for (const token of tokens) {
    if (normalizedTitle === token) score += 100;
    else if (normalizedTitle.startsWith(token)) score += 60;
    else if (normalizedTitle.includes(token)) score += 40;
    else score += 15;
  }
  if (input.kind === "project") score += 12;
  if (input.project.status === "archived") score -= 4;
  return {
    id: input.id,
    kind: input.kind,
    subtype: input.subtype ?? null,
    projectId: input.project.id,
    projectTitle,
    projectStatus: input.project.status,
    title,
    snippet: compact(text || title),
    createdAt: input.createdAt,
    score
  };
}

function tokenize(query) {
  return [...new Set(normalizeText(query).split(/\s+/u).filter(Boolean))];
}

function normalizeText(value) {
  return String(value ?? "").normalize("NFKC").toLocaleLowerCase("zh-CN").trim();
}

function compact(value) {
  const text = String(value ?? "").replace(/\s+/gu, " ").trim();
  return text.length > 150 ? `${text.slice(0, 147)}…` : text;
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
