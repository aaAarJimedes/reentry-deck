export const MAX_BACKUP_FILE_BYTES = 25 * 1024 * 1024;

export function createLatestRequestGate() {
  let latest = null;
  return Object.freeze({
    begin() {
      const token = {};
      latest = token;
      return () => latest === token;
    },
    invalidate() {
      latest = null;
    }
  });
}

export async function readBackupFile(file, options = {}) {
  if (!file || (typeof file.stream !== "function" && typeof file.text !== "function")) {
    throw new Error("没有可读取的备份文件。 ");
  }

  const size = Number(file.size);
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new Error("无法确认备份文件大小，已停止导入。 ");
  }
  if (size > MAX_BACKUP_FILE_BYTES) {
    throw new Error("备份超过 25 MB，已停止导入以保护页面稳定性。 ");
  }

  let text;
  try {
    text = typeof file.stream === "function"
      ? await readBackupStream(file, options.signal)
      : await readBackupTextFallback(file, options.signal);
  } catch (error) {
    if (error?.name === "BackupReadError") throw error;
    throw new Error("无法读取备份文件。 ", { cause: error });
  }

  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error("备份不是有效的 JSON 文件。 ", { cause: error });
  }
}

async function readBackupStream(file, signal) {
  if (signal?.aborted) throw backupReadError("备份读取已取消。 ");
  const reader = file.stream().getReader();
  const decoder = new TextDecoder();
  const chunks = [];
  let bytesRead = 0;
  const cancel = () => {
    try {
      Promise.resolve(reader.cancel()).catch(() => {});
    } catch {
      // Cancellation is best-effort; the request gate still blocks stale data.
    }
  };
  signal?.addEventListener?.("abort", cancel, { once: true });
  try {
    while (true) {
      const result = await reader.read();
      if (signal?.aborted) throw backupReadError("备份读取已取消。 ");
      if (result.done) break;
      if (!(result.value instanceof Uint8Array)) throw new TypeError("Invalid backup byte stream");
      bytesRead += result.value.byteLength;
      if (!Number.isSafeInteger(bytesRead) || bytesRead > MAX_BACKUP_FILE_BYTES) {
        cancel();
        throw backupReadError("备份实际内容超过 25 MB，已停止导入以保护页面稳定性。 ");
      }
      chunks.push(decoder.decode(result.value, { stream: true }));
    }
    chunks.push(decoder.decode());
    return chunks.join("");
  } finally {
    signal?.removeEventListener?.("abort", cancel);
    try {
      reader.releaseLock();
    } catch {
      // A canceled stream may already have released its lock.
    }
  }
}

async function readBackupTextFallback(file, signal) {
  if (signal?.aborted) throw backupReadError("备份读取已取消。 ");
  const text = await file.text();
  if (signal?.aborted) throw backupReadError("备份读取已取消。 ");
  if (typeof text !== "string") throw new TypeError("Invalid backup text");
  if (utf8ByteLength(text) > MAX_BACKUP_FILE_BYTES) {
    throw backupReadError("备份实际内容超过 25 MB，已停止导入以保护页面稳定性。 ");
  }
  return text;
}

function utf8ByteLength(value) {
  let bytes = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    bytes += codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
    if (bytes > MAX_BACKUP_FILE_BYTES) return bytes;
  }
  return bytes;
}

function backupReadError(message) {
  const error = new Error(message);
  error.name = "BackupReadError";
  return error;
}
