import { int, mysqlEnum, mysqlTable, text, timestamp, varchar } from "drizzle-orm/mysql-core";

/**
 * Core user table backing auth flow.
 * Extend this file with additional tables as your product grows.
 * Columns use camelCase to match both database fields and generated types.
 */
export const users = mysqlTable("users", {
  /**
   * Surrogate primary key. Auto-incremented numeric value managed by the database.
   * Use this for relations between tables.
   */
  id: int("id").autoincrement().primaryKey(),
  /** Manus OAuth identifier (openId) returned from the OAuth callback. Unique per user. */
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
 * Page view tracking table
 * Records every page visit with IP, device type, referrer, and connection activity
 */
export const pageViews = mysqlTable("pageViews", {
  id: int("id").autoincrement().primaryKey(),
  /** ISO timestamp of the visit */
  visitedAt: timestamp("visitedAt").defaultNow().notNull(),
  /** Client IP address (from X-Forwarded-For or request.ip) */
  ipAddress: varchar("ipAddress", { length: 45 }).notNull(),
  /** HTTP Referer header */
  referrer: text("referrer"),
  /** User-Agent header */
  userAgent: text("userAgent"),
  /** Device type: 'desktop', 'tablet', 'mobile' */
  deviceType: mysqlEnum("deviceType", ["desktop", "tablet", "mobile"]).notNull(),
  /** Whether this visit involved entering a 4-digit code to connect as client */
  enteredToken: int("enteredToken").default(0).notNull(), // 0=no, 1=yes
  /** The token entered (if enteredToken=1), stored for analysis */
  tokenEntered: varchar("tokenEntered", { length: 4 }),
  /** Whether this visit involved being connected to by another device (as host) */
  wasConnectedTo: int("wasConnectedTo").default(0).notNull(), // 0=no, 1=yes
  /** The token generated for this host session (if wasConnectedTo=1) */
  hostToken: varchar("hostToken", { length: 4 }),
  /** Whether file transfer occurred during this session */
  hadFileTransfer: int("hadFileTransfer").default(0).notNull(), // 0=no, 1=yes
  /** Total bytes transferred in this session (if hadFileTransfer=1) */
  bytesTransferred: int("bytesTransferred").default(0).notNull(),
  /** Session duration in seconds */
  sessionDurationSeconds: int("sessionDurationSeconds").default(0).notNull(),
  /** Unique session ID to group related events */
  sessionId: varchar("sessionId", { length: 64 }).notNull(),
  /** Visit count for tracking repeated visits from same IP */
  visitCount: int("visitCount").default(1).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type PageView = typeof pageViews.$inferSelect;
export type InsertPageView = typeof pageViews.$inferInsert;

// TODO: Add your tables here