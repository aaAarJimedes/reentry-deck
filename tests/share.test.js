import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { COPY_TEXT_LIMIT, REENTRY_BRIEF_GAP_LIMIT, REENTRY_BRIEF_SIGNAL_LIMIT, SHARE_TEXT_SCAN_LIMIT, WORKSPACE_HANDOFF_INPUT_SCAN_LIMIT, WORKSPACE_HANDOFF_PROJECT_LIMIT, buildReentryBrief, buildReentryMarkdown, buildWorkspaceHandoff, buildWorkspaceHandoffMarkdown, copyPlainText } from "../src/core/share.js";

describe("buildReentryBrief", () => {
  test("builds a focused bounded plain-text handoff", () => {
    const brief = buildReentryBrief({
      project: { title: "客户门户", status: "blocked", updatedAt: "2026-08-28T08:00:00.000Z" },
      summary: "已定位邀请失效\n返回。",
      nextAction: "补画失效分支。",
      openLoops: "确认旧邀请是否可重发。",
      returnHint: "从接口响应样例继续。",
      completeness: 75,
      readinessGaps: ["写下材料入口"]
    });
    assert.equal(brief, [
      "【客户门户｜复航简报】",
      "项目状态：受阻",
      "现场更新：2026-08-28T08:00:00.000Z",
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
    }).split("\n").find((line) => line.startsWith("未决事项："))?.slice("未决事项：".length) ?? "";
    assert.ok(bounded.length <= 800);
    assert.match(bounded, /😀…$/u);
    assert.equal(buildReentryBrief({ project: { title: " A\tB " }, summary: "s", nextAction: "n", openLoops: "", returnHint: "r" }).split("\n")[0], "【A B｜复航简报】");
    assert.match(buildReentryBrief({ project: { title: "Unknown", status: "mystery" }, summary: "s", nextAction: "n", returnHint: "r" }), /项目状态：状态未知/u);
    let timeConversions = 0;
    const hostileTime = { toString() { timeConversions += 1; throw new Error("timestamp coercion must not run"); } };
    assert.match(buildReentryBrief({ project: { title: "Unknown time", status: "active", updatedAt: hostileTime }, summary: "s", nextAction: "n", returnHint: "r" }), /现场更新：时间未知/u);
    assert.equal(timeConversions, 0);
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
      unresolvedSignals: [{ text: "new blocker" }, { text: "new question" }],
      unresolvedSummary: { total: 4 }
    });
    assert.match(live, /未决事项：new blocker；new question（另有 2 条未显示，请查看完整轨迹）/u);
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
    }).split("\n").find((line) => line.startsWith("未决事项："))?.slice("未决事项：".length) ?? "";
    assert.ok(boundedHistorical.length <= 800);
    assert.match(boundedHistorical, /^检查点曾记录（待确认）：/u);
    assert.doesNotMatch(boundedHistorical, /[\uD800-\uDBFF]$/u);

    const clear = buildReentryBrief({ ...base, openLoops: "", unresolvedSignals: [], readinessGaps: [] });
    assert.match(clear, /未决事项：当前没有未解决的问题或阻塞。/u);
    assert.match(clear, /证据状态：50% · 无显式复航缺口/u);

    const projectedClear = buildReentryBrief({
      ...base,
      checkpoint: { id: "quick" },
      openLoops: "未解决的问题或阻塞未记录。",
      historicalOpenLoops: "",
      unresolvedSignals: []
    });
    assert.match(projectedClear, /未决事项：当前没有未解决的问题或阻塞。/u);
    assert.doesNotMatch(projectedClear, /曾记录/u);
  });

  test("reads only the producer-bounded signal and readiness windows", () => {
    const signals = Array.from({ length: REENTRY_BRIEF_SIGNAL_LIMIT }, (_, index) => ({ text: `signal ${index + 1}` }));
    Object.defineProperty(signals, REENTRY_BRIEF_SIGNAL_LIMIT, { get() { throw new Error("signal window exceeded"); } });
    signals.length = 50_000;
    const gaps = Array.from({ length: REENTRY_BRIEF_GAP_LIMIT }, (_, index) => `gap ${index + 1}`);
    Object.defineProperty(gaps, REENTRY_BRIEF_GAP_LIMIT, { get() { throw new Error("gap window exceeded"); } });
    gaps.length = 50_000;

    const brief = buildReentryBrief({
      project: { title: "Bounded" },
      summary: "state",
      nextAction: "next",
      returnHint: "hint",
      unresolvedSignals: signals,
      unresolvedSummary: { total: 50_000 },
      readinessGaps: gaps,
      completeness: 50
    });

    assert.match(brief, /未决事项：signal 1；signal 2；signal 3（另有 49997 条未显示，请查看完整轨迹）/u);
    assert.match(brief, /需补：gap 1；gap 2；gap 3；gap 4；gap 5；gap 6/u);
    assert.ok(brief.length < 3_000);
  });

  test("keeps the exact omitted-signal notice inside the bounded open-loop line", () => {
    const openLoops = buildReentryBrief({
      project: { title: "Crowded" },
      summary: "state",
      nextAction: "next",
      returnHint: "hint",
      unresolvedSignals: [
        { text: "甲".repeat(1_200) },
        { text: "😀".repeat(600) },
        { text: "丙".repeat(1_200) }
      ],
      unresolvedSummary: { total: 9 },
      readinessGaps: []
    }).split("\n").find((line) => line.startsWith("未决事项："))?.slice("未决事项：".length) ?? "";

    assert.ok(openLoops.length <= 800);
    assert.match(openLoops, /甲+…；😀+…；丙+…（另有 6 条未显示，请查看完整轨迹）$/u);
    assert.doesNotMatch(openLoops, /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/u);
  });

  test("bounds raw field normalization and ignores coercion hooks", (t) => {
    let largestReplaceReceiver = 0;
    const nativeReplace = String.prototype.replace;
    t.mock.method(String.prototype, "replace", function (...args) {
      largestReplaceReceiver = Math.max(largestReplaceReceiver, this.length);
      return nativeReplace.apply(this, args);
    });
    let conversions = 0;
    const hostileTitle = {
      toString() {
        conversions += 1;
        throw new Error("coercion must not run");
      }
    };

    const brief = buildReentryBrief({
      project: { title: hostileTitle },
      summary: "state ".repeat(SHARE_TEXT_SCAN_LIMIT),
      nextAction: "next",
      returnHint: "hint"
    });

    assert.equal(conversions, 0);
    assert.ok(largestReplaceReceiver <= SHARE_TEXT_SCAN_LIMIT);
    assert.match(brief, /当前状态：state/u);
    assert.ok(brief.length < 3_000);

    const unicodeBoundary = buildReentryBrief({
      project: { title: "Unicode" },
      summary: `${" ".repeat(SHARE_TEXT_SCAN_LIMIT - 1)}😀tail`,
      nextAction: "next",
      returnHint: "hint"
    });
    assert.doesNotMatch(unicodeBoundary, /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/u);
  });
});

