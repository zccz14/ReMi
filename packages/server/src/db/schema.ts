import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

export const soulAnchors = sqliteTable("soul_anchors", {
  id: text("id").primaryKey(),
  question: text("question").notNull(),
  answer: text("answer"),
  source: text("source", { enum: ["interview", "manual"] }).notNull(),
  createdAt: integer("created_at", { mode: "number" }).notNull(),
  updatedAt: integer("updated_at", { mode: "number" }).notNull(),
});

export const reasoningMessages = sqliteTable("reasoning_messages", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  visitorKey: text("visitor_key").notNull(),
  role: text("role", { enum: ["user", "assistant"] }).notNull(),
  content: text("content").notNull(),
  recalledAnchors: text("recalled_anchors"),
  createdAt: integer("created_at", { mode: "number" }).notNull(),
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
