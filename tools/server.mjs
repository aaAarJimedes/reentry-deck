import { closeSync, createReadStream, fstatSync, openSync } from "node:fs";
import { createServer } from "node:http";
import { isIP } from "node:net";
import { extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const defaultRoot = resolve(import.meta.dirname, "..");
export const MAX_REQUEST_TARGET_LENGTH = 8_192;

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
  ["/src/core/download.js", "src/core/download.js"],
  ["/src/core/diagnostic.js", "src/core/diagnostic.js"],
  ["/src/core/model.js", "src/core/model.js"],
  ["/src/core/import-preview.js", "src/core/import-preview.js"],
  ["/src/core/insights.js", "src/core/insights.js"],
  ["/src/core/store.js", "src/core/store.js"],
  ["/src/core/reentry.js", "src/core/reentry.js"],
  ["/src/core/search.js", "src/core/search.js"],
  ["/src/core/share.js", "src/core/share.js"],
  ["/src/core/session.js", "src/core/session.js"],
  ["/src/core/storage-durability.js", "src/core/storage-durability.js"],
  ["/src/core/startup.js", "src/core/startup.js"],
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
  const requestTarget = rawUrl ?? "/";
  if (typeof requestTarget !== "string"
    || !requestTarget.startsWith("/")
    || requestTarget.startsWith("//")
    || requestTarget.includes("#")
    || /[\u0000-\u0020\u007f-\u009f]/u.test(requestTarget)) {
    return { error: 400, path: null };
  }
  if (requestTarget.length > MAX_REQUEST_TARGET_LENGTH) return { error: 414, path: null };
  let pathname;
  try {
    const parsed = new URL(requestTarget, "http://localhost");
    if (parsed.pathname.includes("%")) return { error: 400, path: null };
    pathname = decodeURIComponent(parsed.pathname);
  } catch {
    return { error: 400, path: null };
  }

  if (/[\u0000-\u001f\u007f-\u009f]/u.test(pathname) || pathname.includes("\\") || pathname.split("/").includes("..")) {
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
      const message = { 400: "Bad request", 404: "Not found", 414: "URI too long" }[resolved.error] ?? "Request failed";
      sendText(response, resolved.error, message, {}, request.method === "HEAD");
      return;
    }
    let descriptor = null;
    let fileStats;
    try {
      descriptor = openSync(resolved.path, "r");
      fileStats = fstatSync(descriptor);
    } catch {
      closeDescriptor(descriptor);
      sendText(response, 404, "Not found", {}, request.method === "HEAD");
      return;
    }
    if (!fileStats.isFile()) {
      closeDescriptor(descriptor);
      sendText(response, 404, "Not found", {}, request.method === "HEAD");
      return;
    }

    response.writeHead(200, securityHeaders({
      "Content-Type": mimeTypes[extname(resolved.path)] ?? "application/octet-stream",
      "Cache-Control": resolved.path.endsWith("sw.js") ? "no-cache" : "no-store",
      "Content-Length": fileStats.size
    }));
    if (request.method === "HEAD" || fileStats.size === 0) {
      closeDescriptor(descriptor);
      response.end();
      return;
    }
    const stream = createReadStream(resolved.path, {
      fd: descriptor,
      autoClose: true,
      start: 0,
      end: fileStats.size - 1
    });
    response.once("close", () => stream.destroy());
    stream.on("error", () => response.destroy()).pipe(response);
  };
}

function closeDescriptor(descriptor) {
  if (!Number.isInteger(descriptor)) return;
  try {
    closeSync(descriptor);
  } catch {
    // The response path already owns the user-visible error.
  }
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
    "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; worker-src 'self'; manifest-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
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
    "Content-Length": Buffer.byteLength(message),
    ...extraHeaders
  }));
  response.end(headOnly ? undefined : message);
}

