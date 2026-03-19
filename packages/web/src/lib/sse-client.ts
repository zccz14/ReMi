export interface SSEHandlers {
  onThinking?: (narrative: string) => void;
  onToken?: (content: string) => void;
  onDone?: (data: Record<string, unknown>) => void;
  onError?: (error: { code: string; message: string }) => void;
}

function dispatchEvent(eventStr: string, handlers: SSEHandlers): void {
  if (!eventStr.trim()) return;
  let eventType = "";
  const dataLines: string[] = [];

  for (const line of eventStr.split("\n")) {
    if (line.startsWith("event: ")) {
      eventType = line.slice(7);
    } else if (line.startsWith("data: ")) {
      dataLines.push(line.slice(6));
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice(5));
    }
  }
  const data = dataLines.join("\n");

  switch (eventType) {
    case "thinking":
      handlers.onThinking?.(data);
      break;
    case "token":
      handlers.onToken?.(data);
      break;
    case "done":
      try {
        handlers.onDone?.(JSON.parse(data));
      } catch {
        // ignore malformed JSON
      }
      break;
    case "error":
      try {
        handlers.onError?.(JSON.parse(data));
      } catch {
        handlers.onError?.({ code: "PARSE_ERROR", message: data });
      }
      break;
  }
}

function processBuffer(buffer: string, handlers: SSEHandlers): string {
  const events = buffer.split("\n\n");
  const remainder = events.pop() ?? "";
  for (const eventStr of events) {
    dispatchEvent(eventStr, handlers);
  }
  return remainder;
}

export async function parseSSEStream(
  stream: ReadableStream<Uint8Array>,
  handlers: SSEHandlers,
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      let readResult: ReadableStreamReadResult<Uint8Array>;
      try {
        readResult = await reader.read();
      } catch {
        // Stream aborted — flush any buffered events
        processBuffer(buffer + "\n\n", handlers);
        break;
      }
      const { done, value } = readResult;
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      buffer = processBuffer(buffer, handlers);
    }
  } finally {
    reader.releaseLock();
  }
}
