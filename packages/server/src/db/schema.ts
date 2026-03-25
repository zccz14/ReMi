import { sqliteTable, text, integer, blob } from "drizzle-orm/sqlite-core";

export const soulAnchors = sqliteTable("soul_anchors", {
  id: text("id").primaryKey(),
  question: text("question").notNull(),
  answer: text("answer"),
  source: text("source", { enum: ["interview", "manual"] }).notNull(),
  createdAt: integer("created_at", { mode: "number" }).notNull(),
  updatedAt: integer("updated_at", { mode: "number" }).notNull(),
});

export const directMessages = sqliteTable("direct_messages", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  sharedMessageId: text("shared_message_id").notNull(),
  partyAKey: text("party_a_key").notNull(),
  partyBKey: text("party_b_key").notNull(),
  senderKey: text("sender_key").notNull(),
  senderKind: text("sender_kind", { enum: ["owner", "avatar"] }).notNull(),
  ciphertextA: text("ciphertext_a").notNull(),
  ciphertextB: text("ciphertext_b").notNull(),
  ciphertextC: text("ciphertext_c").notNull(),
  messageHash: text("message_hash").notNull(),
  prevMessageHash: text("prev_message_hash"),
  createdAt: integer("created_at", { mode: "number" }).notNull(),
  deliveredAtA: integer("delivered_at_a", { mode: "number" }),
  deliveredAtB: integer("delivered_at_b", { mode: "number" }),
  readAtA: integer("read_at_a", { mode: "number" }),
  readAtB: integer("read_at_b", { mode: "number" }),
  attestedAtA: integer("attested_at_a", { mode: "number" }),
  attestedAtB: integer("attested_at_b", { mode: "number" }),
  signA: text("sign_a"),
  signB: text("sign_b"),
  statusReasonA: text("status_reason_a"),
  statusReasonB: text("status_reason_b"),
});

export const messages = sqliteTable("messages", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  role: text("role", {
    enum: ["user", "assistant", "system"],
  }).notNull(),
  content: text("content").notNull(),
  createdAt: integer("created_at", { mode: "number" }).notNull(),
});

export const memories = sqliteTable("memories", {
  id: text("id").primaryKey(),
  content: text("content").notNull(),
  occurredAt: integer("occurred_at", { mode: "number" }).notNull(),
  source: text("source", { enum: ["interview", "manual"] }).notNull(),
  metadata: text("metadata"),
  createdAt: integer("created_at", { mode: "number" }).notNull(),
});

export const publicProfile = sqliteTable("public_profile", {
  id: text("id").primaryKey(),
  displayName: text("display_name"),
  bio: text("bio"),
  updatedAt: integer("updated_at", { mode: "number" }).notNull(),
});

export const publicProfileAvatar = sqliteTable("public_profile_avatar", {
  id: text("id").primaryKey(),
  blob: blob("blob", { mode: "buffer" }).notNull(),
  updatedAt: integer("updated_at", { mode: "number" }).notNull(),
});

export const apiTokens = sqliteTable("api_tokens", {
  id: text("id").primaryKey(),
  note: text("note").notNull(),
  createdAt: text("created_at").notNull(),
});
