import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { renderStartupFailure } from "../src/core/startup.js";

function fakeHost() {
  const attributes = new Map();
  const listeners = new Map();
  return {
    attributes,
    listeners,
    html: "",
    setAttribute(name, value) {
      attributes.set(name, value);
    },
    set innerHTML(value) {
      this.html = value;
    },
    get innerHTML() {
      return this.html;
    },
    querySelector(selector) {
      if (selector !== "#retry-startup") return null;
      return {
        addEventListener(type, listener) {
          listeners.set(type, listener);
        }
      };
    }
  };
}

describe("renderStartupFailure", () => {
  test("renders a static recovery surface and wires an explicit retry", () => {
    const host = fakeHost();
    let reloads = 0;

    assert.equal(renderStartupFailure(host, { reload: () => reloads += 1 }), host);
    assert.equal(host.attributes.get("aria-busy"), "false");
    assert.match(host.html, /工作区暂时无法启动/u);
    assert.match(host.html, /id="retry-startup"/u);
    host.listeners.get("click")();
    assert.equal(reloads, 1);
  });

  test("creates a replacement mount when the expected app root is missing", () => {
    const appended = [];
    const host = fakeHost();
    const documentRef = {
      body: { append: (node) => appended.push(node) },
      createElement: (tagName) => {
        assert.equal(tagName, "div");
        return host;
      }
    };

    assert.equal(renderStartupFailure(null, { documentRef, reload() {} }), host);
    assert.deepEqual(appended, [host]);
    assert.equal(host.id, "app");
    assert.match(host.html, /重新尝试/u);
  });

  test("returns a quiet null when even the fallback DOM is unavailable or hostile", () => {
    assert.equal(renderStartupFailure(null, { documentRef: {}, reload() {} }), null);
    assert.equal(renderStartupFailure({}, { documentRef: {}, reload() {} }), null);
    assert.equal(renderStartupFailure({ setAttribute() { throw new Error("blocked"); } }), null);
  });
});
