import assert from "node:assert/strict";
import test from "node:test";

import { resolveThemeAppearance, userFacingErrorMessage } from "../src/ui/app.js";

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
