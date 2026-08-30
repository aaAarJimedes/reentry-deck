import assert from "node:assert/strict";
import test from "node:test";

import { APP_INSTALL_STATUS } from "../src/core/app-install.js";
import { syncAppInstallView } from "../src/ui/app.js";

function createView({ omit = null } = {}) {
  const writes = [];
  const track = (target, property, initial) => {
    let value = initial;
    Object.defineProperty(target, property, {
      enumerable: true,
      get() { return value; },
      set(next) {
        writes.push(`${property}:${String(next)}`);
        value = next;
      }
    });
  };
  const status = {};
  const action = {};
  track(status, "textContent", "initial status");
  track(action, "textContent", "initial action");
  let ariaDisabled = null;
  const control = {
    removeAttribute(name) {
      if (name === "aria-disabled") {
        writes.push("aria-disabled:remove");
        ariaDisabled = null;
      }
    },
    setAttribute(name, value) {
      if (name === "aria-disabled") {
        writes.push(`aria-disabled:${value}`);
        ariaDisabled = value;
      }
    },
    querySelector(selector) {
      return selector === "[data-app-install-action]" && omit !== "action" ? action : null;
    }
  };
  track(control, "hidden", false);
  track(control, "tabIndex", 0);
  Object.defineProperty(control, "ariaDisabled", { enumerable: true, get() { return ariaDisabled; } });
  const unrelated = { id: "import-file" };
  const root = {
    querySelector(selector) {
      if (selector === "#app-install-status") return omit === "status" ? null : status;
      if (selector === '[data-action="install-app"]') return omit === "control" ? null : control;
      if (selector === "#import-file") return unrelated;
      return null;
    }
  };
  Object.defineProperty(root, "innerHTML", {
    set() { throw new Error("install feedback must not rebuild the root"); }
  });
  return { action, control, root, status, unrelated, writes };
}

for (const [statusValue, expected] of [
  [APP_INSTALL_STATUS.UNAVAILABLE, { action: "安装复航台", ariaDisabled: "true", hidden: true, message: /尚未提供站内安装按钮/u, tabIndex: -1 }],
  [APP_INSTALL_STATUS.AVAILABLE, { action: "安装复航台", ariaDisabled: null, hidden: false, message: /已确认可以安装/u, tabIndex: 0 }],
  [APP_INSTALL_STATUS.PROMPTING, { action: "等待浏览器确认", ariaDisabled: "true", hidden: false, message: /安装窗口已打开/u, tabIndex: -1 }],
  [APP_INSTALL_STATUS.ACCEPTED, { action: "等待安装完成", ariaDisabled: "true", hidden: false, message: /尚未确认安装完成/u, tabIndex: -1 }],
  [APP_INSTALL_STATUS.DISMISSED, { action: "等待再次可用", ariaDisabled: "true", hidden: false, message: /本次没有安装/u, tabIndex: -1 }],
  [APP_INSTALL_STATUS.INSTALLED, { action: "已安装", ariaDisabled: "true", hidden: false, message: /已安装，可从独立入口打开/u, tabIndex: -1 }],
  [APP_INSTALL_STATUS.ERROR, { action: "暂不可用", ariaDisabled: "true", hidden: false, message: /无法打开浏览器安装提示/u, tabIndex: -1 }]
]) {
  test(`install feedback projects ${statusValue} without replacing its nodes`, () => {
    const view = createView();
    assert.equal(syncAppInstallView(view.root, statusValue), true);
    assert.match(view.status.textContent, expected.message);
    assert.equal(view.action.textContent, expected.action);
    assert.equal(view.control.ariaDisabled, expected.ariaDisabled);
    assert.equal(view.control.hidden, expected.hidden);
    assert.equal(view.control.tabIndex, expected.tabIndex);
    assert.ok(view.writes.length > 0);
    assert.equal(view.root.querySelector("#import-file"), view.unrelated);
  });
}

test("install feedback leaves every node untouched when the view is incomplete", () => {
  for (const omit of ["status", "control", "action"]) {
    const view = createView({ omit });
    assert.equal(syncAppInstallView(view.root, APP_INSTALL_STATUS.AVAILABLE), false);
    assert.deepEqual(view.writes, []);
    assert.equal(view.status.textContent, "initial status");
    assert.equal(view.action.textContent, "initial action");
    assert.equal(view.control.ariaDisabled, null);
    assert.equal(view.control.hidden, false);
    assert.equal(view.control.tabIndex, 0);
    assert.equal(view.root.querySelector("#import-file"), view.unrelated);
  }
});
