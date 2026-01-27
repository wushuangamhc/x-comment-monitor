import { eq, desc, asc, and, gte, lte, inArray, like, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import { 
  InsertUser, users, 
  rawComments, InsertRawComment, RawComment,
  analyzedComments, InsertAnalyzedComment, AnalyzedComment,
  monitorTargets, InsertMonitorTarget, MonitorTarget,
  systemConfig, InsertSystemConfig, SystemConfig
} from "../drizzle/schema";
import { ENV } from './_core/env';

let _db: ReturnType<typeof drizzle> | null = null;

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

// ============ User Functions ============
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

// ============ Raw Comments Functions ============
export async function insertRawComment(comment: InsertRawComment): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  
  await db.insert(rawComments).values(comment).onDuplicateKeyUpdate({
    set: {
      likeCount: comment.likeCount,
      fetchedAt: new Date(),
    },
  });
}

export async function insertRawComments(comments: InsertRawComment[]): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  if (comments.length === 0) return;
  
  for (const comment of comments) {
    await insertRawComment(comment);
  }
}

export interface CommentFilter {
  tweetId?: string;
  authorHandles?: string[];
  startTime?: Date;
  endTime?: Date;
  sentiments?: string[];
  minValueScore?: number;
  maxValueScore?: number;
  sortBy?: 'time_desc' | 'time_asc' | 'value_desc' | 'likes_desc';
  limit?: number;
  offset?: number;
}

export async function getCommentsWithAnalysis(filter: CommentFilter) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const conditions = [];
  
  if (filter.tweetId) {
    conditions.push(eq(rawComments.tweetId, filter.tweetId));
  }
  if (filter.authorHandles && filter.authorHandles.length > 0) {
    conditions.push(inArray(rawComments.authorHandle, filter.authorHandles));
  }
  if (filter.startTime) {
    conditions.push(gte(rawComments.createdAt, filter.startTime));
  }
  if (filter.endTime) {
    conditions.push(lte(rawComments.createdAt, filter.endTime));
  }

  let query = db
    .select({
      id: rawComments.id,
      replyId: rawComments.replyId,
      tweetId: rawComments.tweetId,
      authorId: rawComments.authorId,
      authorName: rawComments.authorName,
      authorHandle: rawComments.authorHandle,
      text: rawComments.text,
      createdAt: rawComments.createdAt,
      likeCount: rawComments.likeCount,
      replyTo: rawComments.replyTo,
      sentiment: analyzedComments.sentiment,
      valueScore: analyzedComments.valueScore,
      valueType: analyzedComments.valueType,
      summary: analyzedComments.summary,
      analyzedAt: analyzedComments.analyzedAt,
    })
    .from(rawComments)
    .leftJoin(analyzedComments, eq(rawComments.replyId, analyzedComments.replyId));

  if (conditions.length > 0) {
    query = query.where(and(...conditions)) as typeof query;
  }

  // Apply sentiment and value score filters after join
  let results = await query;
  
  if (filter.sentiments && filter.sentiments.length > 0) {
    results = results.filter(r => r.sentiment && filter.sentiments!.includes(r.sentiment));
  }
  if (filter.minValueScore !== undefined) {
    results = results.filter(r => r.valueScore && parseFloat(r.valueScore) >= filter.minValueScore!);
  }
  if (filter.maxValueScore !== undefined) {
    results = results.filter(r => r.valueScore && parseFloat(r.valueScore) <= filter.maxValueScore!);
  }

  // Sort
  const sortBy = filter.sortBy || 'time_desc';
  results.sort((a, b) => {
    switch (sortBy) {
      case 'time_desc':
        return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
      case 'time_asc':
        return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
      case 'value_desc':
        return (parseFloat(b.valueScore || '0') - parseFloat(a.valueScore || '0'));
      case 'likes_desc':
        return b.likeCount - a.likeCount;
      default:
        return 0;
    }
  });

  // Pagination
  const offset = filter.offset || 0;
  const limit = filter.limit || 50;
  return results.slice(offset, offset + limit);
}

export async function getCommentStats(tweetId?: string) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const conditions = tweetId ? [eq(rawComments.tweetId, tweetId)] : [];

  const query = db
    .select({
      sentiment: analyzedComments.sentiment,
      valueScore: analyzedComments.valueScore,
      createdAt: rawComments.createdAt,
    })
    .from(rawComments)
    .leftJoin(analyzedComments, eq(rawComments.replyId, analyzedComments.replyId));

  if (conditions.length > 0) {
    return await (query.where(and(...conditions)) as typeof query);
  }
  return await query;
}

export async function getUnanalyzedComments(limit: number = 10) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const analyzed = db.select({ replyId: analyzedComments.replyId }).from(analyzedComments);
  
  return await db
    .select()
    .from(rawComments)
    .where(sql`${rawComments.replyId} NOT IN (SELECT replyId FROM analyzed_comments)`)
    .limit(limit);
}

export async function getTopCommenters(tweetId?: string, limit: number = 10) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const conditions = tweetId ? [eq(rawComments.tweetId, tweetId)] : [];

  let query = db
    .select({
      authorHandle: rawComments.authorHandle,
      authorName: rawComments.authorName,
      count: sql<number>`COUNT(*)`.as('count'),
    })
    .from(rawComments);

  if (conditions.length > 0) {
    query = query.where(and(...conditions)) as typeof query;
  }

  return await query
    .groupBy(rawComments.authorHandle, rawComments.authorName)
    .orderBy(desc(sql`count`))
    .limit(limit);
}

// ============ Analyzed Comments Functions ============
export async function insertAnalyzedComment(analysis: InsertAnalyzedComment): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  
  await db.insert(analyzedComments).values(analysis).onDuplicateKeyUpdate({
    set: {
      sentiment: analysis.sentiment,
      valueScore: analysis.valueScore,
      valueType: analysis.valueType,
      summary: analysis.summary,
      analyzedAt: new Date(),
    },
  });
}

// ============ Monitor Targets Functions ============
export async function getActiveMonitorTargets() {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  
  return await db.select().from(monitorTargets).where(eq(monitorTargets.isActive, 1));
}

export async function insertMonitorTarget(target: InsertMonitorTarget): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  
  await db.insert(monitorTargets).values(target);
}

export async function updateMonitorTarget(id: number, updates: Partial<InsertMonitorTarget>): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  
  await db.update(monitorTargets).set(updates).where(eq(monitorTargets.id, id));
}

export async function deleteMonitorTarget(id: number): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  
  await db.delete(monitorTargets).where(eq(monitorTargets.id, id));
}

// ============ System Config Functions ============
export async function getConfig(key: string): Promise<string | null> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  
  const result = await db.select().from(systemConfig).where(eq(systemConfig.configKey, key)).limit(1);
  return result.length > 0 ? result[0].configValue : null;
}

export async function setConfig(key: string, value: string, description?: string): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  
  await db.insert(systemConfig).values({
    configKey: key,
    configValue: value,
    description,
  }).onDuplicateKeyUpdate({
    set: {
      configValue: value,
      description,
    },
  });
}

export async function getAllConfigs(): Promise<SystemConfig[]> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  
  return await db.select().from(systemConfig);
}
