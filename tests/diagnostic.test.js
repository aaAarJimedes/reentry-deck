import assert from "node:assert/strict";
import test from "node:test";

import {
  DIAGNOSTIC_MESSAGE_LIMIT,
  DIAGNOSTIC_SCAN_LIMIT,
  safeDiagnosticMessage
} from "../src/core/diagnostic.js";

test("safeDiagnosticMessage reads an error message once and survives hostile getters", () => {
  let reads = 0;
  const ordinary = {
    get message() {
      reads += 1;
      return "specific failure";
    }
  };
  assert.equal(safeDiagnosticMessage(ordinary), "specific failure");
  assert.equal(reads, 1);
  assert.equal(safeDiagnosticMessage({ get message() { throw new Error("getter trap"); } }, "安全降级"), "安全降级");
  assert.equal(safeDiagnosticMessage("primitive rejection", "安全降级"), "安全降级");
});

test("safeDiagnosticMessage bounds source scans and repairs malformed UTF-16", (t) => {
  const originalTrim = String.prototype.trim;
  t.mock.method(String.prototype, "trim", function () {
    assert.ok(this.length <= DIAGNOSTIC_SCAN_LIMIT, `trim received ${this.length} code units`);
    return originalTrim.call(this);
  });

  const projected = safeDiagnosticMessage({ message: `${"x".repeat(DIAGNOSTIC_SCAN_LIMIT)}forbidden-tail` });
  assert.equal(projected.length, DIAGNOSTIC_MESSAGE_LIMIT);
  assert.match(projected, /…$/u);
  assert.doesNotMatch(projected, /forbidden-tail/u);
  assert.equal(safeDiagnosticMessage({ message: "bad\ud800high and low\udc00" }), "bad�high and low�");
  assert.equal(safeDiagnosticMessage({ message: "complete 👩‍💻 message" }), "complete 👩‍💻 message");
});
