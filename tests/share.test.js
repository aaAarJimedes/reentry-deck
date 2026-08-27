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
      returnHint: "从接口响应样例继续。",
      completeness: 75,
      readinessGaps: ["写下材料入口"]
    });
    assert.equal(brief, [
      "【客户门户｜复航简报】",
      "当前状态：已定位邀请失效 返回。",
      "第一动作：补画失效分支。",
      "未决事项：确认旧邀请是否可重发。",
      "复航提示：从接口响应样例继续。",
      "证据状态：75% · 需补：写下材料入口"
    ].join("\n"));

    const bounded = buildReentryBrief({
      project: { title: "Long" },
      summary: "state",
      nextAction: "act",
      openLoops: "😀".repeat(500),
      returnHint: "return",
      completeness: 100,
      readinessGaps: []
    }).split("\n")[3].slice("未决事项：".length);
    assert.ok(bounded.length <= 800);
    assert.match(bounded, /😀…$/u);
    assert.equal(buildReentryBrief({ project: { title: " A\tB " }, summary: "s", nextAction: "n", openLoops: "", returnHint: "r" }).split("\n")[0], "【A B｜复航简报】");
    assert.throws(() => buildReentryBrief(null), /缺少可生成简报/u);
  });

  test("prefers live unresolved signals and labels checkpoint-only loops as historical", () => {
    const base = {
      project: { title: "P" },
      summary: "state",
      nextAction: "next",
      returnHint: "hint",
      completeness: 50,
      readinessGaps: ["核对 1 段未收拢或中断的会话"]
    };
    const live = buildReentryBrief({
      ...base,
      checkpoint: { id: "cp" },
      openLoops: "stale checkpoint loop",
      unresolvedSignals: [{ text: "new blocker" }, { text: "new question" }]
    });
    assert.match(live, /未决事项：new blocker；new question/u);
    assert.doesNotMatch(live, /stale checkpoint loop/u);
    assert.match(live, /证据状态：50% · 需补：核对 1 段未收拢或中断的会话/u);

    const historical = buildReentryBrief({
      ...base,
      checkpoint: { id: "cp" },
      openLoops: "old loop",
      unresolvedSignals: []
    });
    assert.match(historical, /未决事项：检查点曾记录（待确认）：old loop/u);

    const boundedHistorical = buildReentryBrief({
      ...base,
      checkpoint: { id: "cp" },
      openLoops: "😀".repeat(400),
      unresolvedSignals: []
    }).split("\n")[3].slice("未决事项：".length);
    assert.ok(boundedHistorical.length <= 800);
    assert.match(boundedHistorical, /^检查点曾记录（待确认）：/u);
    assert.doesNotMatch(boundedHistorical, /[\uD800-\uDBFF]$/u);

    const clear = buildReentryBrief({ ...base, openLoops: "", unresolvedSignals: [], readinessGaps: [] });
    assert.match(clear, /未决事项：当前没有未解决的问题或阻塞。/u);
    assert.match(clear, /证据状态：50% · 无显式复航缺口/u);
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
    const previousFocus = {
      selectionStart: 2,
      selectionEnd: 5,
      focus(options) { events.push(`focus:${options.preventScroll}`); },
      setSelectionRange(start, end) { events.push(`selection:${start}:${end}`); }
    };
    const control = {
      style: {},
      setAttribute(name, value) { events.push(`attribute:${name}:${value}`); },
      select() { events.push("select"); },
      remove() { events.push("remove"); }
    };
    const result = await copyPlainText("brief", {
      clipboard: { writeText: async () => { throw new Error("permission denied"); } },
      document: {
        activeElement: previousFocus,
        body: { append(node) { assert.strictEqual(node, control); events.push("append"); } },
        createElement(name) { assert.equal(name, "textarea"); return control; },
        execCommand(command) { events.push(`exec:${command}`); return true; }
      }
    });
    assert.equal(result, "fallback");
    assert.equal(control.value, "brief");
    assert.deepEqual(events, ["attribute:aria-hidden:true", "append", "select", "exec:copy", "remove", "focus:true", "selection:2:5"]);
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

  test("does not let fallback cleanup or focus restoration mask a successful copy", async () => {
    const result = await copyPlainText("brief", {
      clipboard: null,
      document: {
        activeElement: {
          focus() { throw new Error("detached"); }
        },
        body: { append() {} },
        createElement() {
          return {
            style: {},
            setAttribute() {},
            select() {},
            remove() { throw new Error("cleanup denied"); }
          };
        },
        execCommand() { return true; }
      }
    });
    assert.equal(result, "fallback");
  });
});
