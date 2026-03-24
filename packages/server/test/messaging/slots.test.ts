import { describe, expect, it } from "vitest";

import { getPartySlot, sortPartyKeys } from "../../src/messaging/slots.js";

describe("sortPartyKeys", () => {
  it("sorts pubkeys lexicographically into stable slots", () => {
    expect(sortPartyKeys("pubkey-b", "pubkey-a")).toEqual({
      partyAKey: "pubkey-a",
      partyBKey: "pubkey-b",
    });
  });

  it("keeps already sorted pubkeys unchanged", () => {
    expect(sortPartyKeys("pubkey-a", "pubkey-b")).toEqual({
      partyAKey: "pubkey-a",
      partyBKey: "pubkey-b",
    });
  });

  it("rejects direct messages to the same pubkey", () => {
    expect(() => sortPartyKeys("pubkey-a", "pubkey-a")).toThrow(/distinct/i);
  });
});

describe("getPartySlot", () => {
  const parties = { partyAKey: "pubkey-a", partyBKey: "pubkey-b" };

  it("maps the sorted first pubkey to slot a", () => {
    expect(getPartySlot(parties, "pubkey-a")).toBe("a");
  });

  it("maps the sorted second pubkey to slot b", () => {
    expect(getPartySlot(parties, "pubkey-b")).toBe("b");
  });

  it("rejects keys outside the conversation", () => {
    expect(() => getPartySlot(parties, "pubkey-c")).toThrow(/participant/i);
  });
});
