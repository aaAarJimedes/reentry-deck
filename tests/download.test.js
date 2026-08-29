import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { describe, test } from "node:test";

import { DOWNLOAD_FILENAME_LIMIT, DOWNLOAD_FILENAME_SCAN_LIMIT, DOWNLOAD_REVOKE_DELAY_MS, formatLocalDownloadDate, safeDownloadFilename, triggerBlobDownload } from "../src/core/download.js";

const DOWNLOAD_MODULE_URL = new URL("../src/core/download.js", import.meta.url).href;

function harness({ clickError = null, scheduleError = null } = {}) {
  const events = [];
  let scheduled = null;
  const link = {
    href: "",
    download: "",
    hidden: false,
    attached: false,
    click() {
      events.push(`click:${this.attached}`);
      if (clickError) throw clickError;
    },
    remove() {
      this.attached = false;
      events.push("remove");
    }
  };
  return {
    events,
    link,
    dependencies: {
      document: {
        body: {
          append(node) {
            node.attached = true;
            events.push("append");
          }
        },
        createElement(name) {
          assert.equal(name, "a");
          return link;
        }
      },
      urlApi: {
        createObjectURL(value) {
          events.push(`create:${value}`);
          return "blob:backup";
        },
        revokeObjectURL(value) {
          events.push(`revoke:${value}`);
        }
      },
      schedule(callback, delay) {
        events.push(`schedule:${delay}`);
        if (scheduleError) throw scheduleError;
        scheduled = callback;
      }
    },
    runScheduled() {
      scheduled?.();
    }
  };
}

describe("triggerBlobDownload", () => {
  test("formats calendar dates in the user's local timezone", () => {
    const program = `import { formatLocalDownloadDate } from ${JSON.stringify(DOWNLOAD_MODULE_URL)}; process.stdout.write(formatLocalDownloadDate(Date.parse("2026-01-01T16:05:00.000Z")));`;
    const result = spawnSync(process.execPath, ["--input-type=module", "--eval", program], {
      encoding: "utf8",
      env: { ...process.env, TZ: "Asia/Shanghai" }
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "2026-01-02");
    assert.equal(formatLocalDownloadDate(new Date(2026, 9, 3, 12).getTime()), "2026-10-03");
  });

  test("rejects coercive or out-of-range download dates", () => {
    for (const value of ["2026-01-02", null, {}, Number.NaN, Number.POSITIVE_INFINITY, 9e15]) {
      assert.throws(() => formatLocalDownloadDate(value), /下载日期无效/u);
    }
  });

  test("projects filenames to a bounded portable download name", () => {
    assert.equal(safeDownloadFilename("  report\\Q3:final?.json.  "), "report-Q3-final-.json");
    assert.equal(safeDownloadFilename("CON.json"), "_CON.json");
    assert.equal(safeDownloadFilename("CONOUT$.log"), "_CONOUT$.log");
    assert.equal(safeDownloadFilename("CON .json"), "_CON .json");
    assert.equal(safeDownloadFilename("COM¹.txt"), "_COM¹.txt");
    assert.equal(safeDownloadFilename("LPT².report.json"), "_LPT².report.json");
    assert.equal(safeDownloadFilename("COM10.txt"), "COM10.txt");
    assert.equal(safeDownloadFilename("report\u202Egnp.exe\u200b"), "reportgnp.exe");
    assert.equal(safeDownloadFilename("bad\ud800name\udc00.json"), "badname.json");
    assert.equal(safeDownloadFilename("\u0000\u0007  .  "), "download.json");
    assert.equal(safeDownloadFilename(null), "download.json");
    const bounded = safeDownloadFilename(`${"😀".repeat(100)}forbidden-tail`);
    assert.equal(bounded.length, DOWNLOAD_FILENAME_LIMIT);
    assert.doesNotMatch(bounded, /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/u);
    assert.doesNotMatch(bounded, /forbidden-tail/u);
    assert.equal(safeDownloadFilename(`${" ".repeat(DOWNLOAD_FILENAME_SCAN_LIMIT)}forbidden-tail.json`), "download.json");
  });

  test("clicks an attached link before deferred object-URL cleanup", () => {
    const context = harness();
    triggerBlobDownload("backup", "reentry.json", context.dependencies);

    assert.equal(context.link.href, "blob:backup");
    assert.equal(context.link.download, "reentry.json");
    assert.equal(context.link.hidden, true);
    assert.deepEqual(context.events, [
      "create:backup",
      "append",
      "click:true",
      `schedule:${DOWNLOAD_REVOKE_DELAY_MS}`,
      "remove"
    ]);

    context.runScheduled();
    assert.equal(context.events.at(-1), "revoke:blob:backup");
  });

  test("revokes immediately when click or cleanup scheduling fails", () => {
    for (const failure of ["click", "schedule"]) {
      const context = harness({
        clickError: failure === "click" ? new Error("blocked") : null,
        scheduleError: failure === "schedule" ? new Error("scheduler unavailable") : null
      });
      assert.throws(
        () => triggerBlobDownload("backup", "reentry.json", context.dependencies),
        failure === "click" ? /blocked/u : /scheduler unavailable/u
      );
      assert.equal(context.link.attached, false);
      assert.equal(context.events.filter((event) => event === "revoke:blob:backup").length, 1);
    }
  });

  test("revokes an allocated URL when link creation fails", () => {
    const events = [];
    const urlApi = {
      createObjectURL() {
        events.push("create");
        return "blob:backup";
      },
      revokeObjectURL(value) {
        events.push(`revoke:${value}`);
      }
    };
    const document = {
      body: {},
      createElement() {
        throw new Error("DOM unavailable");
      }
    };

    assert.throws(() => triggerBlobDownload("backup", "reentry.json", { document, urlApi }), /DOM unavailable/u);
    assert.deepEqual(events, ["create", "revoke:blob:backup"]);
  });

  test("cleanup failures neither mask the download result nor block later revocation", () => {
    const success = harness();
    success.link.remove = () => {
      throw new Error("remove denied");
    };
    success.dependencies.urlApi.revokeObjectURL = () => {
      success.events.push("revoke-attempt");
      throw new Error("revoke denied");
    };

    assert.doesNotThrow(() => triggerBlobDownload("backup", "reentry.json", success.dependencies));
    assert.doesNotThrow(() => success.runScheduled());
    assert.equal(success.events.at(-1), "revoke-attempt");

    const failed = harness({ clickError: new Error("original click failure") });
    failed.link.remove = () => {
      throw new Error("remove denied");
    };
    failed.dependencies.urlApi.revokeObjectURL = () => {
      throw new Error("revoke denied");
    };
    assert.throws(
      () => triggerBlobDownload("backup", "reentry.json", failed.dependencies),
      /original click failure/u
    );
  });

  test("fails clearly before allocating when browser download primitives are absent", () => {
    assert.throws(() => triggerBlobDownload("backup", "reentry.json", { document: null }), /无法建立下载链接/u);
    assert.throws(() => triggerBlobDownload("backup", "reentry.json", { document: { body: {}, createElement() {} }, urlApi: {} }), /不支持本地文件下载/u);
  });
});
