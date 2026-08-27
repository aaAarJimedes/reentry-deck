import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize, relative, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const port = Number.parseInt(process.env.PORT ?? "4173", 10);
const host = process.env.HOST ?? "127.0.0.1";

const mimeTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json; charset=utf-8"
};

function safePath(urlPath) {
  const decoded = decodeURIComponent((urlPath || "/").split("?")[0]);
  const candidate = normalize(join(root, decoded === "/" ? "index.html" : decoded));
  return relative(root, candidate).startsWith("..") ? null : candidate;
}

const server = createServer((request, response) => {
  const path = safePath(request.url);
  if (!path || !existsSync(path) || !statSync(path).isFile()) {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found");
    return;
  }

  const headers = {
    "Content-Type": mimeTypes[extname(path)] ?? "application/octet-stream",
    "Cache-Control": path.endsWith("sw.js") ? "no-cache" : "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer"
  };
  response.writeHead(200, headers);
  createReadStream(path).pipe(response);
});

server.listen(port, host, () => {
  console.log(`复航台已启动：http://${host}:${port}`);
  console.log("按 Ctrl+C 停止。");
});