describe("buildReentryMarkdown", () => {
  test("builds an escaped bounded Markdown handoff from the same live evidence", () => {
    const markdown = buildReentryMarkdown({
      project: { title: "[门户](https://example.com) #1", status: "archived", updatedAt: "2026-08-27T07:06:05.004Z" },
      summary: "已定位 *邀请* 失效。",
      nextAction: "打开 <sample.json>。",
      checkpoint: { id: "cp" },
      openLoops: "过期检查点事项",
      unresolvedSignals: [{ text: "确认 _旧邀请_ 是否可重发" }],
      unresolvedSummary: { total: 3 },
      returnHint: "从 `403` 响应继续，~~不要重跑~~。",
      completeness: 75,
      readinessGaps: ["补充 [材料入口]"]
    });

    assert.equal(markdown, [
      "# \\[门户\\]\\(https://example\\.com\\) \\#1 · 复航简报",
      "",
      "- **项目状态：** 已归档",
      "- **现场更新：** 2026-08-27T07:06:05.004Z",
      "- **当前状态：** 已定位 \\*邀请\\* 失效。",
      "- **第一动作：** 打开 \\<sample\\.json\\>。",
      "- **未决事项：** 确认 \\_旧邀请\\_ 是否可重发（另有 2 条未显示，请查看完整轨迹）",
      "- **复航提示：** 从 \\`403\\` 响应继续，\\~\\~不要重跑\\~\\~。",
      "- **证据状态：** 75% · 需补：补充 \\[材料入口\\]",
      "",
      "> 由复航台根据本机已记录证据生成；请在继续工作前核对现场。"
    ].join("\n"));
    assert.ok(markdown.length < 3_000);
    assert.throws(() => buildReentryMarkdown(null), /缺少可生成简报/u);
  });
});

