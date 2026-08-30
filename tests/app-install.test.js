import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { APP_INSTALL_STATUS, createAppInstallController } from "../src/core/app-install.js";

const APP_INSTALL_SOURCE_URL = new URL("../src/core/app-install.js", import.meta.url);

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function installPromptEvent({ choice = Promise.resolve({ outcome: "accepted" }), prompt = () => undefined } = {}) {
  const calls = { preventDefault: 0, prompt: 0 };
  return {
    calls,
    event: {
      isTrusted: true,
      preventDefault() { calls.preventDefault += 1; },
      prompt() {
        calls.prompt += 1;
        return prompt();
      },
      get userChoice() { return choice; }
    }
  };
}

test("install state starts honest and only captures a trusted promptable event", () => {
  const controller = createAppInstallController();
  const installed = createAppInstallController({ installed: true });
  const browserMenuInstall = createAppInstallController();
  const untrusted = installPromptEvent();
  untrusted.event.isTrusted = false;

  assert.equal(controller.getStatus(), APP_INSTALL_STATUS.UNAVAILABLE);
  assert.equal(installed.getStatus(), APP_INSTALL_STATUS.INSTALLED);
  assert.equal(browserMenuInstall.markInstalled(), true);
  assert.equal(browserMenuInstall.getStatus(), APP_INSTALL_STATUS.INSTALLED);
  assert.equal(browserMenuInstall.markInstalled(), false);
  assert.equal(controller.capture(untrusted.event), false);
  assert.equal(untrusted.calls.preventDefault, 0);
  assert.equal(controller.capture({ isTrusted: true, preventDefault() {} }), false);

  const trusted = installPromptEvent();
  assert.equal(controller.capture(trusted.event), true);
  assert.equal(trusted.calls.preventDefault, 1);
  assert.equal(controller.getStatus(), APP_INSTALL_STATUS.AVAILABLE);
  assert.equal(installed.capture(trusted.event), false);
  assert.equal(browserMenuInstall.capture(trusted.event), false);
});

test("one captured event can prompt once and accepted remains distinct from installed", async () => {
  const controller = createAppInstallController();
  const choice = deferred();
  const captured = installPromptEvent({ choice: choice.promise });
  controller.capture(captured.event);

  const resultPromise = controller.prompt();
  assert.equal(captured.calls.prompt, 1);
  assert.equal(controller.getStatus(), APP_INSTALL_STATUS.PROMPTING);
  const repeated = await controller.prompt();
  assert.equal(repeated.outcome, null);
  assert.equal(captured.calls.prompt, 1);

  choice.resolve({ outcome: "accepted" });
  const result = await resultPromise;
  assert.deepEqual(result, { outcome: "accepted", status: APP_INSTALL_STATUS.ACCEPTED });
  assert.equal(controller.getStatus(), APP_INSTALL_STATUS.ACCEPTED);
  assert.notEqual(controller.getStatus(), APP_INSTALL_STATUS.INSTALLED);
});

test("prompt keeps user activation order before its first await", async () => {
  const controller = createAppInstallController();
  const order = [];
  const choice = deferred();
  const event = {
    isTrusted: true,
    preventDefault() {},
    prompt() {
      order.push("prompt");
      return Promise.resolve();
    },
    get userChoice() {
      order.push("choice");
      return choice.promise;
    }
  };
  controller.capture(event);

  const resultPromise = controller.prompt();
  assert.deepEqual(order, ["prompt", "choice"]);
  assert.equal(controller.getStatus(), APP_INSTALL_STATUS.PROMPTING);
  choice.resolve({ outcome: "dismissed" });
  assert.deepEqual(await resultPromise, { outcome: "dismissed", status: APP_INSTALL_STATUS.DISMISSED });
});

test("prompt and userChoice failures each fail closed, consume the event, and recover", async () => {
  for (const [message, createOptions] of [
    ["prompt rejected", () => ({ choice: Promise.resolve({ outcome: "accepted" }), prompt: () => Promise.reject(new Error("prompt rejected")) })],
    ["choice rejected", () => ({ choice: Promise.reject(new Error("choice rejected")), prompt: () => Promise.resolve() })]
  ]) {
    const controller = createAppInstallController();
    const failed = installPromptEvent(createOptions());
    controller.capture(failed.event);

    await assert.rejects(controller.prompt(), new RegExp(message, "u"));
    assert.equal(controller.getStatus(), APP_INSTALL_STATUS.ERROR);
    assert.equal(failed.calls.prompt, 1);
    assert.deepEqual(await controller.prompt(), { outcome: null, status: APP_INSTALL_STATUS.ERROR });
    assert.equal(failed.calls.prompt, 1);

    const recovered = installPromptEvent({ choice: Promise.resolve({ outcome: "dismissed" }) });
    assert.equal(controller.capture(recovered.event), true);
    assert.deepEqual(await controller.prompt(), { outcome: "dismissed", status: APP_INSTALL_STATUS.DISMISSED });
  }

  const getterFailure = createAppInstallController();
  const event = {
    isTrusted: true,
    preventDefault() {},
    prompt() { return Promise.resolve(); },
    get userChoice() { throw new Error("choice getter failed"); }
  };
  getterFailure.capture(event);
  await assert.rejects(getterFailure.prompt(), /choice getter failed/u);
  assert.equal(getterFailure.getStatus(), APP_INSTALL_STATUS.ERROR);
});

