import { EXECUTION_SESSION_STATUSES } from "./constants.js";
import { createExecutionSignedHeaders } from "./execution-auth.js";
import type { ExecutionSessionStatus } from "./types.js";

export interface CreateExecutionClientOptions {
  baseUrl: string;
  rootSeed: string | Uint8Array;
  userIdentityPubkey: string;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  nonce?: () => string;
}

interface ExecutionEnvelope<T> {
  data: T;
}

interface ExecutionHealthData {
  status: string;
  execution_trust_pubkey: string;
  version: string;
}

interface ExecutionStatusBatchItem {
  session_id: string;
  status: string;
  updated_at: number;
}

interface ExecutionMessageItem {
  id: string;
  role: string;
  content: string;
  created_at: number;
}

interface ExecutionAppendData {
  session_id: string;
  accepted: boolean;
  status: string;
}

function assertExecutionStatus(status: string): ExecutionSessionStatus {
  if (!(EXECUTION_SESSION_STATUSES as readonly string[]).includes(status)) {
    throw new Error(`unknown execution status: ${JSON.stringify(status)}`);
  }

  return status as ExecutionSessionStatus;
}

function buildUrl(
  baseUrl: string,
  path: string,
  query?: Record<string, string | number | undefined>,
) {
  const url = new URL(path, baseUrl);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
  }
  return url;
}

export function createExecutionClient(options: CreateExecutionClientOptions) {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const now = options.now ?? (() => Date.now());
  const nonce = options.nonce ?? (() => crypto.randomUUID());

  async function requestJson<TResponse>(
    method: string,
    path: string,
    init?: {
      body?: string;
      query?: Record<string, string | number | undefined>;
      allowConflict?: boolean;
    },
  ): Promise<TResponse> {
    const url = buildUrl(options.baseUrl, path, init?.query);
    const timestamp = String(now());
    const requestNonce = nonce();
    const bodyBytes = init?.body === undefined ? undefined : new TextEncoder().encode(init.body);
    const signedHeaders = await createExecutionSignedHeaders({
      rootSeed: options.rootSeed,
      userIdentityPubkey: options.userIdentityPubkey,
      method,
      pathWithQuery: `${url.pathname}${url.search}`,
      timestamp,
      nonce: requestNonce,
      body: bodyBytes,
    });

    const headers: Record<string, string> = { ...signedHeaders };
    if (init?.body !== undefined) headers["Content-Type"] = "application/json";

    const response = await fetchImpl(url.toString(), {
      method,
      headers,
      body: init?.body,
    });

    if (response.status === 409 && init?.allowConflict) {
      throw new Error(`execution session is not idle: ${response.status}`);
    }

    if (!response.ok) {
      throw new Error(`execution request failed: ${method} ${url.pathname} ${response.status}`);
    }

    return (await response.json()) as TResponse;
  }

  return {
    async health() {
      const response = await requestJson<ExecutionEnvelope<ExecutionHealthData>>("GET", "/health");
      return {
        status: response.data.status,
        executionTrustPubkey: response.data.execution_trust_pubkey,
        version: response.data.version,
      };
    },

    async createSession(input: {
      title: string;
      objective: string;
      initialContext: string;
      metadata: {
        remi_node_id: string;
        user_identity_pubkey: string;
      };
    }) {
      const body = JSON.stringify({
        title: input.title,
        objective: input.objective,
        initial_context: input.initialContext,
        metadata: input.metadata,
      });
      const response = await requestJson<ExecutionEnvelope<{ session_id: string; status: string }>>(
        "POST",
        "/sessions",
        { body },
      );

      return {
        sessionId: response.data.session_id,
        status: assertExecutionStatus(response.data.status),
      };
    },

    async getSessionStatuses(sessionIds: string[]) {
      const body = JSON.stringify({ session_ids: sessionIds });
      const response = await requestJson<ExecutionEnvelope<{ items: ExecutionStatusBatchItem[] }>>(
        "POST",
        "/sessions/status/batch",
        { body },
      );

      return response.data.items.map((item) => ({
        sessionId: item.session_id,
        status: assertExecutionStatus(item.status),
        updatedAt: item.updated_at,
      }));
    },

    async getSessionMessages(sessionId: string, options?: { cursor?: string; limit?: number }) {
      const response = await requestJson<
        ExecutionEnvelope<{ items: ExecutionMessageItem[]; has_more: boolean }>
      >("GET", `/sessions/${encodeURIComponent(sessionId)}/messages`, { query: options });

      return {
        items: response.data.items.map((item) => ({
          id: item.id,
          role: item.role,
          content: item.content,
          createdAt: item.created_at,
        })),
        hasMore: response.data.has_more,
      };
    },

    async appendSessionMessage(sessionId: string, content: string) {
      const response = await requestJson<ExecutionEnvelope<ExecutionAppendData>>(
        "POST",
        `/sessions/${encodeURIComponent(sessionId)}/messages`,
        {
          body: JSON.stringify({ content }),
          allowConflict: true,
        },
      );

      return {
        sessionId: response.data.session_id,
        accepted: response.data.accepted,
        status: assertExecutionStatus(response.data.status),
      };
    },
  };
}
