import { IMPORT_LIMITS, compactText } from "./model.js";

export const WORKSPACE_HANDOFF_PROJECT_LIMIT = 5;
export const WORKSPACE_HANDOFF_INPUT_SCAN_LIMIT = 20;
export const REENTRY_BRIEF_SIGNAL_LIMIT = 3;
export const REENTRY_BRIEF_GAP_LIMIT = 6;
export const COPY_TEXT_LIMIT = 64 * 1024;
const WORKSPACE_HANDOFF_ATTENTION_LIMIT = 4;
const WORKSPACE_HANDOFF_REASON_LIMIT = 3;

export function buildReentryBrief(card) {
  if (!card?.project) throw new TypeError("缺少可生成简报的项目现场。 ");
  return [
    `【${briefLine(card.project.title, IMPORT_LIMITS.projectTitle)}｜复航简报】`,
    `当前状态：${briefLine(card.summary, IMPORT_LIMITS.checkpointSummary)}`,
    `第一动作：${briefLine(card.nextAction, IMPORT_LIMITS.nextAction)}`,
    `未决事项：${currentOpenLoops(card)}`,
    `复航提示：${briefLine(card.returnHint, IMPORT_LIMITS.returnHint)}`,
    `证据状态：${evidenceStatus(card)}`
  ].join("\n");
}

export function buildWorkspaceHandoff(overview, now = Date.now()) {
  if (!overview || !Array.isArray(overview.rankedProjects)) {
    throw new TypeError("缺少可生成工作区交接清单的概览。 ");
  }
  const generatedAt = new Date(now);
  if (!Number.isFinite(generatedAt.getTime())) throw new TypeError("交接清单生成时间无效。 ");
  const ranked = overview.rankedProjects;
  const review = overview.weeklyReview ?? {};
  const attention = Array.isArray(overview.attentionDeck) ? overview.attentionDeck : [];
  let activeCard = null;
  for (let index = 0; index < ranked.length && index < WORKSPACE_HANDOFF_INPUT_SCAN_LIMIT; index += 1) {
    const card = ranked[index];
    if (card?.project && card.activeSession) {
      activeCard = card;
      break;
    }
  }
  const lines = [
    "【复航台｜工作区交接清单】",
    `生成时间：${generatedAt.toISOString()}`,
    `未归档项目：${nonNegativeInteger(overview.rankedTotal)}`,
    `当前会话：${activeCard ? `${briefLine(activeCard.project.title, IMPORT_LIMITS.projectTitle)}｜${briefLine(activeCard.activeSession.intention || "未记录意图", IMPORT_LIMITS.sessionIntention)}` : "无"}`,
    "",
    "优先复航："
  ];
  let projectCount = 0;
  for (let index = 0; index < ranked.length && index < WORKSPACE_HANDOFF_INPUT_SCAN_LIMIT; index += 1) {
    const card = ranked[index];
    if (projectCount >= WORKSPACE_HANDOFF_PROJECT_LIMIT) break;
    if (!card?.project) continue;
    projectCount += 1;
    const completeness = Number.isFinite(card.completeness)
      ? Math.max(0, Math.min(100, Math.round(card.completeness)))
      : 0;
    lines.push(`${projectCount}. ${briefLine(card.project.title, IMPORT_LIMITS.projectTitle)}｜${workspaceStatus(card.project.status)}｜复航 ${completeness}%`);
    lines.push(`   下一步：${briefLine(card.nextAction || "未记录", IMPORT_LIMITS.nextAction)}`);
  }
  if (!projectCount) lines.push("- 当前没有可复航项目");
  lines.push("", "值得核对：");
  let attentionCount = 0;
  for (let index = 0; index < attention.length && index < WORKSPACE_HANDOFF_INPUT_SCAN_LIMIT; index += 1) {
    const item = attention[index];
    if (attentionCount >= WORKSPACE_HANDOFF_ATTENTION_LIMIT) break;
    if (!item?.project) continue;
    attentionCount += 1;
    const reasons = boundedReasonList(item.reasons) || "需要人工核对现场";
    lines.push(`- ${briefLine(item.project.title, IMPORT_LIMITS.projectTitle)}：${reasons}`);
  }
  if (!attentionCount) lines.push("- 当前没有明显的现场缺口");
  lines.push(
    "",
    `七日航迹：${nonNegativeInteger(review.focusedMinutes)} 分钟 · ${nonNegativeInteger(review.sessions)} 段会话 · ${nonNegativeInteger(review.records)} 条轨迹 · 平均复航 ${boundedPercent(review.recoverability)}`,
    "说明：仅根据本机已记录证据生成，不代表产出评价。"
  );
  return lines.join("\n");
}

