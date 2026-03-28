import { afterEach, describe, expect, it, vi } from "vitest";
import { createSseHeartbeat } from "../../src/lib/sse-heartbeat.js";

describe("createSseHeartbeat", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("emits a comment heartbeat after 5 seconds of real-output silence", async () => {
    vi.useFakeTimers();

    const writes: string[] = [];
    const heartbeat = createSseHeartbeat({
      writeComment: async (frame) => {
        writes.push(frame);
      },
    });

    heartbeat.recordRealWrite();
    heartbeat.start();
    await vi.advanceTimersByTimeAsync(5000);

    expect(writes).toEqual([":\n\n"]);
  });

  it("does not emit a heartbeat before the silence threshold", async () => {
    vi.useFakeTimers();

    const writeComment = vi.fn(async () => {});
    const heartbeat = createSseHeartbeat({ writeComment });

    heartbeat.recordRealWrite();
    heartbeat.start();
    await vi.advanceTimersByTimeAsync(4999);

    expect(writeComment).not.toHaveBeenCalled();
  });

  it("recordRealWrite resets the silence window", async () => {
    vi.useFakeTimers();

    const writes: string[] = [];
    const heartbeat = createSseHeartbeat({
      writeComment: async (frame) => {
        writes.push(frame);
      },
    });

    heartbeat.recordRealWrite();
    heartbeat.start();

    await vi.advanceTimersByTimeAsync(4000);
    heartbeat.recordRealWrite();
    await vi.advanceTimersByTimeAsync(4000);
    expect(writes).toEqual([]);

    await vi.advanceTimersByTimeAsync(1000);
    expect(writes).toEqual([":\n\n"]);
  });

  it("continues emitting heartbeats every interval while silence persists", async () => {
    vi.useFakeTimers();

    const writes: string[] = [];
    const heartbeat = createSseHeartbeat({
      writeComment: async (frame) => {
        writes.push(frame);
      },
    });

    heartbeat.recordRealWrite();
    heartbeat.start();

    await vi.advanceTimersByTimeAsync(5000);
    expect(writes).toEqual([":\n\n"]);

    await vi.advanceTimersByTimeAsync(5000);
    expect(writes).toEqual([":\n\n", ":\n\n"]);
  });

  it("stop prevents future heartbeats", async () => {
    vi.useFakeTimers();

    const writeComment = vi.fn(async () => {});
    const heartbeat = createSseHeartbeat({ writeComment });

    heartbeat.recordRealWrite();
    heartbeat.start();
    heartbeat.stop();
    await vi.advanceTimersByTimeAsync(15000);

    expect(writeComment).not.toHaveBeenCalled();
  });

  it("allows repeated stop calls", async () => {
    vi.useFakeTimers();

    const writeComment = vi.fn(async () => {});
    const heartbeat = createSseHeartbeat({ writeComment });

    heartbeat.start();
    heartbeat.stop();
    heartbeat.stop();
    await vi.advanceTimersByTimeAsync(15000);

    expect(writeComment).not.toHaveBeenCalled();
  });

  it("stops future timers and rejects failure when heartbeat writes fail", async () => {
    vi.useFakeTimers();

    const error = new Error("write failed");
    const onError = vi.fn();
    const writeComment = vi.fn<(frame: string) => Promise<void>>().mockRejectedValueOnce(error);
    const heartbeat = createSseHeartbeat({ writeComment, onError });

    heartbeat.recordRealWrite();
    heartbeat.start();

    await vi.advanceTimersByTimeAsync(5000);

    await expect(heartbeat.failure).rejects.toBe(error);
    expect(onError).toHaveBeenCalledWith(error);

    await vi.advanceTimersByTimeAsync(15000);
    expect(writeComment).toHaveBeenCalledTimes(1);
  });

  it("still rejects failure when onError throws", async () => {
    vi.useFakeTimers();

    const writeError = new Error("write failed");
    const onErrorFailure = new Error("onError failed");
    const onError = vi.fn(() => {
      throw onErrorFailure;
    });
    const writeComment = vi
      .fn<(frame: string) => Promise<void>>()
      .mockRejectedValueOnce(writeError);
    const heartbeat = createSseHeartbeat({ writeComment, onError });

    heartbeat.recordRealWrite();
    heartbeat.start();

    await vi.advanceTimersByTimeAsync(5000);
    await expect(heartbeat.failure).rejects.toBe(writeError);
    expect(onError).toHaveBeenCalledWith(writeError);

    await vi.advanceTimersByTimeAsync(15000);
    expect(writeComment).toHaveBeenCalledTimes(1);
  });
});
