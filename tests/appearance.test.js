import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import { IMPORT_FILE_NAME_LIMIT, importFileLabel, resolveThemeAppearance, userFacingErrorMessage } from "../src/ui/app.js";

const styles = await readFile(resolve(import.meta.dirname, "../src/styles.css"), "utf8");

test("resolveThemeAppearance follows the system only in system mode", () => {
  assert.deepEqual(resolveThemeAppearance("system", false), { dark: false, themeColor: "#f4efe6" });
  assert.deepEqual(resolveThemeAppearance("system", true), { dark: true, themeColor: "#111a19" });
  assert.deepEqual(resolveThemeAppearance("light", true), { dark: false, themeColor: "#f4efe6" });
  assert.deepEqual(resolveThemeAppearance("dark", false), { dark: true, themeColor: "#111a19" });
});

test("resolveThemeAppearance fails closed to the light shell for unknown modes", () => {
  assert.deepEqual(resolveThemeAppearance("unknown", true), { dark: false, themeColor: "#f4efe6" });
  assert.equal(Object.isFrozen(resolveThemeAppearance("dark", false)), true);
});

test("userFacingErrorMessage never projects an absent or malformed message", () => {
  assert.equal(userFacingErrorMessage(new Error("specific failure")), "specific failure");
  assert.equal(userFacingErrorMessage({ message: "   " }), "操作未完成，请根据最新状态重试。 ");
  assert.equal(userFacingErrorMessage("primitive rejection", "安全降级"), "安全降级");
});

test("importFileLabel bounds untrusted display names without splitting Unicode", () => {
  assert.equal(importFileLabel({ name: "  safe-backup.json  " }), "safe-backup.json");
  assert.equal(importFileLabel({ name: "   " }), "未命名备份.json");
  const label = importFileLabel({ name: `${"a".repeat(IMPORT_FILE_NAME_LIMIT - 2)}🚀tail.json` });
  assert.ok(label.length <= IMPORT_FILE_NAME_LIMIT);
  assert.match(label, /…$/u);
  assert.doesNotMatch(label, /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/u);
});

test("the reentry hero keeps a dark local surface in both global themes", () => {
  const block = styles.match(/\.reentry-hero\s*\{(?<body>[\s\S]*?)\n\}/u)?.groups?.body ?? "";
  assert.match(block, /background:\s*#173d3a;/u);
  assert.doesNotMatch(block, /background:\s*var\(--forest\)/u);
  assert.match(block, /color:\s*#f7f1e8;/u);
});
