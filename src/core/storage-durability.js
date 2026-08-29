export const STORAGE_DURABILITY_STATUS = Object.freeze({
  GRANTED: "granted",
  DENIED: "denied",
  UNKNOWN: "unknown",
  UNSUPPORTED: "unsupported",
  ERROR: "error"
});

async function callStorageBoolean(storageManager, methodName, missingMethodStatus = STORAGE_DURABILITY_STATUS.UNSUPPORTED) {
  try {
    if (storageManager === null || storageManager === undefined) {
      return STORAGE_DURABILITY_STATUS.UNSUPPORTED;
    }
    const method = storageManager[methodName];
    if (typeof method !== "function") return missingMethodStatus;
    const granted = await Reflect.apply(method, storageManager, []);
    return granted === true ? STORAGE_DURABILITY_STATUS.GRANTED : STORAGE_DURABILITY_STATUS.DENIED;
  } catch {
    return STORAGE_DURABILITY_STATUS.ERROR;
  }
}

export function requestPersistentStorage(storageManager) {
  return callStorageBoolean(storageManager, "persist");
}

export function inspectPersistentStorage(storageManager) {
  return callStorageBoolean(storageManager, "persisted", STORAGE_DURABILITY_STATUS.UNKNOWN);
}