describe("buildWorkspaceHandoff", () => {
  test("builds a bounded multi-project handoff with attention and weekly context", () => {
    const rankedProjects = Array.from({ length: 8 }, (_, index) => ({
      project: { title: `Project ${index + 1}`, status: index === 1 ? "blocked" : "active" },
      activeSession: index === 0 ? { intention: "Finish the critical path" } : null,
      nextAction: `Action ${index + 1}`,
      completeness: 90 - index
    }));
    const handoff = buildWorkspaceHandoff({
      rankedProjects,
      rankedTotal: 8,
      weeklyReview: { focusedMinutes: 95, sessions: 3, records: 12, recoverability: 77 },
      attentionDeck: [{ project: { title: "Project 2" }, reasons: ["有未解决阻塞", "已离开 9 天"], reasonTotal: 4 }],
      attentionTotal: 3
    }, Date.parse("2026-08-28T08:00:00.000Z"));

    assert.match(handoff, /生成时间：2026-08-28T08:00:00\.000Z/u);
    assert.match(handoff, /当前会话：Project 1｜Finish the critical path/u);
    assert.match(handoff, /2\. Project 2｜受阻｜复航 89%/u);
    assert.match(handoff, /Project 2：有未解决阻塞；已离开 9 天/u);
    assert.match(handoff, /另有 2 项现场缺口未列出/u);
    assert.match(handoff, /另有 2 个项目未列出，请回到项目舰桥核对/u);
    assert.match(handoff, /七日航迹：95 分钟 · 3 段会话 · 12 条轨迹 · 平均复航 77%/u);
    assert.equal((handoff.match(/^\d+\. /gmu) ?? []).length, WORKSPACE_HANDOFF_PROJECT_LIMIT);
    assert.doesNotMatch(handoff, /Project 6/u);
  });

  test("fails clearly for missing input and handles empty or malformed optional metrics", () => {
    assert.throws(() => buildWorkspaceHandoff(null), /缺少可生成/u);
    for (const invalidTime of ["invalid", " ", null, true, [], {}]) {
      assert.throws(() => buildWorkspaceHandoff({ rankedProjects: [] }, invalidTime), /生成时间无效/u);
    }
    assert.match(
      buildWorkspaceHandoff({ rankedProjects: [] }, new Date("2026-08-28T08:00:00.000Z")),
      /生成时间：2026-08-28T08:00:00\.000Z/u
    );
    const handoff = buildWorkspaceHandoff({ rankedProjects: [], rankedTotal: -2 }, 0);
    assert.match(handoff, /未归档项目：0/u);
    assert.match(handoff, /当前会话：无/u);
    assert.match(handoff, /当前没有可复航项目/u);
    assert.match(handoff, /当前没有明显的现场缺口/u);
    assert.match(handoff, /平均复航 0%/u);
    assert.match(
      buildWorkspaceHandoff({ rankedProjects: [], attentionTotal: 3 }, 0),
      /有 3 个项目需要核对，请回到项目舰桥查看/u
    );
  });

  test("bounds attention reason reads and skips malformed cards without truncating valid output", () => {
    const reasons = ["one", "two", "three"];
    Object.defineProperty(reasons, 3, { get() { throw new Error("reason window exceeded"); } });
    reasons.length = 50_000;
    const handoff = buildWorkspaceHandoff({
      rankedProjects: [null, { project: { title: "Valid", status: "paused" }, nextAction: "Resume" }],
      rankedTotal: 1,
      attentionDeck: [null, { project: { title: "Valid" }, reasons }]
    }, 0);

    assert.match(handoff, /1\. Valid｜暂泊｜复航 0%/u);
    assert.match(handoff, /Valid：one；two；three/u);
    assert.match(handoff, /另有 49997 项现场缺口未列出/u);
    assert.ok(handoff.length < 3_000);
  });

  test("bounds malformed ranked and attention input scans independently of output limits", () => {
    const rankedProjects = new Array(WORKSPACE_HANDOFF_INPUT_SCAN_LIMIT).fill(null);
    rankedProjects[WORKSPACE_HANDOFF_INPUT_SCAN_LIMIT - 1] = {
      project: { title: "Last safe project", status: "active" },
      activeSession: { intention: "Resume safely" },
      nextAction: "Open the plan",
      completeness: 80
    };
    Object.defineProperty(rankedProjects, WORKSPACE_HANDOFF_INPUT_SCAN_LIMIT, { get() { throw new Error("ranked scan exceeded"); } });
    rankedProjects.length = 50_000;
    const attentionDeck = new Array(WORKSPACE_HANDOFF_INPUT_SCAN_LIMIT).fill(null);
    attentionDeck[WORKSPACE_HANDOFF_INPUT_SCAN_LIMIT - 1] = {
      project: { title: "Last safe project" },
      reasons: ["Needs review"]
    };
    Object.defineProperty(attentionDeck, WORKSPACE_HANDOFF_INPUT_SCAN_LIMIT, { get() { throw new Error("attention scan exceeded"); } });
    attentionDeck.length = 50_000;

    const handoff = buildWorkspaceHandoff({ rankedProjects, rankedTotal: 1, attentionDeck }, 0);

    assert.match(handoff, /当前会话：Last safe project｜Resume safely/u);
    assert.match(handoff, /1\. Last safe project｜推进中｜复航 80%/u);
    assert.match(handoff, /Last safe project：Needs review/u);
  });
});

