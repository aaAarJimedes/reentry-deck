import { IMPORT_LIMITS, compactText, containsLoneSurrogate } from "./model.js";
import { safeDiagnosticMessage } from "./diagnostic.js";

export const WORKSPACE_HANDOFF_PROJECT_LIMIT = 5;
export const WORKSPACE_HANDOFF_INPUT_SCAN_LIMIT = 20;
export const REENTRY_BRIEF_SIGNAL_LIMIT = 3;
export const REENTRY_BRIEF_GAP_LIMIT = 6;
export const COPY_TEXT_LIMIT = 64 * 1024;
export const SHARE_TEXT_SCAN_LIMIT = 4_096;
const WORKSPACE_HANDOFF_ATTENTION_LIMIT = 4;
const WORKSPACE_HANDOFF_REASON_LIMIT = 3;

export function buildReentryBrief(card) {
  const fields = reentryBriefFields(card);
  return [
    `【${fields.title}｜复航简报】`,
    `项目状态：${fields.status}`,
    `当前状态：${fields.summary}`,
    `第一动作：${fields.nextAction}`,
    `未决事项：${fields.openLoops}`,
    `复航提示：${fields.returnHint}`,
    `证据状态：${fields.evidence}`
  ].join("\n");
}

export function buildReentryMarkdown(card) {
  const fields = reentryBriefFields(card);
  return [
    `# ${escapeMarkdownInline(fields.title)} · 复航简报`,
    "",
    `- **项目状态：** ${escapeMarkdownInline(fields.status)}`,
    `- **当前状态：** ${escapeMarkdownInline(fields.summary)}`,
    `- **第一动作：** ${escapeMarkdownInline(fields.nextAction)}`,
    `- **未决事项：** ${escapeMarkdownInline(fields.openLoops)}`,
    `- **复航提示：** ${escapeMarkdownInline(fields.returnHint)}`,
    `- **证据状态：** ${escapeMarkdownInline(fields.evidence)}`,
    "",
    "> 由复航台根据本机已记录证据生成；请在继续工作前核对现场。"
  ].join("\n");
}

function reentryBriefFields(card) {
  if (!card?.project) throw new TypeError("缺少可生成简报的项目现场。 ");
  return {
    title: briefLine(card.project.title, IMPORT_LIMITS.projectTitle),
    status: workspaceStatus(card.project.status),
    summary: briefLine(card.summary, IMPORT_LIMITS.checkpointSummary),
    nextAction: briefLine(card.nextAction, IMPORT_LIMITS.nextAction),
    openLoops: currentOpenLoops(card),
    returnHint: briefLine(card.returnHint, IMPORT_LIMITS.returnHint),
    evidence: evidenceStatus(card)
  };
}

