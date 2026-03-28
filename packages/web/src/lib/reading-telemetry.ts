type ReadingEventName =
  | "reading.page_viewed"
  | "reading.session_started"
  | "reading.round_submitted"
  | "reading.next_round_requested"
  | "reading.session_closed"
  | "reading.source_unavailable"
  | "reading.error";

export function trackReadingEvent(name: ReadingEventName, payload: Record<string, unknown> = {}) {
  console.info("[reading]", name, payload);
}

export function trackReadingError(stage: string, error: unknown) {
  console.error("[reading]", "reading.error", {
    stage,
    message: error instanceof Error ? error.message : String(error),
  });
}
