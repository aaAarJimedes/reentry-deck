import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const defaultRoot = resolve(import.meta.dirname, "..");

export const PUBLIC_FILES = Object.freeze(new Map([
  ["/", "index.html"],
  ["/index.html", "index.html"],
  ["/app.webmanifest", "app.webmanifest"],
  ["/assets/icon.svg", "assets/icon.svg"],
  ["/sw.js", "sw.js"],
  ["/src/styles.css", "src/styles.css"],
  ["/src/main.js", "src/main.js"],
  ["/src/ui/app.js", "src/ui/app.js"],
  ["/src/core/capture.js", "src/core/capture.js"],
  ["/src/core/backup-file.js", "src/core/backup-file.js"],
  ["/src/core/model.js", "src/core/model.js"],
  ["/src/core/import-preview.js", "src/core/import-preview.js"],
  ["/src/core/insights.js", "src/core/insights.js"],
  ["/src/core/store.js", "src/core/store.js"],
  ["/src/core/reentry.js", "src/core/reentry.js"],
  ["/src/core/search.js", "src/core/search.js"],
  ["/src/core/session.js", "src/core/session.js"],
  ["/src/core/timeline.js", "src/core/timeline.js"],
  ["/src/core/time.js", "src/core/time.js"]
]));

const mimeTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json; charset=utf-8"
};

export function resolvePublicFile(rawUrl, root = defaultRoot) {
  let pathname;
  try {
    const parsed = new URL(rawUrl || "/", "http://localhost");
    pathname = decodeURIComponent(parsed.pathname);
  } catch {
    return { error: 400, path: null };
  }

  if (pathname.includes("\0") || pathname.includes("\\") || pathname.split("/").includes("..")) {
    return { error: 400, path: null };
  }
  const relativePath = PUBLIC_FILES.get(pathname);
  if (!relativePath) return { error: 404, path: null };
  return { error: null, path: join(root, relativePath) };
}

export function createRequestHandler(root = defaultRoot) {
  return (request, response) => {
    if (!request || !response) return;
    if (!new Set(["GET", "HEAD"]).has(request.method)) {
      sendText(response, 405, "Method not allowed", { Allow: "GET, HEAD" }, request.method === "HEAD");
      return;
    }

    const resolved = resolvePublicFile(request.url, root);
    if (resolved.error) {
      sendText(response, resolved.error, resolved.error === 400 ? "Bad request" : "Not found", {}, request.method === "HEAD");
      return;
    }
    if (!existsSync(resolved.path) || !statSync(resolved.path).isFile()) {
      sendText(response, 404, "Not found", {}, request.method === "HEAD");
      return;
    }

    response.writeHead(200, securityHeaders({
      "Content-Type": mimeTypes[extname(resolved.path)] ?? "application/octet-stream",
      "Cache-Control": resolved.path.endsWith("sw.js") ? "no-cache" : "no-store"
    }));
    if (request.method === "HEAD") response.end();
    else createReadStream(resolved.path).on("error", () => response.destroy()).pipe(response);
  };
}

export function createAppServer(options = {}) {
  const server = createServer(createRequestHandler(options.root ?? defaultRoot));
  server.on("clientError", (_error, socket) => {
    if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
  });
  return server;
}

function securityHeaders(extra = {}) {
  return {
    "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; worker-src 'self'; manifest-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    "X-Frame-Options": "DENY",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Cross-Origin-Opener-Policy": "same-origin",
    ...extra
  };
}

function sendText(response, status, message, extraHeaders = {}, headOnly = false) {
  response.writeHead(status, securityHeaders({
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
    ...extraHeaders
  }));
  response.end(headOnly ? undefined : message);
}

function runCli() {
  const port = Number.parseInt(process.env.PORT ?? "4173", 10);
  const host = process.env.HOST ?? "127.0.0.1";
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    console.error("PORT 必须是 0–65535 之间的整数。");
    process.exitCode = 1;
    return;
  }
  const server = createAppServer();
  server.once("error", (error) => {
    console.error(error.code === "EADDRINUSE" ? `端口 ${port} 已被占用，复航台未启动。` : `复航台启动失败：${error.message}`);
    process.exitCode = 1;
  });
  server.listen(port, host, () => {
    console.log(`复航台已启动：http://${host}:${port}`);
    console.log("按 Ctrl+C 停止。");
  });
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) runCli();
