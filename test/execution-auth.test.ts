import { describe, expect, it } from "vitest";
import {
  buildExecutionCanonicalString,
  createExecutionSignedHeaders,
  deriveExecutionSigner,
  hashExecutionBody,
} from "../packages/server/src/goals/execution-auth";

describe("execution auth helpers", () => {
  const rootSeed = "remi-execution-root-seed-test-vector-1";
  const userIdentityPubkey = "4wBqpZM9xaSheZzJSMawUKKwhdpChKbZ5eu5ky4Vigw";

  it("derives a stable execution trust pubkey from root seed and user identity pubkey", async () => {
    const signer = await deriveExecutionSigner({ rootSeed, userIdentityPubkey });

    expect(Buffer.from(signer.seed).toString("hex")).toBe(
      "169c7cfaa40fbd2e8dacc44f1bdd6d4cd0add6536684c9adcedda2d846773533",
    );
    expect(signer.executionTrustPubkey).toBe("2rFdZJVwAWeaaZVjz2zCL6h61s7ByvXPFZ1wS6cqiXnR");
  });

  it("builds canonical strings from method, path with query, timestamp, nonce, and body hash", async () => {
    const body = new TextEncoder().encode('{"session_ids":["sess-1","sess-2"]}');
    const bodyHash = await hashExecutionBody(body);

    expect(bodyHash).toBe("f57b1f008ebccf3202b4e9080c702c0b3ece4608873a5a2bd092a5a1d530a806");
    expect(await hashExecutionBody()).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    expect(
      buildExecutionCanonicalString({
        method: "POST",
        pathWithQuery: "/sessions/status/batch?limit=2&cursor=abc",
        timestamp: "1770000000123",
        nonce: "nonce-fixed-001",
        bodyHash,
      }),
    ).toBe(
      "POST\n/sessions/status/batch?limit=2&cursor=abc\n1770000000123\nnonce-fixed-001\nf57b1f008ebccf3202b4e9080c702c0b3ece4608873a5a2bd092a5a1d530a806",
    );
  });

  it("creates the required signed execution headers", async () => {
    const body = new TextEncoder().encode('{"session_ids":["sess-1","sess-2"]}');
    const headers = await createExecutionSignedHeaders({
      rootSeed,
      userIdentityPubkey,
      method: "POST",
      pathWithQuery: "/sessions/status/batch?limit=2&cursor=abc",
      timestamp: "1770000000123",
      nonce: "nonce-fixed-001",
      body,
    });

    expect(headers).toEqual({
      "X-Remi-Timestamp": "1770000000123",
      "X-Remi-Nonce": "nonce-fixed-001",
      "X-Remi-Body-SHA256": "f57b1f008ebccf3202b4e9080c702c0b3ece4608873a5a2bd092a5a1d530a806",
      "X-Remi-Signature":
        "xNJGSeeKPp51+JHp0mY0MQkPU0s0i8YHFco+RV+Dl1lrSTL3TlSAYV0JOvxWQ/bUm/5EfXHNfFL6977l86orDQ==",
      "X-Remi-Execution-Pubkey": "2rFdZJVwAWeaaZVjz2zCL6h61s7ByvXPFZ1wS6cqiXnR",
    });
  });
});
