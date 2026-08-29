import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { request } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, test } from "node:test";

import {
  MAX_REQUEST_TARGET_LENGTH,
  createAppServer,
  formatServerStartupError,
  formatServerUrl,
  parseServerHost,
  parseServerPort,
  resolvePublicFile
} from "../tools/server.mjs";

const projectRoot = resolve(import.meta.dirname, "..");
let server;
let port;

before(async () => {
  server = createAppServer({ root: projectRoot });
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  port = server.address().port;
});

describe("server configuration", () => {
  test("accepts only complete decimal port values", () => {
    for (const [value, expected] of [["4173", 4173], [" 0 ", 0], ["65535", 65535], [4173, 4173]]) {
      assert.equal(parseServerPort(value), expected);
    }
    for (const value of ["", "4173abc", "1.5", "-1", "+80", "65536", null, undefined]) {
      assert.equal(parseServerPort(value), null, String(value));
    }
  });

  test("normalizes only bounded hostnames and IP addresses", () => {
    for (const [value, expected] of [
      ["localhost", "localhost"],
      ["LOCALHOST", "localhost"],
      ["dev-box.local", "dev-box.local"],
      ["EXAMPLE.TEST.", "example.test."],
      ["xn--mnich-kva.example", "xn--mnich-kva.example"],
      ["127.0.0.1", "127.0.0.1"],
      ["0.0.0.0", "0.0.0.0"],
      ["::1", "::1"],
      ["::", "::"],
      ["[2001:DB8::1]", "2001:db8::1"]
    ]) {
      assert.equal(parseServerHost(value), expected, value);
    }

    for (const value of [
      "",
      " localhost",
      "localhost ",
      "local\thost",
      "local\u00a0host",
      "http://localhost",
      "user@localhost",
      "localhost:4173",
      "localhost/path",
      "localhost?query",
      "localhost#fragment",
      "[localhost]",
      "[::1",
      "::1]",
      "[bad:host]",
      "fe80::1%12",
      "-bad.test",
      "bad-.test",
      "bad..test",
      "a_b.test",
      "münich.example",
      "127.0.0.01",
      "0x7f000001",
      "256.256.256.256",
      `${"a".repeat(64)}.test`,
      `${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(62)}`,
      null,
      undefined
    ]) {
      assert.equal(parseServerHost(value), null, String(value));
    }
    assert.equal(formatServerUrl(null, parseServerHost("[::1]"), 4173), "http://[::1]:4173");
  });

  test("reports the actual bound port and formats IPv6 URLs", () => {
    assert.equal(formatServerUrl({ address: "127.0.0.1", port: 53124 }, "127.0.0.1", 0), "http://127.0.0.1:53124");
    assert.equal(formatServerUrl({ address: "::1", port: 53125 }, "localhost", 0), "http://[::1]:53125");
    assert.equal(formatServerUrl({ address: "[::1]", port: 53126 }, "localhost", 0), "http://[::1]:53126");
    assert.equal(formatServerUrl(null, "localhost", 4173), "http://localhost:4173");
    assert.equal(formatServerUrl(null, "bad host", 4173), null);
    assert.equal(formatServerUrl(null, "user@example.test", 4173), null);
    assert.equal(formatServerUrl(null, "bad:host", 4173), null);
    assert.equal(formatServerUrl({ address: "127.0.0.1", port: 65_536 }), null);
  });

  test("distinguishes expected startup failures from unexpected diagnostics", () => {
    const occupied = Object.assign(new Error("listen failed"), { code: "EADDRINUSE" });
    const denied = Object.assign(new Error("listen failed"), { code: "EACCES" });
    const unexpected = new Error("socket exploded");

    assert.equal(
      formatServerStartupError(occupied, "127.0.0.1", 4173),
      "地址 127.0.0.1:4173 已被占用，复航台未启动。"
    );
    assert.equal(
      formatServerStartupError(denied, "0.0.0.0", 80),
      "没有权限监听 0.0.0.0:80，复航台未启动。请改用 1024–65535 的端口或检查网络权限。"
    );
    assert.equal(formatServerStartupError(unexpected, "127.0.0.1", 4173), `复航台启动失败：${unexpected.stack}`);
    assert.equal(formatServerStartupError({
      get code() { throw new Error("blocked"); },
      get stack() { throw new Error("blocked"); }
    }, "bad host", -1), "复航台启动失败：未知错误");
  });
});

after(async () => {
  if (server) await new Promise((resolveClose) => server.close(resolveClose));
});

