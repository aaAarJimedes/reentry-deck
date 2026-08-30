import assert from "node:assert/strict";
import test from "node:test";

import { syncStorageDurabilityView } from "../src/ui/app.js";

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
    identity: "same-root",
    querySelector(selector) {
      if (selector === "#storage-durability-status") return status;
      if (selector === '[data-action="request-persistent-storage"]') return control;
      if (selector === "#import-file") return fileInput;
      return null;
    }
  };

  assert.equal(syncStorageDurabilityView(root, "denied"), true);
  assert.equal(status.textContent, "浏览器尚未授予持久保护；请定期导出 JSON 备份。");
  assert.equal(action.textContent, "重新请求保护");
  assert.equal(control.disabled, false);
  assert.equal(root.identity, "same-root");
  assert.equal(root.querySelector("#import-file"), fileInput);

  assert.equal(syncStorageDurabilityView(root, "granted"), true);
  assert.equal(action.textContent, "已受保护");
  assert.equal(control.disabled, true);

  const partialStatus = { textContent: "保持原值" };
  const partialRoot = { querySelector: (selector) => selector === "#storage-durability-status" ? partialStatus : null };
  assert.equal(syncStorageDurabilityView(partialRoot, "error"), false);
  assert.equal(partialStatus.textContent, "保持原值");
});
