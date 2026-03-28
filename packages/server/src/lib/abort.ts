export function createAbortError(message = "The operation was aborted") {
  return Object.assign(new Error(message), { name: "AbortError" });
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) {
    return;
  }

  throw signal.reason ?? createAbortError();
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
