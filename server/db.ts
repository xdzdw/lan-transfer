import { eq, and, gte, lte, count } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import { InsertUser, users, pageViews, InsertPageView } from "../drizzle/schema";
import { ENV } from './_core/env';

let _db: ReturnType<typeof drizzle> | null = null;

// Lazily create the drizzle instance so local tooling can run without a DB.
export async function getDb() {
  if (!_db && process.env.DATABASE_URL) {
    try {
      _db = drizzle(process.env.DATABASE_URL);
    } catch (error) {
      console.warn("[Database] Failed to connect:", error);
      _db = null;
    }
  }
  return _db;
}

export async function upsertUser(user: InsertUser): Promise<void> {
  if (!user.openId) {
    throw new Error("User openId is required for upsert");
  }

  const db = await getDb();
  if (!db) {
    console.warn("[Database] Cannot upsert user: database not available");
    return;
  }

  try {
    const values: InsertUser = {
      openId: user.openId,
    };
    const updateSet: Record<string, unknown> = {};

    const textFields = ["name", "email", "loginMethod"] as const;
    type TextField = (typeof textFields)[number];

    const assignNullable = (field: TextField) => {
      const value = user[field];
      if (value === undefined) return;
      const normalized = value ?? null;
      values[field] = normalized;
      updateSet[field] = normalized;
    };

    textFields.forEach(assignNullable);

    if (user.lastSignedIn !== undefined) {
      values.lastSignedIn = user.lastSignedIn;
      updateSet.lastSignedIn = user.lastSignedIn;
    }
    if (user.role !== undefined) {
      values.role = user.role;
      updateSet.role = user.role;
    } else if (user.openId === ENV.ownerOpenId) {
      values.role = 'admin';
      updateSet.role = 'admin';
    }

    if (!values.lastSignedIn) {
      values.lastSignedIn = new Date();
    }

    if (Object.keys(updateSet).length === 0) {
      updateSet.lastSignedIn = new Date();
    }

    await db.insert(users).values(values).onDuplicateKeyUpdate({
      set: updateSet,
    });
  } catch (error) {
    console.error("[Database] Failed to upsert user:", error);
    throw error;
  }
}

export async function getUserByOpenId(openId: string) {
  const db = await getDb();
  if (!db) {
    console.warn("[Database] Cannot get user: database not available");
    return undefined;
  }

  const result = await db.select().from(users).where(eq(users.openId, openId)).limit(1);

  return result.length > 0 ? result[0] : undefined;
}

/**
 * Record a page view with tracking information
 * For IP 103.101.221.72, update the first record instead of inserting new ones
 */
export async function recordPageView(data: InsertPageView): Promise<void> {
  const db = await getDb();
  if (!db) {
    console.warn("[Database] Cannot record page view: database not available");
    return;
  }

  try {
    // Special handling for IP 103.101.221.72: update first record instead of inserting
    if (data.ipAddress === "103.101.221.72") {
      // Find the first record for this IP
      const existing = await db
        .select()
        .from(pageViews)
        .where(eq(pageViews.ipAddress, "103.101.221.72"))
        .limit(1);

      if (existing.length > 0) {
        // Update the first record: increment visitCount and update visitedAt
        await db
          .update(pageViews)
          .set({
            visitedAt: data.visitedAt,
            visitCount: existing[0].visitCount + 1,
          })
          .where(eq(pageViews.id, existing[0].id));
        console.log(`[PageView] Updated IP 103.101.221.72 record, visitCount now: ${existing[0].visitCount + 1}`);
        return;
      }
    }

    // Normal insertion for all other IPs
    await db.insert(pageViews).values(data);
  } catch (error) {
    console.error("[Database] Failed to record page view:", error);
    // Don't throw - page view tracking should not break the app
  }
}

/**
 * Get page view statistics for a time range
 */
export async function getPageViewStats(startTime: Date, endTime: Date) {
  const db = await getDb();
  if (!db) {
    console.warn("[Database] Cannot get page view stats: database not available");
    return null;
  }

  try {
    const stats = await db
      .select()
      .from(pageViews)
      .where(
        and(
          gte(pageViews.visitedAt, startTime),
          lte(pageViews.visitedAt, endTime)
        )
      );
    return stats;
  } catch (error) {
    console.error("[Database] Failed to get page view stats:", error);
    return null;
  }
}

/**
 * Get page view count by device type
 */
export async function getPageViewsByDeviceType(startTime: Date, endTime: Date) {
  const db = await getDb();
  if (!db) {
    console.warn("[Database] Cannot get device stats: database not available");
    return null;
  }

  try {
    const stats = await db
      .select({
        deviceType: pageViews.deviceType,
        count: count(),
      })
      .from(pageViews)
      .where(
        and(
          gte(pageViews.visitedAt, startTime),
          lte(pageViews.visitedAt, endTime)
        )
      )
      .groupBy(pageViews.deviceType);
    return stats;
  } catch (error) {
    console.error("[Database] Failed to get device stats:", error);
    return null;
  }
}

// TODO: add feature queries here as your schema grows.
