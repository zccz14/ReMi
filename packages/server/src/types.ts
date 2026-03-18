export type ErrorCode =
  | "MISSING_AUTH_HEADER"
  | "TIMESTAMP_EXPIRED"
  | "INVALID_SIGNATURE"
  | "FORBIDDEN"
  | "SOUL_NOT_FOUND"
  | "ANCHOR_NOT_FOUND"
  | "COPY_TARGET_EXISTS"
  | "VALIDATION_ERROR"
  | "INTERNAL_ERROR";

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

export interface SoulAnchor {
  id: string;
  question: string;
  answer: string | null;
  source: "interview" | "manual";
  createdAt: number;
  updatedAt: number;
}
