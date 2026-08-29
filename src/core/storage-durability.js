export const STORAGE_DURABILITY_STATUS = Object.freeze({
  GRANTED: "granted",
  DENIED: "denied",
  UNSUPPORTED: "unsupported",
  ERROR: "error"
});

export async function requestPersistentStorage(storageManager) {
  try {
    if (storageManager === null || storageManager === undefined) {
      return STORAGE_DURABILITY_STATUS.UNSUPPORTED;
    }
    const persist = storageManager.persist;
    if (typeof persist !== "function") return STORAGE_DURABILITY_STATUS.UNSUPPORTED;
    const granted = await Reflect.apply(persist, storageManager, []);
    return granted === true ? STORAGE_DURABILITY_STATUS.GRANTED : STORAGE_DURABILITY_STATUS.DENIED;
  } catch {
    return STORAGE_DURABILITY_STATUS.ERROR;
  }
}
