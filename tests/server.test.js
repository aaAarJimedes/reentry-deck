import assert from "node:assert/strict";
import { request } from "node:http";
import { resolve } from "node:path";
import { after, before, describe, test } from "node:test";

import { createAppServer, resolvePublicFile } from "../tools/server.mjs";

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
    assert.equal(resolvePublicFile("/src/core/insights.js", projectRoot).path, resolve(projectRoot, "src/core/insights.js"));
    for (const path of ["/.git/config", "/package.json", "/tests/model.test.js", "/tools/server.mjs", "/missing.js"]) {
      assert.equal(resolvePublicFile(path, projectRoot).error, 404);
    }
  });

  test("rejects malformed encoding and traversal", () => {
    assert.equal(resolvePublicFile("/%", projectRoot).error, 400);
    assert.equal(resolvePublicFile("/%E0%A4%A", projectRoot).error, 400);
    assert.ok([400, 404].includes(resolvePublicFile("/%2e%2e/package.json", projectRoot).error));
  });
});

describe("local HTTP server", () => {
  test("serves the app and correct content type", async () => {
    const response = await send("/");
    assert.equal(response.status, 200);
    assert.match(response.headers["content-type"], /^text\/html/);
    assert.match(response.body, /复航台/);
  });

  test("malformed URLs return 400 and do not terminate the server", async () => {
    assert.equal((await send("/%")).status, 400);
    assert.equal((await send("/")).status, 200);
  });

  test("private repository files are never served", async () => {
    for (const path of ["/.git/config", "/package.json", "/tests/store.test.js", "/tools/server.mjs"]) {
      assert.equal((await send(path)).status, 404, path);
    }
  });

  test("HEAD and unsupported methods follow HTTP semantics", async () => {
    const head = await send("/src/main.js", "HEAD");
    assert.equal(head.status, 200);
    assert.equal(head.body, "");
    const post = await send("/", "POST");
    assert.equal(post.status, 405);
    assert.equal(post.headers.allow, "GET, HEAD");
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
});
