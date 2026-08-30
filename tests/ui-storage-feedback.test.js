import assert from "node:assert/strict";
import test from "node:test";

import { isSettingsRoute, syncStorageDurabilityView } from "../src/ui/app.js";

test("storage durability feedback updates only the existing view nodes", () => {
  const status = { textContent: "正在检查" };
  const action = { textContent: "正在检查" };
  const fileInput = { isConnected: true };
  const control = {
    disabled: true,
    querySelector(selector) {
      return selector === "[data-storage-durability-action]" ? action : null;
    }
  };
  const root = {
    querySelector(selector) {
      if (selector === "#storage-durability-status") return status;
      if (selector === '[data-action="request-persistent-storage"]') return control;
      if (selector === "#import-file") return fileInput;
      return null;
    }
  };
  let rootRebuilds = 0;
  Object.defineProperty(root, "innerHTML", {
    set() {
      rootRebuilds += 1;
      throw new Error("storage feedback must not rebuild the application root");
    }
  });

  assert.equal(syncStorageDurabilityView(root, "denied"), true);
  assert.equal(status.textContent, "浏览器尚未授予持久保护；请定期导出 JSON 备份。");
  assert.equal(action.textContent, "重新请求保护");
  assert.equal(control.disabled, false);
  assert.equal(rootRebuilds, 0);
  assert.equal(root.querySelector("#storage-durability-status"), status);
  assert.equal(root.querySelector('[data-action="request-persistent-storage"]'), control);
  assert.equal(root.querySelector("#import-file"), fileInput);

  assert.equal(syncStorageDurabilityView(root, "granted"), true);
  assert.equal(action.textContent, "已受保护");
  assert.equal(control.disabled, true);
  assert.equal(rootRebuilds, 0);
});

test("storage durability feedback leaves every node untouched when the view is incomplete", () => {
  for (const missing of ["status", "control", "action"]) {
    const writes = [];
    const status = {};
    const action = {};
    const control = {
      querySelector(selector) {
        if (selector !== "[data-storage-durability-action]" || missing === "action") return null;
        return action;
      }
    };
    Object.defineProperty(status, "textContent", { set(value) { writes.push(["status", value]); } });
    Object.defineProperty(action, "textContent", { set(value) { writes.push(["action", value]); } });
    Object.defineProperty(control, "disabled", { set(value) { writes.push(["control", value]); } });
    const root = {
      querySelector(selector) {
        if (selector === "#storage-durability-status") return missing === "status" ? null : status;
        if (selector === '[data-action="request-persistent-storage"]') return missing === "control" ? null : control;
        return null;
      }
    };
    let rootRebuilds = 0;
    Object.defineProperty(root, "innerHTML", {
      set() {
        rootRebuilds += 1;
        throw new Error("an incomplete storage view must not rebuild the application root");
      }
    });

    assert.equal(syncStorageDurabilityView(root, "error"), false, missing);
    assert.deepEqual(writes, [], missing);
    assert.equal(rootRebuilds, 0, missing);
  }
});

test("storage durability feedback follows every supported settings hash", () => {
  assert.equal(isSettingsRoute("#/settings"), true);
  assert.equal(isSettingsRoute("#settings"), true);
  assert.equal(isSettingsRoute("#/settings/extra"), false);
  assert.equal(isSettingsRoute("#/archive"), false);
  assert.equal(isSettingsRoute("#/project/settings"), false);
});
