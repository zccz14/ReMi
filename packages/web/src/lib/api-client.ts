import { buildStringToSign } from "./signing";
import type { SSEHandlers } from "./sse-client";

interface KeyStoreLike {
  getPublicKey(): string;
  sign(data: Uint8Array): Promise<string>;
}

export interface ApiClientConfig {
  baseUrl: string;
  keyStore: KeyStoreLike;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export class ApiClient {
  private baseUrl: string;
  private keyStore: KeyStoreLike;

  constructor(config: ApiClientConfig) {
    this.baseUrl = config.baseUrl;
    this.keyStore = config.keyStore;
  }

  ownerPath(path: string): string {
    return `/api/${this.keyStore.getPublicKey()}${path}`;
  }

  async get<T>(path: string): Promise<T> {
    return this.request<T>("GET", path);
  }

  async post<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>("POST", path, body);
  }

  async put<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>("PUT", path, body);
  }

  async putBinary(path: string, body: Blob, contentType: string): Promise<void> {
    const bytes = new Uint8Array(await body.arrayBuffer());
    await this.requestBinary("PUT", path, bytes, body, contentType);
  }

  async del(path: string): Promise<void> {
    await this.request<void>("DELETE", path);
  }

  async streamPost(path: string, body: unknown, handlers: SSEHandlers): Promise<void> {
    const timestamp = String(Date.now());
    const bodyStr = JSON.stringify(body);
    const bodyBytes = new TextEncoder().encode(bodyStr);

    const url = new URL(path, "http://placeholder");
    const pathname = url.pathname;

    const stringToSign = await buildStringToSign("POST", pathname, timestamp, bodyBytes);
    const signature = await this.keyStore.sign(new TextEncoder().encode(stringToSign));

    const response = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Public-Key": this.keyStore.getPublicKey(),
        "X-Timestamp": timestamp,
        "X-Signature": signature,
      },
      body: bodyStr,
    });

    if (!response.ok || !response.body) {
      let errorBody: { error?: string; message?: string } = {};
      try {
        errorBody = await response.json();
      } catch {
        // ignore
      }
      throw new ApiError(
        response.status,
        errorBody.error ?? "UNKNOWN",
        errorBody.message ?? `HTTP ${response.status}`,
      );
    }

    const { parseSSEStream } = await import("./sse-client");
    await parseSSEStream(response.body, handlers);
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const timestamp = String(Date.now());
    const bodyStr = body !== undefined ? JSON.stringify(body) : undefined;
    const bodyBytes = bodyStr ? new TextEncoder().encode(bodyStr) : undefined;
    const signature = await this.signRequest(method, path, timestamp, bodyBytes);

    const headers: Record<string, string> = {
      "X-Public-Key": this.keyStore.getPublicKey(),
      "X-Timestamp": timestamp,
      "X-Signature": signature,
    };
    if (bodyStr) {
      headers["Content-Type"] = "application/json";
    }

    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: bodyStr,
    });

    if (!response.ok) {
      let errorBody: { error?: string; message?: string } = {};
      try {
        errorBody = await response.json();
      } catch {
        // ignore parse errors
      }
      throw new ApiError(
        response.status,
        errorBody.error ?? "UNKNOWN",
        errorBody.message ?? `HTTP ${response.status}`,
      );
    }

    if (response.status === 204) return undefined as T;
    return response.json();
  }

  private async requestBinary(
    method: string,
    path: string,
    bodyBytes: Uint8Array,
    body: Blob,
    contentType: string,
  ): Promise<void> {
    const timestamp = String(Date.now());
    const signature = await this.signRequest(method, path, timestamp, bodyBytes);

    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        "Content-Type": contentType,
        "X-Public-Key": this.keyStore.getPublicKey(),
        "X-Timestamp": timestamp,
        "X-Signature": signature,
      },
      body,
    });

    if (!response.ok) {
      let errorBody: { error?: string; message?: string } = {};
      try {
        errorBody = await response.json();
      } catch {
        // ignore parse errors
      }
      throw new ApiError(
        response.status,
        errorBody.error ?? "UNKNOWN",
        errorBody.message ?? `HTTP ${response.status}`,
      );
    }
  }

  private async signRequest(
    method: string,
    path: string,
    timestamp: string,
    bodyBytes?: Uint8Array,
  ): Promise<string> {
    const pathname = new URL(path, "http://placeholder").pathname;
    const stringToSign = await buildStringToSign(method, pathname, timestamp, bodyBytes);
    return this.keyStore.sign(new TextEncoder().encode(stringToSign));
  }
}
