export const DOWNLOAD_REVOKE_DELAY_MS = 1_000;
export const DOWNLOAD_FILENAME_LIMIT = 160;
export const DOWNLOAD_FILENAME_SCAN_LIMIT = 640;

export function safeDownloadFilename(value) {
  if (typeof value !== "string") return "download.json";
  let result = "";
  let pendingSpace = false;
  let scanned = 0;
  for (const character of value) {
    if (scanned + character.length > DOWNLOAD_FILENAME_SCAN_LIMIT) break;
    scanned += character.length;
    if (/\s/u.test(character)) {
      pendingSpace = Boolean(result);
      continue;
    }
    if (/[\u0000-\u001f\u007f-\u009f\u200b\u200e\u200f\u202a-\u202e\u2060-\u206f\ufeff]/u.test(character)) continue;
    const projected = /[\\/:*?"<>|]/u.test(character) ? "-" : character;
    if (result.length + (pendingSpace ? 1 : 0) + projected.length > DOWNLOAD_FILENAME_LIMIT) break;
    if (pendingSpace) result += " ";
    pendingSpace = false;
    result += projected;
  }
  result = result.replace(/^[. ]+|[. ]+$/gu, "");
  if (!result) return "download.json";
  if (/^(?:con|prn|aux|nul|conin\$|conout\$|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(result)) {
    if (result.length === DOWNLOAD_FILENAME_LIMIT) {
      result = result.slice(0, /[\udc00-\udfff]$/u.test(result) ? -2 : -1);
    }
    result = `_${result}`;
  }
  return result;
}

export function triggerBlobDownload(blob, filename, dependencies = {}) {
  const documentRef = dependencies.document ?? globalThis.document;
  const urlApi = dependencies.urlApi ?? globalThis.URL;
  const schedule = dependencies.schedule ?? ((callback, delay) => globalThis.setTimeout(callback, delay));
  if (!documentRef?.body || typeof documentRef.createElement !== "function") {
    throw new Error("当前环境无法建立下载链接。 ");
  }
  if (typeof urlApi?.createObjectURL !== "function" || typeof urlApi?.revokeObjectURL !== "function") {
    throw new Error("当前环境不支持本地文件下载。 ");
  }
  if (typeof schedule !== "function") throw new TypeError("下载清理调度器无效。 ");

  const url = urlApi.createObjectURL(blob);
  let link = null;
  let attached = false;
  let revokeScheduled = false;
  try {
    link = documentRef.createElement("a");
    link.href = url;
    link.download = safeDownloadFilename(filename);
    link.hidden = true;
    documentRef.body.append(link);
    attached = true;
    link.click();
    schedule(() => safelyRevoke(urlApi, url), DOWNLOAD_REVOKE_DELAY_MS);
    revokeScheduled = true;
  } finally {
    if (attached) safelyRemove(link);
    if (!revokeScheduled) safelyRevoke(urlApi, url);
  }
}

function safelyRemove(link) {
  try {
    link?.remove();
  } catch {
    // The browser owns a detached download control; cleanup must not mask the download result.
  }
}

function safelyRevoke(urlApi, url) {
  try {
    urlApi.revokeObjectURL(url);
  } catch {
    // Object URL cleanup is best-effort and must not replace the initiating failure.
  }
}
