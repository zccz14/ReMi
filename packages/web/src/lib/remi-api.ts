type AuthMiniSdk = {
  session: {
    getState: () => { accessToken?: string | null } | undefined;
    refresh: () => Promise<{ accessToken?: string | null } | undefined>;
  };
};

export type Anchor = {
  id: string;
  question: string;
  answer: string | null;
  source: string;
  created_at: number;
  updated_at: number;
};
export type Candidate = {
  id: string;
  kind: "anchor" | "probe";
  question: string;
  answer: string | null;
  source: string;
  created_at: number;
};
export type Inference = { answer: string; recalled_anchor_ids: string[]; boundary: string };

function apiBase() {
  return import.meta.env.VITE_API_BASE ?? window.location.origin;
}

async function token(sdk: AuthMiniSdk) {
  const accessToken =
    sdk.session.getState()?.accessToken ?? (await sdk.session.refresh())?.accessToken;
  if (!accessToken) throw new Error("Auth Mini session is required.");
  return accessToken;
}

async function request<T>(sdk: AuthMiniSdk, path: string, init: RequestInit = {}) {
  const accessToken = await token(sdk);
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${accessToken}`);
  if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const response = await fetch(`${apiBase()}${path}`, { ...init, headers });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(body?.message ?? `Request failed (${response.status}).`);
  }
  return response.json() as Promise<T>;
}

export const remiApi = {
  listAnchors: (sdk: AuthMiniSdk) => request<Anchor[]>(sdk, "/api/anchors"),
  createAnchor: (sdk: AuthMiniSdk, body: { question: string; answer?: string }) =>
    request<Anchor>(sdk, "/api/anchors", { method: "POST", body: JSON.stringify(body) }),
  listCandidates: (sdk: AuthMiniSdk) => request<Candidate[]>(sdk, "/api/candidates"),
  approveCandidate: (sdk: AuthMiniSdk, id: string) =>
    request<Anchor>(sdk, `/api/candidates/${encodeURIComponent(id)}/approve`, { method: "POST" }),
  infer: (sdk: AuthMiniSdk, body: { question: string; context?: string[] }) =>
    request<Inference>(sdk, "/api/inference", { method: "POST", body: JSON.stringify(body) }),
};
