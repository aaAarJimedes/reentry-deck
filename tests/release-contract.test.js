import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { describe, test } from "node:test";

import { APP_VERSION } from "../src/core/store.js";
import { PUBLIC_FILES } from "../tools/server.mjs";

const projectRoot = resolve(import.meta.dirname, "..");

async function source(path) {
  return readFile(resolve(projectRoot, path), "utf8");
}

function shellPaths(swSource) {
  const declaration = swSource.match(/const SHELL_PATHS = Object\.freeze\(\[([\s\S]*?)\]\);/u);
  assert.ok(declaration, "service worker shell declaration must remain statically auditable");
  return [...declaration[1].matchAll(/"([^"]+)"/gu)].map((match) => match[1]);
}

function localImports(moduleSource) {
  const imports = new Set();
  const patterns = [
    /\bfrom\s*["'](\.[^"']+)["']/gu,
    /\bimport\s*["'](\.[^"']+)["']/gu,
    /\bimport\s*\(\s*["'](\.[^"']+)["']\s*\)/gu
  ];
  for (const pattern of patterns) {
    for (const match of moduleSource.matchAll(pattern)) imports.add(match[1]);
  }
  return [...imports];
}

function toProjectPath(path) {
  return relative(projectRoot, path).replaceAll("\\", "/");
}

describe("release contract", () => {
  test("package, backup metadata, changelog, and offline build share one version", async () => {
    const packageMetadata = JSON.parse(await source("package.json"));
    const changelog = await source("CHANGELOG.md");
    const serviceWorker = await source("sw.js");
    const newestVersion = changelog.match(/^## (\d+\.\d+\.\d+)\b/mu)?.[1];
    const offlineBuild = serviceWorker.match(/^const BUILD_ID = "([^"]+)";$/mu)?.[1];

    assert.match(packageMetadata.version, /^\d+\.\d+\.\d+$/u);
    assert.equal(APP_VERSION, packageMetadata.version);
    assert.equal(newestVersion, packageMetadata.version);
    assert.equal(offlineBuild, packageMetadata.version);
  });

  test("offline shell and HTTP whitelist expose the same runtime files", async () => {
    const shell = shellPaths(await source("sw.js"));
    const shellUrls = shell.map((path) => path === "./" ? "/" : `/${path.slice(2)}`);
    const publicRuntimeUrls = [...PUBLIC_FILES.keys()].filter((path) => path !== "/sw.js");

    assert.deepEqual(new Set(shellUrls), new Set(publicRuntimeUrls));
    for (const path of shell.filter((item) => item !== "./")) await source(path.slice(2));
  });

  test("every local module reachable from main is served and cached", async () => {
    const shell = new Set(shellPaths(await source("sw.js")).map((path) => path.slice(2)));
    const visited = new Set();
    const pending = ["src/main.js"];

    while (pending.length) {
      const modulePath = pending.pop();
      if (visited.has(modulePath)) continue;
      visited.add(modulePath);
      assert.ok(shell.has(modulePath), `${modulePath} is missing from the offline shell`);
      assert.ok(PUBLIC_FILES.has(`/${modulePath}`), `${modulePath} is missing from the HTTP whitelist`);

      const moduleSource = await source(modulePath);
      for (const specifier of localImports(moduleSource)) {
        const dependency = toProjectPath(resolve(projectRoot, dirname(modulePath), specifier));
        if (dependency.endsWith(".js")) pending.push(dependency);
      }
    }

    const cachedModules = [...shell].filter((path) => path.endsWith(".js") && path !== "sw.js");
    assert.deepEqual(new Set(visited), new Set(cachedModules));
  });
});
