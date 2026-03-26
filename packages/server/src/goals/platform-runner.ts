import * as fs from "node:fs";

export interface PlatformRunnerConfig {
  enabled: boolean;
  intervalMs: number;
}

type IntervalHandle = ReturnType<typeof globalThis.setInterval> | number;

interface PlatformRunnerTimers {
  setInterval(handler: () => void, intervalMs: number): IntervalHandle;
  clearInterval(handle: IntervalHandle): void;
}

export interface CreatePlatformRunnerOptions {
  config: PlatformRunnerConfig;
  listEligibleUsers(): string[] | Promise<string[]>;
  activateUser(pubKey: string): Promise<void>;
  timers?: PlatformRunnerTimers;
  onError?: (error: unknown) => void;
}

function parseEnabled(value: string | undefined) {
  return value === "1" || value === "true";
}

export function parsePlatformRunnerConfig(
  env: Record<string, string | undefined> = process.env,
): PlatformRunnerConfig {
  const intervalMs = Number(env.PLATFORM_SCHEDULER_INTERVAL_MS ?? 60_000);

  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new Error("PLATFORM_SCHEDULER_INTERVAL_MS must be a positive number");
  }

  return {
    enabled: parseEnabled(env.PLATFORM_SCHEDULER_ENABLED),
    intervalMs,
  };
}

export function listEligibleUsersFromDataDir(dataDir: string) {
  if (!fs.existsSync(dataDir)) {
    return [];
  }

  return fs
    .readdirSync(dataDir)
    .filter((entry) => entry.endsWith(".sqlite"))
    .map((entry) => entry.slice(0, -".sqlite".length))
    .sort();
}

export function createPlatformRunner(options: CreatePlatformRunnerOptions) {
  const timers = options.timers ?? {
    setInterval: globalThis.setInterval,
    clearInterval: globalThis.clearInterval,
  };
  let handle: IntervalHandle | null = null;
  let cursor = 0;
  let tickInFlight = false;

  const tick = async () => {
    if (tickInFlight) {
      return;
    }

    tickInFlight = true;
    try {
      const users = await options.listEligibleUsers();
      if (users.length === 0) {
        return;
      }

      const index = cursor % users.length;
      cursor = (index + 1) % users.length;
      await options.activateUser(users[index] as string);
    } finally {
      tickInFlight = false;
    }
  };

  return {
    start() {
      if (!options.config.enabled || handle) {
        return false;
      }

      handle = timers.setInterval(() => {
        void tick().catch((error) => {
          options.onError?.(error);
        });
      }, options.config.intervalMs);
      return true;
    },

    stop() {
      if (handle) {
        timers.clearInterval(handle);
        handle = null;
      }
    },

    tick,
  };
}
