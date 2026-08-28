const STARTUP_FAILURE_HTML = `
  <main class="no-script">
    <div class="brand-mark" aria-hidden="true"><span></span><span></span><span></span></div>
    <h1>工作区暂时无法启动</h1>
    <p>页面初始化时遇到了异常。请刷新重试；若问题持续，请保留浏览器站点数据并查看开发者控制台。</p>
    <button class="primary-button" id="retry-startup" type="button">重新尝试</button>
  </main>`;

export function renderStartupFailure(root, options = {}) {
  try {
    const documentRef = options.documentRef ?? globalThis.document;
    const reload = options.reload ?? (() => globalThis.location?.reload?.());
    let host = root;

    if (!host) {
      if (!documentRef?.body || typeof documentRef.createElement !== "function") return null;
      host = documentRef.createElement("div");
      host.id = "app";
      documentRef.body.append(host);
    }

    if (typeof host.setAttribute !== "function") return null;
    host.setAttribute("aria-busy", "false");
    host.innerHTML = STARTUP_FAILURE_HTML;
    host.querySelector?.("#retry-startup")?.addEventListener?.("click", () => reload());
    return host;
  } catch {
    return null;
  }
}
