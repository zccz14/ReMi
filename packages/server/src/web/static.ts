import { statSync } from "node:fs";
import * as fs from "node:fs/promises";
import path from "node:path";

const CONTENT_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
};

export function resolveStaticDir(distDir: string): string {
  if (!distDir) {
    throw new Error("WEB_DIST_DIR is required when WEB_MODE=static");
  }

  const resolved = path.resolve(distDir);

  let stats;
  try {
    stats = statSync(resolved);
  } catch {
    throw new Error(`Static dist directory not found: ${resolved}`);
  }

  if (!stats.isDirectory()) {
    throw new Error(`Static dist path is not a directory: ${resolved}`);
  }

  const indexPath = path.join(resolved, "index.html");
  try {
    const indexStats = statSync(indexPath);
    if (!indexStats.isFile()) {
      throw new Error(`Static index.html is not a file: ${indexPath}`);
    }
  } catch {
    throw new Error(`Static index.html not found: ${indexPath}`);
  }

  return resolved;
}

export function isHtmlNavigationRequest(request: Request): boolean {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return false;
  }

  const accept = request.headers.get("accept");
  if (!accept) {
    return true;
  }

  return accept.includes("text/html") || accept.includes("*/*");
}

export function resolveStaticAssetPath(distDir: string, pathname: string): string | null {
  const decodedPath = decodePathname(pathname);
  if (!decodedPath) {
    return null;
  }

  const relativePath = decodedPath === "/" ? "." : `.${decodedPath}`;
  const resolvedPath = path.resolve(distDir, relativePath);

  if (!isWithinDir(distDir, resolvedPath)) {
    return null;
  }

  return resolvedPath;
}

export async function serveStaticRequest(request: Request, distDir: string): Promise<Response> {
  const url = new URL(request.url);
  const resolvedPath = resolveStaticAssetPath(distDir, url.pathname);

  if (resolvedPath) {
    const fileResponse = await tryServeFile(request.method, resolvedPath);
    if (fileResponse) {
      return fileResponse;
    }
  }

  if (path.extname(url.pathname)) {
    return new Response("Not Found", { status: 404 });
  }

  if (isHtmlNavigationRequest(request)) {
    return serveFile(request.method, path.join(distDir, "index.html"));
  }

  return new Response("Not Found", { status: 404 });
}
function decodePathname(pathname: string): string | null {
  try {
    return decodeURIComponent(pathname);
  } catch {
    return null;
  }
}

function isWithinDir(rootDir: string, candidatePath: string): boolean {
  const relative = path.relative(rootDir, candidatePath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function tryServeFile(method: string, filePath: string): Promise<Response | null> {
  let stats;
  try {
    stats = await fs.stat(filePath);
  } catch {
    return null;
  }

  if (stats.isDirectory()) {
    const indexPath = path.join(filePath, "index.html");
    try {
      const indexStats = await fs.stat(indexPath);
      if (indexStats.isFile()) {
        return serveFile(method, indexPath);
      }
    } catch {
      return null;
    }
    return null;
  }

  if (!stats.isFile()) {
    return null;
  }

  return serveFile(method, filePath);
}

async function serveFile(method: string, filePath: string): Promise<Response> {
  const extension = path.extname(filePath);
  const contentType = CONTENT_TYPES[extension] ?? "application/octet-stream";
  const body = method === "HEAD" ? null : await fs.readFile(filePath);
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": contentType,
    },
  });
}
