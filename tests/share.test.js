import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { buildReentryBrief, copyPlainText } from "../src/core/share.js";

describe("buildReentryBrief", () => {
  test("builds a focused bounded plain-text handoff", () => {
    const brief = buildReentryBrief({
      project: { title: "客户门户" },
      summary: "已定位邀请失效\n返回。",
      nextAction: "补画失效分支。",
      openLoops: "确认旧邀请是否可重发。",
      returnHint: "从接口响应样例继续。"
    });
    assert.equal(brief, [
      "【客户门户｜复航简报】",
      "当前状态：已定位邀请失效 返回。",
      "第一动作：补画失效分支。",
      "未决事项：确认旧邀请是否可重发。",
      "复航提示：从接口响应样例继续。"
    ].join("\n"));

    const bounded = buildReentryBrief({
      project: { title: "Long" },
      summary: "state",
      nextAction: "act",
      openLoops: "😀".repeat(500),
      returnHint: "return"
    }).split("\n")[3].slice("未决事项：".length);
    assert.ok(bounded.length <= 800);
    assert.match(bounded, /😀…$/u);
    assert.equal(buildReentryBrief({ project: { title: " A\tB " }, summary: "s", nextAction: "n", openLoops: "", returnHint: "r" }).split("\n")[0], "【A B｜复航简报】");
    assert.throws(() => buildReentryBrief(null), /缺少可生成简报/u);
  });
});

describe("copyPlainText", () => {
  test("prefers the asynchronous Clipboard API", async () => {
    const writes = [];
    const result = await copyPlainText("brief", { clipboard: { writeText: async (text) => writes.push(text) } });
    assert.equal(result, "clipboard");
    assert.deepEqual(writes, ["brief"]);
  });

  test("falls back after a denied Clipboard API call and always removes its control", async () => {
    const events = [];
    const control = {
      style: {},
      setAttribute(name, value) { events.push(`attribute:${name}:${value}`); },
      select() { events.push("select"); },
      remove() { events.push("remove"); }
    };
    const result = await copyPlainText("brief", {
      clipboard: { writeText: async () => { throw new Error("permission denied"); } },
      document: {
        body: { append(node) { assert.strictEqual(node, control); events.push("append"); } },
        createElement(name) { assert.equal(name, "textarea"); return control; },
        execCommand(command) { events.push(`exec:${command}`); return true; }
      }
    });
    assert.equal(result, "fallback");
    assert.equal(control.value, "brief");
    assert.deepEqual(events, ["attribute:aria-hidden:true", "append", "select", "exec:copy", "remove"]);
  });

  test("reports unsupported or rejected copy without leaking a fallback control", async () => {
    await assert.rejects(() => copyPlainText(" ", {}), /没有可复制/u);
    await assert.rejects(() => copyPlainText("brief", { clipboard: null, document: null }), /不支持复制/u);

    let removed = false;
    await assert.rejects(() => copyPlainText("brief", {
      clipboard: { writeText: async () => { throw new Error("denied"); } },
      document: {
        body: { append() {} },
        createElement() {
          return { style: {}, setAttribute() {}, select() {}, remove() { removed = true; } };
        },
        execCommand() { return false; }
      }
    }), /无法写入剪贴板：denied/u);
    assert.equal(removed, true);
  });
});
