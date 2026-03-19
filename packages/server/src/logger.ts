import pino from "pino";

const level = process.env.LOG_LEVEL ?? "info";

const isTTY = process.stdout.isTTY === true;

export const logger = pino({
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

/**
 * Truncate a public key to first 8 characters for safe logging.
 */
export function shortKey(pubKey: string): string {
  return pubKey.slice(0, 8);
}
