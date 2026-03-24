import { createHash } from "node:crypto";

import { canonicalizeBodyJson } from "./body.js";
import { sortPartyKeys } from "./slots.js";
import type { PartySlot } from "./types.js";

type SenderKind = "owner" | "avatar";

interface BuildCanonicalFactInput {
  sharedMessageId: string;
  partyAKey: string;
  partyBKey: string;
  senderKey: string;
  senderKind: SenderKind;
  bodyJson: unknown;
  createdAt: number;
  prevMessageHash: string | null;
}

export interface CanonicalFact {
  shared_message_id: string;
  party_a_key: string;
  party_b_key: string;
  sender_key: string;
  sender_kind: SenderKind;
  body_json: unknown;
  created_at: number;
  prev_message_hash: string | null;
}

export interface ReceiptState {
  delivered_at_a: number | null;
  delivered_at_b: number | null;
  read_at_a: number | null;
  read_at_b: number | null;
  attested_at_a: number | null;
  attested_at_b: number | null;
  sign_a: string | null;
  sign_b: string | null;
  status_reason_a: string | null;
  status_reason_b: string | null;
}

interface ReceiptPatch {
  slot: PartySlot;
  deliveredAt?: number | null;
  readAt?: number | null;
  attestedAt?: number | null;
  sign?: string | null;
  statusReason?: string | null;
}

export function buildCanonicalFact(input: BuildCanonicalFactInput): CanonicalFact {
  const { partyAKey, partyBKey } = sortPartyKeys(input.partyAKey, input.partyBKey);

  if (input.senderKey !== partyAKey && input.senderKey !== partyBKey) {
    throw new Error("sender_key must belong to one of the direct message parties");
  }

  return {
    shared_message_id: input.sharedMessageId,
    party_a_key: partyAKey,
    party_b_key: partyBKey,
    sender_key: input.senderKey,
    sender_kind: input.senderKind,
    body_json: JSON.parse(canonicalizeBodyJson(input.bodyJson)),
    created_at: input.createdAt,
    prev_message_hash: input.prevMessageHash,
  };
}

export function computeMessageHash(fact: CanonicalFact): string {
  return createHash("sha256").update(stableStringify(fact), "utf8").digest("hex");
}

export function applyReceiptPatch(state: ReceiptState, patch: ReceiptPatch): ReceiptState {
  const next = { ...state };
  const suffix = patch.slot;

  if (hasOwn(patch, "deliveredAt")) {
    assignIfDefined(next, `delivered_at_${suffix}`, patch.deliveredAt);
  }

  if (hasOwn(patch, "readAt")) {
    assignIfDefined(next, `read_at_${suffix}`, patch.readAt);
  }

  if (hasOwn(patch, "attestedAt")) {
    assignIfDefined(next, `attested_at_${suffix}`, patch.attestedAt);
  }

  if (hasOwn(patch, "sign")) {
    assignIfDefined(next, `sign_${suffix}`, patch.sign);
  }

  if (hasOwn(patch, "statusReason")) {
    assignIfDefined(next, `status_reason_${suffix}`, patch.statusReason);
  }

  return next;
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortJsonValue(value));
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sortJsonValue(item));
  }

  if (isPlainObject(value)) {
    return Object.keys(value)
      .sort()
      .reduce<Record<string, unknown>>((acc, key) => {
        acc[key] = sortJsonValue(value[key]);
        return acc;
      }, {});
  }

  return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn<T extends object>(value: T, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function assignIfDefined<T extends object>(target: T, key: string, value: unknown): void {
  if (value !== undefined) {
    (target as Record<string, unknown>)[key] = value;
  }
}
