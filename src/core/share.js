import { IMPORT_LIMITS, compactText } from "./model.js";

export function buildReentryBrief(card) {
  if (!card?.project) throw new TypeError("缺少可生成简报的项目现场。 ");
  return [
    `【${briefLine(card.project.title, IMPORT_LIMITS.projectTitle)}｜复航简报】`,
    `当前状态：${briefLine(card.summary, IMPORT_LIMITS.checkpointSummary)}`,
    `第一动作：${briefLine(card.nextAction, IMPORT_LIMITS.nextAction)}`,
    `未决事项：${briefLine(card.openLoops || "当前没有未解决的问题或阻塞。", IMPORT_LIMITS.openLoops)}`,
    `复航提示：${briefLine(card.returnHint, IMPORT_LIMITS.returnHint)}`
  ].join("\n");
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
