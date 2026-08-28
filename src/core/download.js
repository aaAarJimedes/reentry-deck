export const DOWNLOAD_REVOKE_DELAY_MS = 1_000;

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
    link.download = String(filename ?? "download.json");
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
