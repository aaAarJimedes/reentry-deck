import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { MAX_BACKUP_FILE_BYTES, createLatestRequestGate, readBackupFile } from "../src/core/backup-file.js";

function fakeFile({ size, text = "{}", readError = null } = {}) {
  let reads = 0;
  return {
    size,
    get reads() {
      return reads;
    },
    async text() {
      reads += 1;
      if (readError) throw readError;
      return text;
    }
  };
}

describe("readBackupFile", () => {
  test("accepts valid JSON exactly at the byte boundary", async () => {
    const file = fakeFile({ size: MAX_BACKUP_FILE_BYTES, text: '{"ready":true}' });

    assert.deepEqual(await readBackupFile(file), { ready: true });
    assert.equal(file.reads, 1);
  });

  test("rejects oversized files before reading their content", async () => {
    const file = fakeFile({ size: MAX_BACKUP_FILE_BYTES + 1 });

    await assert.rejects(readBackupFile(file), /超过 25 MB/);
    assert.equal(file.reads, 0);
  });

  test("rejects missing or untrustworthy file metadata", async () => {
    await assert.rejects(readBackupFile(null), /没有可读取/);
    await assert.rejects(readBackupFile(fakeFile({ size: -1 })), /无法确认备份文件大小/);
    await assert.rejects(readBackupFile(fakeFile({ size: Number.MAX_SAFE_INTEGER + 1 })), /无法确认备份文件大小/);
  });

  test("turns file and JSON failures into stable user-facing errors", async () => {
    await assert.rejects(
      readBackupFile(fakeFile({ size: 2, readError: new Error("device gone") })),
      /无法读取备份文件/
    );
    await assert.rejects(readBackupFile(fakeFile({ size: 1, text: "{" })), /不是有效的 JSON 文件/);
  });

  test("streams bytes, enforces the observed boundary, and cancels stale reads", async () => {
    const bytes = new TextEncoder().encode('{"streamed":true}');
    let step = 0;
    const streamed = {
      size: bytes.byteLength,
      stream() {
        return { getReader() { return {
          async read() { step += 1; return step === 1 ? { done: false, value: bytes } : { done: true }; },
          async cancel() {},
          releaseLock() {}
        }; } };
      }
    };
    assert.deepEqual(await readBackupFile(streamed), { streamed: true });

    let oversizedCanceled = false;
    const oversizedView = Object.create(Uint8Array.prototype);
    Object.defineProperty(oversizedView, "byteLength", { value: MAX_BACKUP_FILE_BYTES + 1 });
    const oversized = {
      size: 1,
      stream() {
        return { getReader() { return {
          async read() { return { done: false, value: oversizedView }; },
          async cancel() { oversizedCanceled = true; },
          releaseLock() {}
        }; } };
      }
    };
    await assert.rejects(readBackupFile(oversized), /实际内容超过 25 MB/u);
    assert.equal(oversizedCanceled, true);

    const controller = new AbortController();
    controller.abort();
    await assert.rejects(readBackupFile(streamed, { signal: controller.signal }), /读取已取消/u);

    const inFlightController = new AbortController();
    let finishRead;
    let canceled = false;
    let released = false;
    const inFlight = {
      size: 2,
      stream() {
        return { getReader() { return {
          read() { return new Promise((resolve) => { finishRead = resolve; }); },
          async cancel() { canceled = true; finishRead?.({ done: true }); },
          releaseLock() { released = true; }
        }; } };
      }
    };
    const pending = readBackupFile(inFlight, { signal: inFlightController.signal });
    await Promise.resolve();
    inFlightController.abort();
    await assert.rejects(pending, /读取已取消/u);
    assert.equal(canceled, true);
    assert.equal(released, true);
  });
});

test("createLatestRequestGate lets only the newest asynchronous request commit", () => {
  const gate = createLatestRequestGate();
  const first = gate.begin();
  assert.equal(first(), true);

  const second = gate.begin();
  assert.equal(first(), false);
  assert.equal(second(), true);

  gate.invalidate();
  assert.equal(first(), false);
  assert.equal(second(), false);
});
