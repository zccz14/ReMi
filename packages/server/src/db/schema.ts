import { sqliteTable, text, integer, blob, uniqueIndex } from "drizzle-orm/sqlite-core";

export const soulAnchors = sqliteTable("soul_anchors", {
  id: text("id").primaryKey(),
  question: text("question").notNull(),
  answer: text("answer"),
  source: text("source", { enum: ["interview", "manual", "reading"] }).notNull(),
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
  source: text("source", { enum: ["interview", "manual", "reading"] }).notNull(),
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

export const goalNodes = sqliteTable("goal_nodes", {
  id: text("id").primaryKey(),
  parent_id: text("parent_id"),
  type: text("type").notNull(),
  title: text("title").notNull(),
  objective: text("objective").notNull(),
  status: text("status").notNull(),
  dependency_ids: text("dependency_ids").notNull(),
  execution_base_url: text("execution_base_url"),
  external_session_id: text("external_session_id"),
});

export const soulCandidateQueue = sqliteTable("soul_candidate_queue", {
  id: text("id").primaryKey(),
  ownerKey: text("owner_key").notNull(),
  question: text("question").notNull(),
  answer: text("answer"),
  createdAt: integer("created_at", { mode: "number" }).notNull(),
});

export const approvalLastActions = sqliteTable("approval_last_actions", {
  ownerKey: text("owner_key").primaryKey(),
  candidateId: text("candidate_id").notNull(),
  actionType: text("action_type").notNull(),
  payload: text("payload").notNull(),
  createdAt: integer("created_at", { mode: "number" }).notNull(),
});

export const approvalRequests = sqliteTable(
  "approval_requests",
  {
    id: text("id").primaryKey(),
    ownerKey: text("owner_key").notNull(),
    candidateId: text("candidate_id").notNull(),
    requestId: text("request_id").notNull(),
    createdAt: integer("created_at", { mode: "number" }).notNull(),
  },
  (table) => ({
    ownerCandidateRequestIdx: uniqueIndex("idx_approval_requests_owner_candidate_request").on(
      table.ownerKey,
      table.candidateId,
      table.requestId,
    ),
  }),
);
