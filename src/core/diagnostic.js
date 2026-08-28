import { compactText } from "./model.js";

export const DIAGNOSTIC_MESSAGE_LIMIT = 500;
export const DIAGNOSTIC_SCAN_LIMIT = 1_000;

const DEFAULT_DIAGNOSTIC = "操作未完成，请根据最新状态重试。 ";

export function safeDiagnosticMessage(error, fallback = DEFAULT_DIAGNOSTIC) {
  const safeFallback = projectFallback(typeof fallback === "string" ? fallback : DEFAULT_DIAGNOSTIC)
    || DEFAULT_DIAGNOSTIC;
  let message;
  try {
    message = error?.message;
  } catch {
    return safeFallback;
  }
  if (typeof message !== "string") return safeFallback;
  return projectDiagnostic(message) || safeFallback;
}

function projectDiagnostic(value) {
  return compactText(diagnosticWindow(value), DIAGNOSTIC_MESSAGE_LIMIT);
}

function projectFallback(value) {
  const projected = diagnosticWindow(value);
  if (!projected.trim()) return "";
  return projected.length <= DIAGNOSTIC_MESSAGE_LIMIT
    ? projected
    : compactText(projected, DIAGNOSTIC_MESSAGE_LIMIT);
}

function diagnosticWindow(value) {
  let end = Math.min(value.length, DIAGNOSTIC_SCAN_LIMIT);
  if (end < value.length && isHighSurrogate(value.charCodeAt(end - 1)) && isLowSurrogate(value.charCodeAt(end))) {
    end -= 1;
  }
  return replaceLoneSurrogates(value.slice(0, end));
}

function replaceLoneSurrogates(value) {
  let result = "";
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (isHighSurrogate(unit)) {
      const next = value.charCodeAt(index + 1);
      if (isLowSurrogate(next)) {
        result += value[index] + value[index + 1];
        index += 1;
      } else result += "�";
    } else result += isLowSurrogate(unit) ? "�" : value[index];
  }
  return result;
}

function isHighSurrogate(value) {
  return value >= 0xd800 && value <= 0xdbff;
}

function isLowSurrogate(value) {
  return value >= 0xdc00 && value <= 0xdfff;
}
