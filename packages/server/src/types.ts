export type ErrorCode =
  | "MISSING_AUTH_HEADER"
  | "TIMESTAMP_EXPIRED"
  | "INVALID_SIGNATURE"
  | "FORBIDDEN"
  | "SOUL_NOT_FOUND"
  | "ANCHOR_NOT_FOUND"
  | "COPY_TARGET_EXISTS"
  | "VALIDATION_ERROR"
  | "INTERNAL_ERROR"
  | "LLM_ERROR"
  | "EXTRACTION_ERROR"
  | "RECALL_ERROR";

export interface ApiError {
  error: ErrorCode;
  message: string;
}

export interface ApiSuccess<T> {
  data: T;
}

export interface PaginatedData<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

export interface Message {
  id: number;
  role: "user" | "assistant" | "system";
  content: string;
  created_at: number;
}

export type SoulAssetKind = "anchor" | "probe";

export type SoulAnchorSource = "interview" | "manual" | "reading";

export interface SoulAnchor {
  id: string;
  question: string;
  answer: string | null;
  source: SoulAnchorSource;
  createdAt: number;
  updatedAt: number;
}

export interface ReasoningMessage {
  id: number;
  visitor_key: string;
  role: "user" | "assistant";
  content: string;
  recalled_anchors: string[] | null;
  created_at: number;
}
