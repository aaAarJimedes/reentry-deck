export const MAX_BACKUP_FILE_BYTES = 25 * 1024 * 1024;

export async function readBackupFile(file) {
  if (!file || typeof file.text !== "function") {
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
    text = await file.text();
  } catch (error) {
    throw new Error("无法读取备份文件。 ", { cause: error });
  }

  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error("备份不是有效的 JSON 文件。 ", { cause: error });
  }
}