test("dismissed and failed prompts are consumed but a later real event can recover", async () => {
  const controller = createAppInstallController();
  const dismissed = installPromptEvent({ choice: Promise.resolve({ outcome: "dismissed" }) });
  controller.capture(dismissed.event);
  assert.deepEqual(await controller.prompt(), { outcome: "dismissed", status: APP_INSTALL_STATUS.DISMISSED });
  assert.equal(controller.getStatus(), APP_INSTALL_STATUS.DISMISSED);
  await controller.prompt();
  assert.equal(dismissed.calls.prompt, 1);

  const failed = installPromptEvent({ prompt: () => { throw new Error("prompt failed"); } });
  controller.capture(failed.event);
  await assert.rejects(controller.prompt(), /prompt failed/u);
  assert.equal(controller.getStatus(), APP_INSTALL_STATUS.ERROR);
  assert.equal(failed.calls.prompt, 1);

  const recovered = installPromptEvent({ choice: Promise.resolve({ outcome: "dismissed" }) });
  assert.equal(controller.capture(recovered.event), true);
  assert.equal(controller.getStatus(), APP_INSTALL_STATUS.AVAILABLE);
  await controller.prompt();
  assert.equal(recovered.calls.prompt, 1);
});

test("unknown browser choices fail closed instead of claiming a dismissal or install", async () => {
  const controller = createAppInstallController();
  const captured = installPromptEvent({ choice: Promise.resolve({ outcome: "other" }) });
  controller.capture(captured.event);

  await assert.rejects(controller.prompt(), /安装提示/u);
  assert.equal(controller.getStatus(), APP_INSTALL_STATUS.ERROR);
});

test("appinstalled wins over late choices and makes installed state monotonic", async () => {
  const controller = createAppInstallController();
  const choice = deferred();
  const captured = installPromptEvent({ choice: choice.promise });
  controller.capture(captured.event);
  const resultPromise = controller.prompt();

  assert.equal(controller.markInstalled(), true);
  assert.equal(controller.getStatus(), APP_INSTALL_STATUS.INSTALLED);
  choice.resolve({ outcome: "dismissed" });
  assert.deepEqual(await resultPromise, { outcome: null, status: APP_INSTALL_STATUS.INSTALLED });
  assert.equal(controller.capture(installPromptEvent().event), false);
  assert.equal(controller.markInstalled(), false);
  assert.equal(controller.getStatus(), APP_INSTALL_STATUS.INSTALLED);
});

test("a newer prompt invalidates an older pending choice without losing itself", async () => {
  const controller = createAppInstallController();
  const firstChoice = deferred();
  const first = installPromptEvent({ choice: firstChoice.promise });
  const second = installPromptEvent({ choice: Promise.resolve({ outcome: "dismissed" }) });
  controller.capture(first.event);
  const firstResult = controller.prompt();

  assert.equal(controller.capture(second.event), true);
  assert.equal(controller.getStatus(), APP_INSTALL_STATUS.AVAILABLE);
  firstChoice.resolve({ outcome: "accepted" });
  assert.deepEqual(await firstResult, { outcome: null, status: APP_INSTALL_STATUS.AVAILABLE });
  assert.equal(first.calls.prompt, 1);
  assert.deepEqual(await controller.prompt(), { outcome: "dismissed", status: APP_INSTALL_STATUS.DISMISSED });
  assert.equal(second.calls.prompt, 1);
});

test("new prompts, installation, and destroy absorb late browser rejections", async () => {
  const replaced = createAppInstallController();
  const oldChoice = deferred();
  replaced.capture(installPromptEvent({ choice: oldChoice.promise }).event);
  const replacedResult = replaced.prompt();
  replaced.capture(installPromptEvent({ choice: Promise.resolve({ outcome: "dismissed" }) }).event);
  oldChoice.reject(new Error("stale choice rejected"));
  assert.deepEqual(await replacedResult, { outcome: null, status: APP_INSTALL_STATUS.AVAILABLE });

  const installed = createAppInstallController();
  const oldPrompt = deferred();
  installed.capture(installPromptEvent({
    choice: Promise.resolve({ outcome: "accepted" }),
    prompt: () => oldPrompt.promise
  }).event);
  const installedResult = installed.prompt();
  installed.markInstalled();
  oldPrompt.reject(new Error("stale prompt rejected"));
  assert.deepEqual(await installedResult, { outcome: null, status: APP_INSTALL_STATUS.INSTALLED });

  const destroyed = createAppInstallController();
  const destroyedChoice = deferred();
  destroyed.capture(installPromptEvent({ choice: destroyedChoice.promise }).event);
  const destroyedResult = destroyed.prompt();
  destroyed.destroy();
  destroyedChoice.reject(new Error("destroyed choice rejected"));
  assert.deepEqual(await destroyedResult, { outcome: null, status: APP_INSTALL_STATUS.PROMPTING });
});

test("destroy clears pending work and ignores every later browser signal", async () => {
  const controller = createAppInstallController();
  const choice = deferred();
  const captured = installPromptEvent({ choice: choice.promise });
  controller.capture(captured.event);
  const resultPromise = controller.prompt();
  controller.destroy();

  choice.resolve({ outcome: "accepted" });
  assert.deepEqual(await resultPromise, { outcome: null, status: APP_INSTALL_STATUS.PROMPTING });
  assert.equal(controller.capture(installPromptEvent().event), false);
  assert.equal(controller.markInstalled(), false);
  assert.equal((await controller.prompt()).outcome, null);
});

test("install state remains page-memory only with no persistence or redraw dependencies", async () => {
  const source = await readFile(APP_INSTALL_SOURCE_URL, "utf8");
  assert.doesNotMatch(source, /(?:localStorage|sessionStorage|navigator\.storage|AppStore|\.render\(|focus\()/u);
  assert.doesNotMatch(source, /(?:APP_VERSION|schemaVersion|revision|backup)/u);
});
