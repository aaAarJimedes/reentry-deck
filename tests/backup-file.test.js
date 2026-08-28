import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { MAX_BACKUP_FILE_BYTES, MAX_BACKUP_STREAM_CHUNKS, createLatestRequestGate, readBackupFile } from "../src/core/backup-file.js";

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
    await assert.rejects(readBackupFile(oversized), /声明大小与实际内容不一致/u);
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

  test("preserves UTF-8 split across chunks and rejects malformed or truncated bytes", async () => {
    const streamedFile = (bytes) => {
      let index = 0;
      return {
        size: bytes.length,
        stream() {
          return { getReader() { return {
            async read() {
              return index < bytes.length
                ? { done: false, value: bytes.slice(index, ++index) }
                : { done: true };
            },
            async cancel() {},
            releaseLock() {}
          }; } };
        }
      };
    };

    const valid = new TextEncoder().encode('{"title":"复航🚀"}');
    assert.deepEqual(await readBackupFile(streamedFile(valid)), { title: "复航🚀" });

    await assert.rejects(readBackupFile(streamedFile(Uint8Array.of(0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xc3, 0x28, 0x22, 0x7d))), /无法读取备份文件/u);
    await assert.rejects(readBackupFile(streamedFile(Uint8Array.of(0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xf0, 0x9f, 0x9a))), /无法读取备份文件/u);
  });

  test("rejects dishonest sizes and pathological stream fragmentation", async () => {
    const bytes = new TextEncoder().encode('{"safe":true}');
    const streamedFile = ({ size, read }) => {
      let canceled = false;
      return {
        size,
        get canceled() { return canceled; },
        stream() {
          return { getReader() { return {
            read,
            async cancel() { canceled = true; },
            releaseLock() {}
          }; } };
        }
      };
    };

    let underRead = false;
    const underreported = streamedFile({
      size: bytes.length - 1,
      async read() {
        if (underRead) return { done: true };
        underRead = true;
        return { done: false, value: bytes };
      }
    });
    await assert.rejects(readBackupFile(underreported), /声明大小与实际内容不一致/u);
    assert.equal(underreported.canceled, true);

    let overRead = false;
    const overreported = streamedFile({
      size: bytes.length + 1,
      async read() {
        if (overRead) return { done: true };
        overRead = true;
        return { done: false, value: bytes };
      }
    });
    await assert.rejects(readBackupFile(overreported), /声明大小与实际内容不一致/u);

    let chunkReads = 0;
    const fragmented = streamedFile({
      size: MAX_BACKUP_FILE_BYTES,
      async read() {
        chunkReads += 1;
        return { done: false, value: Uint8Array.of(0x20) };
      }
    });
    await assert.rejects(readBackupFile(fragmented), /分块异常/u);
    assert.equal(chunkReads, MAX_BACKUP_STREAM_CHUNKS + 1);
    assert.equal(fragmented.canceled, true);

    const emptyChunk = streamedFile({ size: 0, async read() { return { done: false, value: new Uint8Array() }; } });
    await assert.rejects(readBackupFile(emptyChunk), /分块异常/u);
    assert.equal(emptyChunk.canceled, true);
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