function runCli() {
  const port = parseServerPort(process.env.PORT ?? "4173");
  const host = parseServerHost(process.env.HOST ?? "127.0.0.1");
  if (port === null) {
    console.error("PORT 必须是 0–65535 之间的整数。");
    process.exitCode = 1;
    return;
  }
  if (host === null) {
    console.error("HOST 必须是有效的主机名、IPv4 或 IPv6 地址，且不能包含协议、端口或路径。");
    process.exitCode = 1;
    return;
  }
  const server = createAppServer();
  const reportStartupError = (error) => {
    console.error(formatServerStartupError(error, host, port));
    process.exitCode = 1;
  };
  server.once("error", reportStartupError);
  server.listen(port, host, () => {
    server.off("error", reportStartupError);
    const url = formatServerUrl(server.address(), host, port);
    console.log(url ? `复航台已启动：${url}` : "复航台已启动。");
    console.log("按 Ctrl+C 停止。");
  });
}

export function formatServerStartupError(error, host, port) {
  const endpoint = formatServerUrl(null, host, port)?.slice("http://".length)
    ?? (Number.isInteger(port) && port >= 0 && port <= 65_535 ? `端口 ${port}` : "未知地址");
  const code = readStartupErrorCode(error);
  if (code === "EADDRINUSE") return `地址 ${endpoint} 已被占用，复航台未启动。`;
  if (code === "EACCES") {
    return `没有权限监听 ${endpoint}，复航台未启动。请改用 1024–65535 的端口或检查网络权限。`;
  }
  return `复航台启动失败：${readStartupErrorDetail(error)}`;
}

function readStartupErrorCode(error) {
  try {
    const code = error?.code;
    return typeof code === "string" ? code : "";
  } catch {
    return "";
  }
}

function readStartupErrorDetail(error) {
  try {
    const stack = error?.stack;
    if (typeof stack === "string" && stack.trim()) return stack;
    const message = error?.message;
    if (typeof message === "string" && message.trim()) return message;
  } catch {
    // Fall through to a stable diagnostic if a hostile error accessor throws.
  }
  return "未知错误";
}

export function formatServerUrl(address, fallbackHost = "127.0.0.1", fallbackPort = 4173) {
  const host = address && typeof address === "object" && typeof address.address === "string"
    ? address.address
    : fallbackHost;
  const port = address && typeof address === "object" && Number.isInteger(address.port)
    ? address.port
    : fallbackPort;
  if (typeof host !== "string" || !host || /[\u0000-\u0020\u007f-\u009f]/u.test(host)) return null;
  if (!Number.isInteger(port) || port < 0 || port > 65_535) return null;
  const bareHost = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  if (!bareHost) return null;
  const candidate = `http://${bareHost.includes(":") ? `[${bareHost}]` : bareHost}:${port}`;
  try {
    const parsed = new URL(candidate);
    if (parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) return null;
    return candidate;
  } catch {
    return null;
  }
}

export function parseServerPort(value) {
  const text = String(value ?? "").trim();
  if (!/^\d{1,5}$/.test(text)) return null;
  const port = Number(text);
  return Number.isInteger(port) && port <= 65_535 ? port : null;
}

export function parseServerHost(value) {
  if (typeof value !== "string"
    || !value
    || value.length > 255
    || /[\s\u007f-\u009f]/u.test(value)) {
    return null;
  }

  const startsWithBracket = value.startsWith("[");
  const endsWithBracket = value.endsWith("]");
  if (startsWithBracket !== endsWithBracket) return null;
  const bracketed = startsWithBracket && endsWithBracket;
  const host = bracketed ? value.slice(1, -1) : value;
  if (!host || host.includes("%")) return null;

  const ipVersion = isIP(host);
  if (bracketed) return ipVersion === 6 ? host.toLowerCase() : null;
  if (ipVersion === 4 || ipVersion === 6) return host.toLowerCase();
  if (host.includes(":") || !/^[A-Za-z0-9.-]+$/u.test(host)) return null;

  const trailingDot = host.endsWith(".");
  const hostname = trailingDot ? host.slice(0, -1) : host;
  if (!hostname || hostname.length > 253) return null;
  const labels = hostname.split(".");
  if (labels.some((label) => label.length < 1
    || label.length > 63
    || !/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/u.test(label))) {
    return null;
  }

  const normalized = `${hostname.toLowerCase()}${trailingDot ? "." : ""}`;
  try {
    if (new URL(`http://${normalized}:4173`).hostname !== normalized) return null;
  } catch {
    return null;
  }
  return normalized;
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) runCli();