function send(path, method = "GET") {
  return new Promise((resolveResponse, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolveResponse({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString("utf8")
      }));
    });
    req.on("error", reject);
    req.end();
  });
}

describe("public path resolution", () => {
  test("accepts only explicit application-shell files", () => {
    assert.equal(resolvePublicFile("/", projectRoot).path, resolve(projectRoot, "index.html"));
    assert.equal(resolvePublicFile("/src/core/session.js?cache=1", projectRoot).path, resolve(projectRoot, "src/core/session.js"));
    assert.equal(resolvePublicFile("/src/core/search.js", projectRoot).path, resolve(projectRoot, "src/core/search.js"));
    assert.equal(resolvePublicFile("/src/core/capture.js", projectRoot).path, resolve(projectRoot, "src/core/capture.js"));
    assert.equal(resolvePublicFile("/src/core/backup-file.js", projectRoot).path, resolve(projectRoot, "src/core/backup-file.js"));
    assert.equal(resolvePublicFile("/src/core/insights.js", projectRoot).path, resolve(projectRoot, "src/core/insights.js"));
    assert.equal(resolvePublicFile("/src/core/import-preview.js", projectRoot).path, resolve(projectRoot, "src/core/import-preview.js"));
    assert.equal(resolvePublicFile("/src/core/timeline.js", projectRoot).path, resolve(projectRoot, "src/core/timeline.js"));
    for (const path of ["/.git/config", "/package.json", "/tests/model.test.js", "/tools/server.mjs", "/missing.js"]) {
      assert.equal(resolvePublicFile(path, projectRoot).error, 404);
    }
  });

  test("rejects malformed encoding and traversal", () => {
    assert.equal(resolvePublicFile("/%", projectRoot).error, 400);
    assert.equal(resolvePublicFile("/%E0%A4%A", projectRoot).error, 400);
    for (const alias of ["/src%2fmain.js", "/src/%6dain.js", "/%69ndex.html", "/src/main%2ejs"]) {
      assert.equal(resolvePublicFile(alias, projectRoot).error, 400, alias);
    }
    assert.ok([400, 404].includes(resolvePublicFile("/%2e%2e/package.json", projectRoot).error));
  });

  test("accepts only control-free origin-form request targets", () => {
    assert.equal(resolvePublicFile("/src/main.js?cache=1", projectRoot).path, resolve(projectRoot, "src/main.js"));
    for (const target of [
      "http://attacker.invalid/src/main.js",
      "//attacker.invalid/src/main.js",
      "/src/main.js#fragment",
      " /src/main.js",
      "/src/main.js\t",
      "/src/%00main.js",
      "/src/%C2%85main.js"
    ]) {
      assert.equal(resolvePublicFile(target, projectRoot).error, 400, target);
    }
    assert.equal(resolvePublicFile("", projectRoot).error, 400);
    assert.equal(resolvePublicFile(0, projectRoot).error, 400);
    assert.equal(resolvePublicFile(`/${"a".repeat(MAX_REQUEST_TARGET_LENGTH)}`, projectRoot).error, 414);
  });
});

