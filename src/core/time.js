const rtf = new Intl.RelativeTimeFormat("zh-CN", { numeric: "auto" });
const shortDateTime = new Intl.DateTimeFormat("zh-CN", {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit"
});

export function elapsedSeconds(startedAt, endedAt = Date.now()) {
  const start = timestampOf(startedAt);
  const end = timestampOf(endedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 0;
  return Math.max(0, Math.floor((end - start) / 1000));
}

export function formatDuration(totalSeconds, { compact = false } = {}) {
  const numericValue = Number(totalSeconds);
  const seconds = Number.isFinite(numericValue) ? Math.max(0, Math.floor(numericValue)) : 0;
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  if (compact) {
    if (hours) return `${hours}时${minutes}分`;
    if (minutes) return `${minutes}分`;
    return `${remainder}秒`;
  }
  return [hours, minutes, remainder].map((part) => String(part).padStart(2, "0")).join(":");
}

export function formatRelative(isoDate, now = Date.now()) {
  const timestamp = timestampOf(isoDate);
  const reference = timestampOf(now);
  if (!Number.isFinite(timestamp) || !Number.isFinite(reference)) return "时间未知";
  const difference = timestamp - reference;
  const absolute = Math.abs(difference);
  if (absolute < 60_000) return "刚刚";
  if (absolute < 3_600_000) return rtf.format(Math.round(difference / 60_000), "minute");
  if (absolute < 86_400_000) return rtf.format(Math.round(difference / 3_600_000), "hour");
  if (absolute < 2_592_000_000) return rtf.format(Math.round(difference / 86_400_000), "day");
  return shortDateTime.format(new Date(timestamp));
}

export function formatDateTime(isoDate) {
  const date = new Date(isoDate);
  return Number.isFinite(date.getTime()) ? shortDateTime.format(date) : "时间未知";
}

export function daysSince(isoDate, now = Date.now()) {
  const timestamp = timestampOf(isoDate);
  const reference = timestampOf(now);
  return Number.isFinite(timestamp) && Number.isFinite(reference) ? Math.max(0, (reference - timestamp) / 86_400_000) : 0;
}

function timestampOf(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : Number.NaN;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : Number.NaN;
}
