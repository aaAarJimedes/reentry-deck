import { AppStore } from "./core/store.js";
import { renderStartupFailure } from "./core/startup.js";
import { ReentryApp } from "./ui/app.js";

const root = document.querySelector("#app");

try {
  const store = new AppStore();
  const app = new ReentryApp(root, store);
  globalThis.reentryApp = app;
} catch (error) {
  console.error("复航台启动失败", error);
  renderStartupFailure(root);
}

if ("serviceWorker" in navigator && location.protocol !== "file:") {
  window.addEventListener("load", async () => {
    try {
      const appBase = new URL("../", import.meta.url);
      await navigator.serviceWorker.register(new URL("sw.js", appBase), { scope: appBase.pathname });
    } catch (error) {
      console.warn("离线外壳注册失败；在线使用不受影响。", error);
    }
  });
}
