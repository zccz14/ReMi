import { describe, expect, it } from "vitest";

import {
  applyReceiptPatch,
  buildCanonicalFact,
  computeMessageHash,
} from "../../src/messaging/ledger.js";

describe("buildCanonicalFact", () => {
  it("sorts party_a_key and party_b_key into stable slots from reordered inputs", () => {
    const canonical = buildCanonicalFact({
      sharedMessageId: "msg-1",
      partyAKey: "pubkey-b",
      partyBKey: "pubkey-a",
      senderKey: "pubkey-b",
      senderKind: "avatar",
      bodyJson: {
        version: 1,
        type: "text",
        text: "hello",
      },
      createdAt: 1_710_000_000_000,
      prevMessageHash: null,
    });

    expect(canonical.party_a_key).toBe("pubkey-a");
    expect(canonical.party_b_key).toBe("pubkey-b");
  });
});

describe("computeMessageHash", () => {
  it("returns the same hash every time for the same canonical fact", () => {
    const fact = buildCanonicalFact({
      sharedMessageId: "msg-1",
      partyAKey: "pubkey-a",
      partyBKey: "pubkey-b",
      senderKey: "pubkey-b",
      senderKind: "avatar",
      bodyJson: {
        version: 1,
        type: "text",
        text: "hello",
      },
      createdAt: 1_710_000_000_000,
      prevMessageHash: null,
    });

    expect(computeMessageHash(fact)).toBe(computeMessageHash(fact));
  });

  it("produces the same hash regardless of body_json key order", () => {
    const base = {
      sharedMessageId: "msg-1",
      senderKey: "pubkey-b",
      senderKind: "avatar" as const,
      createdAt: 1_710_000_000_000,
      prevMessageHash: null,
    };

    const first = buildCanonicalFact({
      ...base,
      partyAKey: "pubkey-a",
      partyBKey: "pubkey-b",
      bodyJson: {
        version: 1,
        type: "text",
        text: "hello",
        meta: {
          z: 2,
          a: 1,
        },
      },
    });

    const second = buildCanonicalFact({
      ...base,
      partyAKey: "pubkey-a",
      partyBKey: "pubkey-b",
      bodyJson: {
        text: "hello",
        meta: {
          a: 1,
          z: 2,
        },
        type: "text",
        version: 1,
      },
    });

    expect(computeMessageHash(first)).toBe(computeMessageHash(second));
  });
});

describe("applyReceiptPatch", () => {
  it("does not change a targeted field when the patch explicitly provides undefined", () => {
    expect(
      applyReceiptPatch(
        {
          delivered_at_a: 100,
          delivered_at_b: 200,
          read_at_a: 300,
          read_at_b: 400,
          attested_at_a: 500,
          attested_at_b: 600,
          sign_a: "sig-a",
          sign_b: "sig-b",
          status_reason_a: "ok-a",
          status_reason_b: "ok-b",
        },
        { slot: "a", readAt: undefined },
      ),
    ).toEqual({
      delivered_at_a: 100,
      delivered_at_b: 200,
      read_at_a: 300,
      read_at_b: 400,
      attested_at_a: 500,
      attested_at_b: 600,
      sign_a: "sig-a",
      sign_b: "sig-b",
      status_reason_a: "ok-a",
      status_reason_b: "ok-b",
    });
  });

  it("clears a targeted field when the patch explicitly provides null", () => {
    expect(
      applyReceiptPatch(
        {
          delivered_at_a: 100,
          delivered_at_b: 200,
          read_at_a: 300,
          read_at_b: 400,
          attested_at_a: 500,
          attested_at_b: 600,
          sign_a: "sig-a",
          sign_b: "sig-b",
          status_reason_a: "ok-a",
          status_reason_b: "ok-b",
        },
        { slot: "a", readAt: null },
      ),
    ).toEqual({
      delivered_at_a: 100,
      delivered_at_b: 200,
      read_at_a: null,
      read_at_b: 400,
      attested_at_a: 500,
      attested_at_b: 600,
      sign_a: "sig-a",
      sign_b: "sig-b",
      status_reason_a: "ok-a",
      status_reason_b: "ok-b",
    });
  });

  it("updates only the targeted read_at slot fields", () => {
    expect(
      applyReceiptPatch(
        {
          delivered_at_a: 100,
          delivered_at_b: 200,
          read_at_a: null,
          read_at_b: 300,
          attested_at_a: null,
          attested_at_b: 400,
          sign_a: null,
          sign_b: "sig-b",
          status_reason_a: null,
          status_reason_b: "ok",
        },
        { slot: "a", readAt: 500 },
      ),
    ).toEqual({
      delivered_at_a: 100,
      delivered_at_b: 200,
      read_at_a: 500,
      read_at_b: 300,
      attested_at_a: null,
      attested_at_b: 400,
      sign_a: null,
      sign_b: "sig-b",
      status_reason_a: null,
      status_reason_b: "ok",
    });
  });

  it("updates only the targeted sign slot fields", () => {
    expect(
      applyReceiptPatch(
        {
          delivered_at_a: 100,
          delivered_at_b: 200,
          read_at_a: 300,
          read_at_b: 400,
          attested_at_a: 500,
          attested_at_b: 600,
          sign_a: "sig-a",
          sign_b: null,
          status_reason_a: "ok",
          status_reason_b: null,
        },
        { slot: "b", sign: "sig-b-updated" },
      ),
    ).toEqual({
      delivered_at_a: 100,
      delivered_at_b: 200,
      read_at_a: 300,
      read_at_b: 400,
      attested_at_a: 500,
      attested_at_b: 600,
      sign_a: "sig-a",
      sign_b: "sig-b-updated",
      status_reason_a: "ok",
      status_reason_b: null,
    });
  });
});
