import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { lstat, readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";

const projectRoot = resolve(import.meta.dirname, "..");

async function source(path) {
  return readFile(resolve(projectRoot, path), "utf8");
}

async function javascriptFiles(relativeRoot) {
  const files = [];
  const pending = [relativeRoot];
  assert.equal((await lstat(resolve(projectRoot, relativeRoot))).isDirectory(), true, `${relativeRoot}/ must be a regular directory`);
  while (pending.length) {
    const directory = pending.pop();
    for (const entry of await readdir(resolve(projectRoot, directory), { withFileTypes: true })) {
      const path = `${directory}/${entry.name}`;
      if (entry.isDirectory()) pending.push(path);
      else {
        assert.equal(entry.isFile(), true, `${path} must not be a symbolic link or special entry`);
        if (/\.(?:js|mjs)$/u.test(entry.name)) files.push(path);
      }
    }
  }
  return files;
}

function contractLines(value) {
  assert.ok(Buffer.byteLength(value, "utf8") <= 16 * 1024, "workflow must stay inside the 16 KiB source envelope");
  assert.doesNotMatch(value, /\t/u, "workflow indentation must not use tabs");
  assert.match(value, /^[\x0A\x0D\x20-\x7E]*$/u, "workflow must contain only auditable ASCII text");
  return value
    .replaceAll("\r\n", "\n")
    .split("\n")
    .map((line) => line.replace(/^ *#.*$/u, "").replace(/ +#.*$/u, "").replace(/ +$/u, ""))
    .filter(Boolean);
}

test("CI workflow stays dependency-free, immutable, least-privilege, and bounded", async () => {
  const [workflow, packageText, githubDirectory, workflowDirectory, workflowEntries, rootEntries, sourceFiles, toolFiles] = await Promise.all([
    source(".github/workflows/ci.yml"),
    source("package.json"),
    lstat(resolve(projectRoot, ".github")),
    lstat(resolve(projectRoot, ".github/workflows")),
    readdir(resolve(projectRoot, ".github/workflows"), { withFileTypes: true }),
    readdir(projectRoot),
    javascriptFiles("src"),
    javascriptFiles("tools")
  ]);
  const packageMetadata = JSON.parse(packageText);

  assert.equal(githubDirectory.isDirectory(), true, ".github/ must be a regular directory");
  assert.equal(workflowDirectory.isDirectory(), true, ".github/workflows/ must be a regular directory");
  const workflowFiles = workflowEntries
    .filter((entry) => /\.ya?ml$/iu.test(entry.name))
    .map((entry) => `${entry.name}:${entry.isFile() ? "file" : "non-file"}`)
    .sort();
  assert.deepEqual(workflowFiles, ["ci.yml:file"]);

  assert.deepEqual(contractLines(workflow), [
    "name: CI",
    "on:",
    "  push:",
    "    branches:",
    "      - main",
    "  pull_request:",
    "    branches:",
    "      - main",
    "permissions:",
    "  contents: read",
    "concurrency:",
    "  group: ci-${{ github.workflow }}-${{ github.ref }}",
    "  cancel-in-progress: true",
    "jobs:",
    "  verify:",
    "    name: Node 22 verification",
    "    runs-on: ubuntu-24.04",
    "    timeout-minutes: 10",
    "    steps:",
    "      - name: Check out repository",
    "        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
    "        with:",
    "          persist-credentials: false",
    "      - name: Use Node.js 22",
    "        uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020",
    "        with:",
    "          node-version: \"22\"",
    "          package-manager-cache: false",
    "      - name: Preflight CI contract",
    "        run: node --test tests/ci-contract.test.js",
    "      - name: Check syntax",
    "        run: npm run check",
    "      - name: Run tests",
    "        run: npm test"
  ]);

  assert.equal(packageMetadata.engines?.node, ">=22");
  assert.deepEqual(Object.keys(packageMetadata.scripts ?? {}).sort(), ["check", "dev", "start", "test"]);
  assert.equal(packageMetadata.scripts?.test, "node --test");
  const checkCommands = packageMetadata.scripts.check.split(" && ");
  const checkTargets = [];
  assert.ok(checkCommands.length > 0);
  for (const command of checkCommands) {
    const target = command.match(/^node --check ([A-Za-z0-9][A-Za-z0-9._/-]*\.(?:js|mjs))$/u)?.[1];
    assert.ok(target, `unsafe check command: ${command}`);
    assert.doesNotMatch(target, /(?:^|\/)\.\.(?:\/|$)|^\/|\\/u);
    assert.equal((await lstat(resolve(projectRoot, target))).isFile(), true, `${target} must be a regular file`);
    checkTargets.push(target);
  }
  assert.deepEqual(checkTargets.sort(), [...sourceFiles, ...toolFiles, "sw.js"].sort());
  for (const field of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies", "bundledDependencies", "bundleDependencies"]) {
    assert.equal(Object.hasOwn(packageMetadata, field), false, `${field} would require an explicit install policy`);
  }
  for (const filename of [".npmrc", "node_modules", "package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml", "bun.lock", "bun.lockb"]) {
    assert.equal(rootEntries.includes(filename), false, `${filename} would require an explicit package policy`);
  }
});
