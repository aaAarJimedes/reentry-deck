import { IMPORT_LIMITS, compactText } from "./model.js";

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

function currentOpenLoops(card) {
  if (!Array.isArray(card.unresolvedSignals)) {
    return briefLine(card.openLoops || "当前没有未解决的问题或阻塞。", IMPORT_LIMITS.openLoops);
  }
  const current = card.unresolvedSignals
    .map((signal) => briefLine(signal?.text, IMPORT_LIMITS.crumbText))
    .filter(Boolean)
    .join("；");
  if (current) return briefLine(current, IMPORT_LIMITS.openLoops);
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
  const gaps = Array.isArray(card.readinessGaps)
    ? card.readinessGaps.map((gap) => briefLine(gap, IMPORT_LIMITS.returnHint)).filter(Boolean).join("；")
    : "";
  return briefLine(`${completeness} · ${gaps ? `需补：${gaps}` : "无显式复航缺口"}`, IMPORT_LIMITS.checkpointSummary);
}

function briefLine(value, maximum) {
  return compactText(String(value ?? "").replace(/\s+/gu, " "), maximum);
}

export async function copyPlainText(value, dependencies = {}) {
  const text = String(value ?? "");
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
