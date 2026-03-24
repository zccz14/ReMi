import type { PartyKeys, PartySlot } from "./types.js";

export function sortPartyKeys(a: string, b: string): PartyKeys {
  if (a === b) {
    throw new Error("Direct message parties must be distinct");
  }

  return a < b ? { partyAKey: a, partyBKey: b } : { partyAKey: b, partyBKey: a };
}

export function getPartySlot(parties: PartyKeys, key: string): PartySlot {
  if (parties.partyAKey === key) {
    return "a";
  }

  if (parties.partyBKey === key) {
    return "b";
  }

  throw new Error("Key is not a participant in this conversation");
}