function currentOpenLoops(card) {
  if (!Array.isArray(card.unresolvedSignals)) {
    return briefLine(card.openLoops || "当前没有未解决的问题或阻塞。", IMPORT_LIMITS.openLoops);
  }
  const current = boundedBriefList(
    card.unresolvedSignals,
    REENTRY_BRIEF_SIGNAL_LIMIT,
    IMPORT_LIMITS.crumbText,
    IMPORT_LIMITS.openLoops,
    (signal) => signal?.text
  );
  if (current) return current;
  const checkpointLoops = card.checkpoint
    ? briefLine(Object.hasOwn(card, "historicalOpenLoops") ? card.historicalOpenLoops : card.openLoops, IMPORT_LIMITS.openLoops)
    : "";
  if (checkpointLoops) {
    return briefLine(`检查点曾记录（待确认）：${checkpointLoops}`, IMPORT_LIMITS.openLoops);
  }
  return "当前没有未解决的问题或阻塞。";
}

function evidenceStatus(card) {
  const completeness = Number.isFinite(card.completeness)
    ? `${Math.max(0, Math.min(100, Math.round(card.completeness)))}%`
    : "未评估";
  const gaps = boundedBriefList(
    card.readinessGaps,
    REENTRY_BRIEF_GAP_LIMIT,
    IMPORT_LIMITS.returnHint,
    IMPORT_LIMITS.checkpointSummary
  );
  return briefLine(`${completeness} · ${gaps ? `需补：${gaps}` : "无显式复航缺口"}`, IMPORT_LIMITS.checkpointSummary);
}

function briefLine(value, maximum) {
  return compactText(String(value ?? "").replace(/\s+/gu, " "), maximum);
}

function boundedBriefList(values, limit, itemMaximum, outputMaximum, select = (value) => value) {
  if (!Array.isArray(values)) return "";
  let joined = "";
  for (let index = 0; index < values.length && index < limit; index += 1) {
    const item = briefLine(select(values[index]), itemMaximum);
    if (!item) continue;
    joined = briefLine(`${joined}${joined ? "；" : ""}${item}`, outputMaximum);
  }
  return joined;
}

function nonNegativeInteger(value) {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function boundedPercent(value) {
  return `${Number.isFinite(value) ? Math.max(0, Math.min(100, Math.round(value))) : 0}%`;
}

function workspaceStatus(value) {
  return { active: "推进中", paused: "暂泊", blocked: "受阻" }[value] ?? "状态未知";
}

function boundedReasonList(values) {
  if (!Array.isArray(values)) return "";
  let joined = "";
  for (let index = 0; index < values.length && index < WORKSPACE_HANDOFF_REASON_LIMIT; index += 1) {
    const reason = briefLine(values[index], IMPORT_LIMITS.returnHint);
    if (!reason) continue;
    joined = briefLine(`${joined}${joined ? "；" : ""}${reason}`, IMPORT_LIMITS.checkpointSummary);
  }
  return joined;
}

export async function copyPlainText(value, dependencies = {}) {
  const text = String(value ?? "");
  if (text.length > COPY_TEXT_LIMIT) throw new Error("复制内容超过 64 KiB 安全上限。 ");
  if (!text.trim()) throw new Error("没有可复制的简报内容。 ");
  const clipboard = dependencies.clipboard ?? globalThis.navigator?.clipboard;
  let clipboardError = null;
  if (typeof clipboard?.writeText === "function") {
    try {
      await clipboard.writeText(text);
      return "clipboard";
    } catch (error) {
      clipboardError = error;
    }
  }

  const documentRef = dependencies.document ?? globalThis.document;
  if (!documentRef?.body || typeof documentRef.createElement !== "function") {
    throw new Error(clipboardError ? `无法写入剪贴板：${errorMessage(clipboardError)}` : "当前环境不支持复制。 ");
  }
  const previousFocus = captureFocus(documentRef.activeElement);
  const control = documentRef.createElement("textarea");
  let attached = false;
  try {
    control.value = text;
    control.readOnly = true;
    control.setAttribute("aria-hidden", "true");
    control.style.position = "fixed";
    control.style.opacity = "0";
    documentRef.body.append(control);
    attached = true;
    control.select();
    if (documentRef.execCommand?.("copy") !== true) {
      throw new Error(clipboardError ? `无法写入剪贴板：${errorMessage(clipboardError)}` : "浏览器拒绝了复制操作。 ");
    }
    return "fallback";
  } finally {
    if (attached || control.isConnected === true) safelyRemove(control);
    restoreFocus(previousFocus);
  }
}

function captureFocus(element) {
  if (!element || typeof element.focus !== "function") return null;
  const start = Number.isInteger(element.selectionStart) ? element.selectionStart : null;
  const end = Number.isInteger(element.selectionEnd) ? element.selectionEnd : null;
  return { element, start, end };
}

function restoreFocus(snapshot) {
  if (!snapshot) return;
  try {
    snapshot.element.focus({ preventScroll: true });
    if (snapshot.start !== null && snapshot.end !== null && typeof snapshot.element.setSelectionRange === "function") {
      snapshot.element.setSelectionRange(snapshot.start, snapshot.end);
    }
  } catch {
    // A removed or disabled origin control is harmless; copy already completed.
  }
}

function safelyRemove(control) {
  try {
    control.remove();
  } catch {
    // Cleanup failures must not turn a successful copy into a reported failure.
  }
}

function errorMessage(error) {
  return typeof error?.message === "string" && error.message.trim() ? error.message : "权限被拒绝";
}
