import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { relations } from "drizzle-orm";

export const users = sqliteTable("User", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  name: text("name"),
  email: text("email").notNull().unique(),
  emailVerified: integer("emailVerified", { mode: "timestamp_ms" }),
  image: text("image"),
  createdAt: integer("createdAt", { mode: "timestamp_ms" }).$defaultFn(() => new Date()),
  credits: integer("credits").default(5).notNull(),
  lastCreditResetAt: integer("lastCreditResetAt", { mode: "timestamp_ms" }).$defaultFn(() => new Date()),
  tier: text("tier", { enum: ["FREE", "PRO"] }).default("FREE").notNull(),
  country: text("country"),
  city: text("city"),
});

export const sessions = sqliteTable("Session", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  userId: text("userId").notNull().references(() => users.id, { onDelete: "cascade", onUpdate: "cascade" }),
  prompt: text("prompt").notNull(),
  status: text("status", { enum: ['INIT', "CLARIFYING", "PLANNING", "BUILDING", "COMPLETED", "FAILED", "REVIEW", "REBUILD"] }).default('INIT').notNull(),
  retries: integer("retries").default(0).notNull(),
  error: text("error"),
  failureDetails: text("failureDetails", { mode: "json" }),
  createdAt: integer("createdAt", { mode: "timestamp_ms" }).$defaultFn(() => new Date()),
  updatedAt: integer("updatedAt", { mode: "timestamp_ms" }).$defaultFn(() => new Date()),
  clarification: text("clarification", { mode: "json" }),
  plan: text("plan", { mode: "json" }),
  code: text("code", { mode: "json" }),
  review: text("review", { mode: "json" }),
  reviewCount: integer("reviewCount").default(0).notNull(),
});

export const usersRelations = relations(users, ({ many }) => ({
  sessions: many(sessions),
}));

export const sessionsRelations = relations(sessions, ({ one }) => ({
  user: one(users, {
    fields: [sessions.userId],
    references: [users.id],
  }),
}));