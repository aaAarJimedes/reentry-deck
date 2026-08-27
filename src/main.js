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
      <p>页面初始化时遇到了异常。请刷新重试；若问题持续，请保留浏览器站点数据并查看开发者控制台。</p>
      <button class="primary-button" id="retry-startup" type="button">重新尝试</button>
    </main>`;
  root.querySelector("#retry-startup")?.addEventListener("click", () => location.reload());
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
