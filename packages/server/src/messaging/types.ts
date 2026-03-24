export type PartySlot = "a" | "b";

export interface PartyKeys {
  partyAKey: string;
  partyBKey: string;
}

export interface BodyJson {
  type: string;
  version: number;
  [key: string]: unknown;
}
