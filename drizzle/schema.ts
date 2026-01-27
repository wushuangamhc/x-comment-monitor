import { int, mysqlEnum, mysqlTable, text, timestamp, varchar, decimal, json } from "drizzle-orm/mysql-core";

/**
 * Core user table backing auth flow.
 */
export const users = mysqlTable("users", {
  id: int("id").autoincrement().primaryKey(),
  openId: varchar("openId", { length: 64 }).notNull().unique(),
  name: text("name"),
  email: varchar("email", { length: 320 }),
  loginMethod: varchar("loginMethod", { length: 64 }),
  role: mysqlEnum("role", ["user", "admin"]).default("user").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  lastSignedIn: timestamp("lastSignedIn").defaultNow().notNull(),
});

export type User = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;

/**
 * Raw comments table - stores factual data from X/Twitter
 */
export const rawComments = mysqlTable("raw_comments", {
  id: int("id").autoincrement().primaryKey(),
  replyId: varchar("replyId", { length: 64 }).notNull().unique(),
  tweetId: varchar("tweetId", { length: 64 }).notNull(),
  authorId: varchar("authorId", { length: 64 }).notNull(),
  authorName: varchar("authorName", { length: 255 }).notNull(),
  authorHandle: varchar("authorHandle", { length: 64 }).notNull(),
  text: text("text").notNull(),
  createdAt: timestamp("createdAt").notNull(),
  likeCount: int("likeCount").default(0).notNull(),
  replyTo: varchar("replyTo", { length: 64 }),
  fetchedAt: timestamp("fetchedAt").defaultNow().notNull(),
});

export type RawComment = typeof rawComments.$inferSelect;
export type InsertRawComment = typeof rawComments.$inferInsert;

/**
 * Analyzed comments table - stores AI analysis results
 * One-to-one relationship with raw_comments
 */
export const analyzedComments = mysqlTable("analyzed_comments", {
  id: int("id").autoincrement().primaryKey(),
  replyId: varchar("replyId", { length: 64 }).notNull().unique(),
  sentiment: mysqlEnum("sentiment", ["positive", "neutral", "negative", "anger", "sarcasm"]).notNull(),
  valueScore: decimal("valueScore", { precision: 3, scale: 2 }).notNull(),
  valueType: json("valueType").$type<string[]>().notNull(),
  summary: text("summary").notNull(),
  analyzedAt: timestamp("analyzedAt").defaultNow().notNull(),
});

export type AnalyzedComment = typeof analyzedComments.$inferSelect;
export type InsertAnalyzedComment = typeof analyzedComments.$inferInsert;

/**
 * Monitor targets table - stores monitored accounts or tweets
 */
export const monitorTargets = mysqlTable("monitor_targets", {
  id: int("id").autoincrement().primaryKey(),
  type: mysqlEnum("type", ["account", "tweet"]).notNull(),
  targetId: varchar("targetId", { length: 64 }).notNull(),
  targetName: varchar("targetName", { length: 255 }),
  targetHandle: varchar("targetHandle", { length: 64 }),
  isActive: int("isActive").default(1).notNull(),
  lastFetchedAt: timestamp("lastFetchedAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type MonitorTarget = typeof monitorTargets.$inferSelect;
export type InsertMonitorTarget = typeof monitorTargets.$inferInsert;

/**
 * System config table - stores API keys and settings
 */
export const systemConfig = mysqlTable("system_config", {
  id: int("id").autoincrement().primaryKey(),
  configKey: varchar("configKey", { length: 64 }).notNull().unique(),
  configValue: text("configValue"),
  description: text("description"),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type SystemConfig = typeof systemConfig.$inferSelect;
export type InsertSystemConfig = typeof systemConfig.$inferInsert;
