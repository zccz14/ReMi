import pino from "pino";

const level = process.env.LOG_LEVEL ?? "info";

const isTTY = process.stdout.isTTY === true;

const baseLogger = pino({
  level,
  ...(isTTY
    ? {
        transport: {
          target: "pino-pretty",
          options: {
            colorize: true,
            translateTime: "HH:MM:ss.l",
            ignore: "pid,hostname",
          },
        },
      }
    : {}),
});

export interface StructuredLogRecord {
  level: "debug" | "info" | "warn" | "error";
  event?: string;
  alertType?: string;
  msg?: string;
  message?: string;
  [key: string]: unknown;
}

type LogLevel = StructuredLogRecord["level"];
type LogListener = (record: StructuredLogRecord) => void;

const listeners = new Set<LogListener>();

function normalizeLogArgs(bindings: Record<string, unknown>, args: unknown[]) {
  const [first, second] = args;
  let payload: Record<string, unknown> = { ...bindings };
  let message: string | undefined;

  if (typeof first === "string") {
    message = first;
  } else if (first && typeof first === "object") {
    payload = { ...payload, ...(first as Record<string, unknown>) };
    if (typeof second === "string") {
      message = second;
    }
  } else if (first instanceof Error) {
    payload = { ...payload, error: first };
    if (typeof second === "string") {
      message = second;
    }
  }

  if (message) {
    payload = { ...payload, msg: message, message };
  }

  return { payload, message };
}

function emitRecord(levelName: LogLevel, payload: StructuredLogRecord) {
  for (const listener of listeners) {
    listener({ ...payload, level: levelName });
  }
}

function createStructuredLogger(bindings: Record<string, unknown> = {}) {
  return {
    child(extraBindings: Record<string, unknown>) {
      return createStructuredLogger({ ...bindings, ...extraBindings });
    },
    debug(...args: unknown[]) {
      const { payload, message } = normalizeLogArgs(bindings, args);
      baseLogger.debug(payload, message);
      emitRecord("debug", payload as StructuredLogRecord);
    },
    info(...args: unknown[]) {
      const { payload, message } = normalizeLogArgs(bindings, args);
      baseLogger.info(payload, message);
      emitRecord("info", payload as StructuredLogRecord);
    },
    warn(...args: unknown[]) {
      const { payload, message } = normalizeLogArgs(bindings, args);
      baseLogger.warn(payload, message);
      emitRecord("warn", payload as StructuredLogRecord);
    },
    error(...args: unknown[]) {
      const { payload, message } = normalizeLogArgs(bindings, args);
      baseLogger.error(payload, message);
      emitRecord("error", payload as StructuredLogRecord);
    },
  };
}

export const logger = createStructuredLogger();

export function subscribeToLogs(listener: LogListener) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Truncate a public key to first 8 characters for safe logging.
 */
export function shortKey(pubKey: string): string {
  return pubKey.slice(0, 8);
}