describe("local HTTP server", () => {
  test("CLI rejects a malformed host before DNS or listen", async () => {
    const result = await runServerCli({ HOST: "bad host", PORT: "0" });
    assert.equal(result.code, 1);
    assert.equal(result.signal, null);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "HOST 必须是有效的主机名、IPv4 或 IPv6 地址，且不能包含协议、端口或路径。\n");
    assert.doesNotMatch(result.stderr, /getaddrinfo|\n\s+at /u);
  });

  test("CLI reports a real occupied port without a raw stack trace", async () => {
    const occupied = createAppServer({ root: projectRoot });
    await new Promise((resolveListen, reject) => {
      occupied.once("error", reject);
      occupied.listen(0, "127.0.0.1", resolveListen);
    });
    const occupiedPort = occupied.address().port;
    try {
      const result = await runServerCli({ HOST: "127.0.0.1", PORT: String(occupiedPort) });
      assert.equal(result.code, 1);
      assert.equal(result.signal, null);
      assert.equal(result.stdout, "");
      assert.equal(result.stderr, `地址 127.0.0.1:${occupiedPort} 已被占用，复航台未启动。\n`);
      assert.doesNotMatch(result.stderr, /\n\s+at /u);
    } finally {
      await new Promise((resolveClose) => occupied.close(resolveClose));
    }
  });

  test("serves the app and correct content type", async () => {
    const response = await send("/");
    assert.equal(response.status, 200);
    assert.match(response.headers["content-type"], /^text\/html/);
    assert.match(response.body, /复航台/);
    assert.match(response.headers["content-security-policy"], /object-src 'none'/);
    assert.match(response.headers["content-security-policy"], /style-src 'self';/u);
    assert.doesNotMatch(response.headers["content-security-policy"], /unsafe-inline/u);
    assert.equal(response.headers["cross-origin-resource-policy"], "same-origin");
    assert.equal(response.headers["permissions-policy"], "camera=(), microphone=(), geolocation=()");
    assert.equal(response.headers["x-frame-options"], "DENY");
  });

  test("malformed URLs return 400 and do not terminate the server", async () => {
    assert.equal((await send("/%")).status, 400);
    assert.equal((await send("http://attacker.invalid/src/main.js")).status, 400);
    assert.equal((await send("/src/main.js#fragment")).status, 400);
    assert.equal((await send("/src%2fmain.js")).status, 400);
    assert.equal((await send("/")).status, 200);
  });

  test("oversized request targets return 414 without reaching URL resolution", async () => {
    const response = await send(`/${"a".repeat(MAX_REQUEST_TARGET_LENGTH)}`);

    assert.equal(response.status, 414);
    assert.equal(response.body, "URI too long");
    assert.equal(response.headers["cache-control"], "no-store");
    assert.equal((await send("/")).status, 200);
  });

  test("private repository files are never served", async () => {
    for (const path of ["/.git/config", "/package.json", "/tests/store.test.js", "/tools/server.mjs"]) {
      assert.equal((await send(path)).status, 404, path);
    }
  });

  test("HEAD and unsupported methods follow HTTP semantics", async () => {
    const get = await send("/src/main.js");
    const head = await send("/src/main.js", "HEAD");
    assert.equal(head.status, 200);
    assert.equal(head.body, "");
    assert.equal(head.headers["content-length"], get.headers["content-length"]);
    assert.equal(Number(head.headers["content-length"]), Buffer.byteLength(get.body));
    const post = await send("/", "POST");
    assert.equal(post.status, 405);
    assert.equal(post.headers.allow, "GET, HEAD");
    assert.equal(Number(post.headers["content-length"]), Buffer.byteLength(post.body));
  });

  test("allowed but absent public assets return 404", async () => {
    const isolated = createAppServer({ root: resolve(projectRoot, "definitely-missing-root") });
    await new Promise((resolveListen) => isolated.listen(0, "127.0.0.1", resolveListen));
    const isolatedPort = isolated.address().port;
    const response = await new Promise((resolveResponse, reject) => {
      const req = request({ host: "127.0.0.1", port: isolatedPort, path: "/" }, (res) => {
        res.resume();
        res.on("end", () => resolveResponse(res));
      });
      req.on("error", reject);
      req.end();
    });
    assert.equal(response.statusCode, 404);
    await new Promise((resolveClose) => isolated.close(resolveClose));
  });

  test("zero-byte public files use a complete descriptor-safe response", async () => {
    const root = await mkdtemp(join(tmpdir(), "reentry-deck-server-"));
    const isolated = createAppServer({ root });
    try {
      await writeFile(join(root, "index.html"), "");
      await new Promise((resolveListen) => isolated.listen(0, "127.0.0.1", resolveListen));
      const isolatedPort = isolated.address().port;
      const fetchEmpty = (method) => new Promise((resolveResponse, reject) => {
        const req = request({ host: "127.0.0.1", port: isolatedPort, path: "/", method }, (res) => {
          const chunks = [];
          res.on("data", (chunk) => chunks.push(chunk));
          res.on("end", () => resolveResponse({ status: res.statusCode, length: res.headers["content-length"], body: Buffer.concat(chunks) }));
        });
        req.on("error", reject);
        req.end();
      });
      for (const method of ["GET", "HEAD"]) {
        const response = await fetchEmpty(method);
        assert.equal(response.status, 200);
        assert.equal(response.length, "0");
        assert.equal(response.body.length, 0);
      }
    } finally {
      if (isolated.listening) await new Promise((resolveClose) => isolated.close(resolveClose));
      await rm(root, { recursive: true, force: true });
    }
  });
});

function runServerCli(extraEnvironment) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [resolve(projectRoot, "tools/server.mjs")], {
      cwd: projectRoot,
      env: { ...process.env, ...extraEnvironment },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
    const stdout = [];
    const stderr = [];
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error("Server CLI did not exit after a startup failure."));
    }, 5_000);
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      resolveRun({
        code,
        signal,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8")
      });
    });
  });
}