function escapeMarkdownInline(value) {
  return value.replace(/[\\`*_[\]{}()<>#+\-.!|~]/gu, "\\$&");
}

export function buildWorkspaceHandoff(overview, now = Date.now()) {
  if (!overview || !Array.isArray(overview.rankedProjects)) {
    throw new TypeError("缺少可生成工作区交接清单的概览。 ");
  }
  const generatedAt = handoffDate(now);
  if (!generatedAt) throw new TypeError("交接清单生成时间无效。 ");
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
    const reasons = boundedReasonList(item.reasons, item.reasonTotal) || "需要人工核对现场";
    lines.push(`- ${briefLine(item.project.title, IMPORT_LIMITS.projectTitle)}：${reasons}`);
  }
  const declaredAttentionTotal = Number.isSafeInteger(overview.attentionTotal) && overview.attentionTotal >= 0
    ? overview.attentionTotal
    : attentionCount;
  const attentionTotal = Math.max(attentionCount, declaredAttentionTotal);
  const attentionRemaining = attentionTotal - attentionCount;
  if (!attentionCount) {
    lines.push(attentionTotal
      ? `- 有 ${attentionTotal} 个项目需要核对，请回到项目舰桥查看`
      : "- 当前没有明显的现场缺口");
  } else if (attentionRemaining) {
    lines.push(`- 另有 ${attentionRemaining} 个项目未列出，请回到项目舰桥核对`);
  }
  lines.push(
    "",
    `七日航迹：${nonNegativeInteger(review.focusedMinutes)} 分钟 · ${nonNegativeInteger(review.sessions)} 段会话 · ${nonNegativeInteger(review.records)} 条轨迹 · 平均复航 ${boundedPercent(review.recoverability)}`,
    "说明：仅根据本机已记录证据生成，不代表产出评价。"
  );
  return lines.join("\n");
}

export function buildWorkspaceHandoffMarkdown(overview, now = Date.now()) {
  const lines = buildWorkspaceHandoff(overview, now).split("\n");
  const markdown = ["# 复航台 · 工作区交接清单", ""];
  for (let index = 1; index < lines.length; index += 1) {
    markdown.push(workspaceHandoffMarkdownLine(lines[index]));
  }
  return markdown.join("\n");
}

function workspaceHandoffMarkdownLine(line) {
  if (!line) return "";
  if (line === "优先复航：") return "## 优先复航";
  if (line === "值得核对：") return "## 值得核对";
  for (const label of ["生成时间", "未归档项目", "当前会话"]) {
    const prefix = `${label}：`;
    if (line.startsWith(prefix)) return `- **${label}：** ${escapeMarkdownInline(line.slice(prefix.length))}`;
  }
  if (line.startsWith("   下一步：")) {
    return `   - **下一步：** ${escapeMarkdownInline(line.slice("   下一步：".length))}`;
  }
  const rankedMatch = /^(\d+)\. (.*)$/u.exec(line);
  if (rankedMatch) return `${rankedMatch[1]}. ${escapeMarkdownInline(rankedMatch[2])}`;
  if (line.startsWith("- ")) return `- ${escapeMarkdownInline(line.slice(2))}`;
  if (line.startsWith("七日航迹：")) {
    return `**七日航迹：** ${escapeMarkdownInline(line.slice("七日航迹：".length))}`;
  }
  if (line.startsWith("说明：")) return `> **说明：** ${escapeMarkdownInline(line.slice("说明：".length))}`;
  return escapeMarkdownInline(line);
}

function currentOpenLoops(card) {
  if (!Array.isArray(card.unresolvedSignals)) {
    return briefLine(card.openLoops || "当前没有未解决的问题或阻塞。", IMPORT_LIMITS.openLoops);
  }
  const current = boundedOpenSignalSummary(card.unresolvedSignals, card.unresolvedSummary);
  if (current) return current;
  const checkpointLoops = card.checkpoint
    ? briefLine(Object.hasOwn(card, "historicalOpenLoops") ? card.historicalOpenLoops : card.openLoops, IMPORT_LIMITS.openLoops)
    : "";
  if (checkpointLoops) {
    return briefLine(`检查点曾记录（待确认）：${checkpointLoops}`, IMPORT_LIMITS.openLoops);
  }
  return "当前没有未解决的问题或阻塞。";
}

function boundedOpenSignalSummary(signals, summary) {
  const items = [];
  for (let index = 0; index < signals.length && index < REENTRY_BRIEF_SIGNAL_LIMIT; index += 1) {
    const item = briefLine(signals[index]?.text, IMPORT_LIMITS.crumbText);
    if (item) items.push(item);
  }
  const declaredTotal = Number.isSafeInteger(summary?.total) && summary.total >= 0
    ? summary.total
    : signals.length;
  const total = Math.max(items.length, declaredTotal);
  if (!items.length) {
    return total ? briefLine(`有 ${total} 条未决事项，请查看完整轨迹。`, IMPORT_LIMITS.openLoops) : "";
  }
  const remaining = total - items.length;
  const suffix = remaining ? `（另有 ${remaining} 条未显示，请查看完整轨迹）` : "";
  const bodyBudget = Math.max(items.length, IMPORT_LIMITS.openLoops - suffix.length);
  return `${joinBoundedSummaryItems(items, bodyBudget)}${suffix}`;
}

function joinBoundedSummaryItems(items, maximum) {
  const separator = "；";
  let remaining = Math.max(items.length, maximum - separator.length * Math.max(0, items.length - 1));
  let joined = "";
  for (let index = 0; index < items.length; index += 1) {
    const itemBudget = Math.max(1, Math.floor(remaining / (items.length - index)));
    const item = compactText(items[index], itemBudget);
    joined += `${joined ? separator : ""}${item}`;
    remaining -= item.length;
  }
  return joined;
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
  if (typeof value !== "string") return "";
  const overflow = value.length > SHARE_TEXT_SCAN_LIMIT;
  let source = overflow ? value.slice(0, SHARE_TEXT_SCAN_LIMIT) : value;
  if (overflow && /[\ud800-\udbff]$/u.test(source)) source = source.slice(0, -1);
  const normalized = source.replace(/\s+/gu, " ");
  return compactText(`${normalized}${overflow ? "…" : ""}`, maximum);
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

function handoffDate(value) {
  let timestamp = Number.NaN;
  if (typeof value === "number") timestamp = value;
  else if (value instanceof Date) timestamp = value.getTime();
  else if (typeof value === "string" && value.trim()) timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? new Date(timestamp) : null;
}

function boundedPercent(value) {
  return `${Number.isFinite(value) ? Math.max(0, Math.min(100, Math.round(value))) : 0}%`;
}

function workspaceStatus(value) {
  return { active: "推进中", paused: "暂泊", blocked: "受阻", archived: "已归档" }[value] ?? "状态未知";
}

function boundedReasonList(values, declaredTotal) {
  if (!Array.isArray(values)) return "";
  const items = [];
  for (let index = 0; index < values.length && index < WORKSPACE_HANDOFF_REASON_LIMIT; index += 1) {
    const reason = briefLine(values[index], IMPORT_LIMITS.returnHint);
    if (!reason) continue;
    items.push(reason);
  }
  const sourceTotal = Number.isSafeInteger(declaredTotal) && declaredTotal >= 0
    ? declaredTotal
    : values.length;
  const total = Math.max(items.length, sourceTotal);
  if (!items.length) return total ? `有 ${total} 项现场缺口未列出` : "";
  const remaining = total - items.length;
  const suffix = remaining ? `（另有 ${remaining} 项现场缺口未列出）` : "";
  const bodyBudget = Math.max(items.length, IMPORT_LIMITS.checkpointSummary - suffix.length);
  return `${joinBoundedSummaryItems(items, bodyBudget)}${suffix}`;
}

export async function copyPlainText(value, dependencies = {}) {
  if (typeof value !== "string") throw new TypeError("复制内容必须是字符串。 ");
  const text = value;
  if (text.length > COPY_TEXT_LIMIT) throw new Error("复制内容超过 64 KiB 安全上限。 ");
  if (containsLoneSurrogate(text)) throw new Error("复制内容包含损坏的 Unicode 字符。 ");
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
    throw new Error(clipboardError ? `无法写入剪贴板：${safeDiagnosticMessage(clipboardError, "权限被拒绝")}` : "当前环境不支持复制。 ");
  }
  const previousFocus = captureFocus(documentRef.activeElement);
  const control = documentRef.createElement("textarea");
  let attached = false;
  try {
    control.value = text;
    control.readOnly = true;
    control.setAttribute("aria-hidden", "true");
    control.setAttribute("class", "clipboard-fallback-control");
    documentRef.body.append(control);
    attached = true;
    control.select();
    if (documentRef.execCommand?.("copy") !== true) {
      throw new Error(clipboardError ? `无法写入剪贴板：${safeDiagnosticMessage(clipboardError, "权限被拒绝")}` : "浏览器拒绝了复制操作。 ");
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
