export type SseHeartbeat = {
  start(): void;
  stop(): void;
  recordRealWrite(): void;
  readonly failure: Promise<never>;
};

type CreateSseHeartbeatOptions = {
  writeComment: (frame: string) => Promise<void>;
  onError?: (error: unknown) => void;
  now?: () => number;
  silentMs?: number;
  intervalMs?: number;
};

const HEARTBEAT_FRAME = ":\n\n";
const DEFAULT_SILENT_MS = 5000;
const DEFAULT_INTERVAL_MS = 5000;

export function createSseHeartbeat(options: CreateSseHeartbeatOptions): SseHeartbeat {
  const now = options.now ?? Date.now;
  const silentMs = options.silentMs ?? DEFAULT_SILENT_MS;
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;

  let lastRealWriteAt: number | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let started = false;
  let failed = false;
  let rejectFailure!: (error: unknown) => void;

  const failure = new Promise<never>((_, reject) => {
    rejectFailure = reject;
  });
  failure.catch(() => {});

  function clearTimer() {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function stop() {
    started = false;
    clearTimer();
  }

  function handleFailure(error: unknown) {
    if (failed) {
      return;
    }

    failed = true;
    stop();
    options.onError?.(error);
    rejectFailure(error);
  }

  function schedule(delayMs: number) {
    if (!started || failed) {
      return;
    }

    clearTimer();
    timer = setTimeout(
      () => {
        void tick();
      },
      Math.max(0, delayMs),
    );
  }

  async function tick(): Promise<void> {
    if (!started || failed) {
      return;
    }

    const baseline = lastRealWriteAt ?? now();
    const silenceMs = now() - baseline;

    if (silenceMs < silentMs) {
      schedule(silentMs - silenceMs);
      return;
    }

    try {
      await options.writeComment(HEARTBEAT_FRAME);
    } catch (error) {
      handleFailure(error);
      return;
    }

    schedule(intervalMs);
  }

  return {
    start() {
      if (started || failed) {
        return;
      }

      started = true;
      if (lastRealWriteAt === null) {
        lastRealWriteAt = now();
      }
      schedule(silentMs);
    },

    stop,

    recordRealWrite() {
      lastRealWriteAt = now();
    },

    get failure() {
      return failure;
    },
  };
}
