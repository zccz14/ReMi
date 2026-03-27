export interface WebConfig {
  mode: "disabled" | "proxy" | "static";
  viteOrigin?: string;
  distDir?: string;
}

export function shouldProxyToVite(pathname: string): boolean {
  return !pathname.startsWith("/api/") && pathname !== "/api";
}

export async function proxyToVite(request: Request, viteOrigin: string): Promise<Response> {
  const incomingUrl = new URL(request.url);
  const targetUrl = new URL(`${incomingUrl.pathname}${incomingUrl.search}`, viteOrigin);
  const headers = new Headers(request.headers);
  headers.delete("host");

  return fetch(targetUrl.toString(), {
    method: request.method,
    headers,
    body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
    duplex: request.method === "GET" || request.method === "HEAD" ? undefined : "half",
  } as RequestInit & { duplex?: "half" });
}
