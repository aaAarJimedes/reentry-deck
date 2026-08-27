import { AppStore } from "./core/store.js";
import { ReentryApp } from "./ui/app.js";

const root = document.querySelector("#app");

try {
  const store = new AppStore();
  const app = new ReentryApp(root, store);
  globalThis.reentryApp = app;
} catch (error) {
  console.error("复航台启动失败", error);
  root.setAttribute("aria-busy", "false");
  root.innerHTML = `
    <main class="no-script">
      <div class="brand-mark" aria-hidden="true"><span></span><span></span><span></span></div>
      <h1>工作区暂时无法启动</h1>
      <p>浏览器可能禁用了本地存储。请允许本站保存数据后刷新页面。</p>
      <button class="primary-button" id="retry-startup" type="button">重新尝试</button>
    </main>`;
  root.querySelector("#retry-startup")?.addEventListener("click", () => location.reload());
}

if ("serviceWorker" in navigator && location.protocol !== "file:") {
  window.addEventListener("load", async () => {
    try {
      await navigator.serviceWorker.register("/sw.js", { scope: "/" });
    } catch (error) {
      console.warn("离线外壳注册失败；在线使用不受影响。", error);
    }
  });
}
