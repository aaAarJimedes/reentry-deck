import assert from "node:assert/strict";
import test from "node:test";

import { STORAGE_DURABILITY_STATUS, inspectPersistentStorage, requestPersistentStorage } from "../src/core/storage-durability.js";

test("persistent storage reports unsupported without a callable capability", async () => {
  assert.equal(await requestPersistentStorage(undefined), STORAGE_DURABILITY_STATUS.UNSUPPORTED);
  assert.equal(await requestPersistentStorage({ persist: true }), STORAGE_DURABILITY_STATUS.UNSUPPORTED);
});

test("persistent storage preserves its receiver and requires an explicit grant", async () => {
  const manager = {
    marker: "manager",
    persist() {
      assert.equal(this, manager);
      return true;
    }
  };

  assert.equal(await requestPersistentStorage(manager), STORAGE_DURABILITY_STATUS.GRANTED);
  assert.equal(await requestPersistentStorage({ persist: async () => false }), STORAGE_DURABILITY_STATUS.DENIED);
  assert.equal(await requestPersistentStorage({ persist: async () => ({ truthy: true }) }), STORAGE_DURABILITY_STATUS.DENIED);
});

test("persistent storage absorbs hostile capability access and invocation", async () => {
  const hostileGetter = {};
  Object.defineProperty(hostileGetter, "persist", { get() { throw new Error("denied"); } });

  assert.equal(await requestPersistentStorage(hostileGetter), STORAGE_DURABILITY_STATUS.ERROR);
  assert.equal(await requestPersistentStorage({ persist() { throw new Error("denied"); } }), STORAGE_DURABILITY_STATUS.ERROR);
  assert.equal(await requestPersistentStorage({ persist: async () => Promise.reject(new Error("denied")) }), STORAGE_DURABILITY_STATUS.ERROR);
});

test("persistent storage reads the capability only once", async () => {
  let reads = 0;
  const manager = {};
  Object.defineProperty(manager, "persist", {
    get() {
      reads += 1;
      return () => true;
    }
  });

  assert.equal(await requestPersistentStorage(manager), STORAGE_DURABILITY_STATUS.GRANTED);
  assert.equal(reads, 1);
});

test("persistent storage inspection is read-only and preserves its receiver", async () => {
  const manager = {
    persisted() {
      assert.equal(this, manager);
      return true;
    },
    persist() {
      throw new Error("inspection must not request permission");
    }
  };

  assert.equal(await inspectPersistentStorage(manager), STORAGE_DURABILITY_STATUS.GRANTED);
  assert.equal(await inspectPersistentStorage({ persisted: async () => false }), STORAGE_DURABILITY_STATUS.DENIED);
  assert.equal(await inspectPersistentStorage({ persisted: async () => "true" }), STORAGE_DURABILITY_STATUS.DENIED);
});

test("persistent storage inspection distinguishes unsupported and failed capabilities", async () => {
  const hostile = {};
  Object.defineProperty(hostile, "persisted", { get() { throw new Error("denied"); } });

  assert.equal(await inspectPersistentStorage({}), STORAGE_DURABILITY_STATUS.UNSUPPORTED);
  assert.equal(await inspectPersistentStorage(hostile), STORAGE_DURABILITY_STATUS.ERROR);
  assert.equal(await inspectPersistentStorage({ persisted: async () => Promise.reject(new Error("denied")) }), STORAGE_DURABILITY_STATUS.ERROR);
});