describe("buildWorkspaceHandoffMarkdown", () => {
  test("renders the bounded handoff as safe editable Markdown", () => {
    const markdown = buildWorkspaceHandoffMarkdown({
      rankedProjects: [{
        project: { title: "[Portal](https://example.com)", status: "active" },
        activeSession: { intention: "Fix *login*" },
        nextAction: "Open <trace.json>",
        completeness: 80
      }],
      rankedTotal: 1,
      attentionDeck: [{ project: { title: "[Portal]" }, reasons: ["~~stale~~"], reasonTotal: 2 }],
      attentionTotal: 1,
      weeklyReview: { focusedMinutes: 30, sessions: 1, records: 2, recoverability: 80 }
    }, Date.parse("2026-08-28T08:00:00.000Z"));

    assert.equal(markdown, [
      "# 复航台 · 工作区交接清单",
      "",
      "- **生成时间：** 2026\\-08\\-28T08:00:00\\.000Z",
      "- **未归档项目：** 1",
      "- **当前会话：** \\[Portal\\]\\(https://example\\.com\\)｜Fix \\*login\\*",
      "",
      "## 优先复航",
      "1. \\[Portal\\]\\(https://example\\.com\\)｜推进中｜复航 80%",
      "   - **下一步：** Open \\<trace\\.json\\>",
      "",
      "## 值得核对",
      "- \\[Portal\\]：\\~\\~stale\\~\\~（另有 1 项现场缺口未列出）",
      "",
      "**七日航迹：** 30 分钟 · 1 段会话 · 2 条轨迹 · 平均复航 80%",
      "> **说明：** 仅根据本机已记录证据生成，不代表产出评价。"
    ].join("\n"));
    assert.ok(markdown.length < 3_000);
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
    assert.deepEqual(events, ["attribute:aria-hidden:true", "attribute:class:clipboard-fallback-control", "append", "select", "exec:copy", "remove", "focus:true", "selection:2:5"]);
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
          return { setAttribute() {}, select() {}, remove() { removed = true; } };
        },
        execCommand() { return false; }
      }
    }), /无法写入剪贴板：denied/u);
    assert.equal(removed, true);
  });

  test("rejects oversized text before reading browser copy capabilities", async () => {
    let clipboardReads = 0;
    const dependencies = {
      get clipboard() {
        clipboardReads += 1;
        throw new Error("clipboard must not be read");
      },
      get document() {
        throw new Error("document must not be read");
      }
    };

    await assert.rejects(
      () => copyPlainText("x".repeat(COPY_TEXT_LIMIT + 1), dependencies),
      /超过 64 KiB/u
    );
    await assert.rejects(
      () => copyPlainText(" ".repeat(COPY_TEXT_LIMIT + 1), dependencies),
      /超过 64 KiB/u
    );
    assert.equal(clipboardReads, 0);
    const writes = [];
    assert.equal(
      await copyPlainText("x".repeat(COPY_TEXT_LIMIT), { clipboard: { writeText: async (text) => writes.push(text.length) } }),
      "clipboard"
    );
    assert.deepEqual(writes, [COPY_TEXT_LIMIT]);
  });

  test("rejects non-string payloads without invoking coercion hooks", async () => {
    let conversions = 0;
    const payload = {
      toString() {
        conversions += 1;
        throw new Error("coercion must not run");
      }
    };

    await assert.rejects(() => copyPlainText(payload, {}), /必须是字符串/u);
    await assert.rejects(() => copyPlainText(null, {}), /必须是字符串/u);
    assert.equal(conversions, 0);
  });

  test("rejects malformed UTF-16 before reading browser copy capabilities", async () => {
    let capabilityReads = 0;
    const dependencies = {
      get clipboard() {
        capabilityReads += 1;
        throw new Error("clipboard must not be read");
      }
    };

    await assert.rejects(() => copyPlainText("broken \ud800 text", dependencies), /损坏的 Unicode/u);
    await assert.rejects(() => copyPlainText("broken \udc00 text", dependencies), /损坏的 Unicode/u);
    assert.equal(capabilityReads, 0);
    assert.equal(await copyPlainText("complete 👩‍💻 text", { clipboard: { writeText: async () => {} } }), "clipboard");
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
