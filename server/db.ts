import { eq, desc, asc, and, gte, lte, inArray, like, sql, isNull, isNotNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import { alias } from "drizzle-orm/mysql-core";
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
export async function upsertUser(userData: Partial<InsertUser> & { openId: string }): Promise<void> {
  if (!userData.openId) {
    throw new Error("User openId is required for upsert");
  }

  const db = await getDb();
  if (!db) {
    console.warn("[Database] Cannot upsert user: database not available");
    return;
  }

  try {
    const values: InsertUser = {
      openId: userData.openId,
    };
    const updateSet: Record<string, unknown> = {};

    const textFields = ["name", "email", "loginMethod"] as const;
    type TextField = (typeof textFields)[number];

    const assignNullable = (field: TextField) => {
      const value = userData[field];
      if (value === undefined) return;
      const normalized = value ?? null;
      values[field] = normalized;
      updateSet[field] = normalized;
    };

    textFields.forEach(assignNullable);

    if (userData.lastSignedIn !== undefined) {
      values.lastSignedIn = userData.lastSignedIn;
      updateSet.lastSignedIn = userData.lastSignedIn;
    }
    if (userData.role !== undefined) {
      values.role = userData.role;
      updateSet.role = userData.role;
    } else if (userData.openId === ENV.ownerOpenId) {
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
  rootTweetAuthor?: string; // Filter for conversation owner
  startTime?: Date;
  endTime?: Date;
  sentiments?: string[];
  minValueScore?: number;
  maxValueScore?: number;
  sortBy?: 'time_desc' | 'time_asc' | 'value_desc' | 'likes_desc';
  limit?: number;
  offset?: number;
  analyzed?: boolean;
}

export async function getCommentsWithAnalysis(filter: CommentFilter) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const conditions = [];
  const parentTweet = alias(rawComments, "parentTweet");
  
  if (filter.tweetId) {
    conditions.push(eq(rawComments.tweetId, filter.tweetId));
  }
  if (filter.authorHandles && filter.authorHandles.length > 0) {
    conditions.push(inArray(rawComments.authorHandle, filter.authorHandles));
  }
  
  // Filter by root tweet author
  const rootTweet = alias(rawComments, "rootTweet");
  if (filter.rootTweetAuthor) {
    conditions.push(eq(rootTweet.authorHandle, filter.rootTweetAuthor));
  }

  if (filter.startTime) {
    conditions.push(gte(rawComments.createdAt, filter.startTime));
  }
  if (filter.endTime) {
    conditions.push(lte(rawComments.createdAt, filter.endTime));
  }

  if (filter.analyzed === true) {
    conditions.push(isNotNull(analyzedComments.replyId));
  } else if (filter.analyzed === false) {
    conditions.push(isNull(analyzedComments.replyId));
  }

  // Only apply sentiment and score filters if we are NOT explicitly looking for unanalyzed comments
  if (filter.analyzed !== false) {
    if (filter.sentiments && filter.sentiments.length > 0) {
      conditions.push(inArray(analyzedComments.sentiment, filter.sentiments as any));
    }
    if (filter.minValueScore !== undefined) {
      conditions.push(gte(analyzedComments.valueScore, String(filter.minValueScore)));
    }
    if (filter.maxValueScore !== undefined) {
      conditions.push(lte(analyzedComments.valueScore, String(filter.maxValueScore)));
    }
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
      replyToText: parentTweet.text, // Fetch parent tweet text
      sentiment: analyzedComments.sentiment,
      valueScore: analyzedComments.valueScore,
      valueType: analyzedComments.valueType,
      summary: analyzedComments.summary,
      analyzedAt: analyzedComments.analyzedAt,
    })
    .from(rawComments)
    .leftJoin(analyzedComments, eq(rawComments.replyId, analyzedComments.replyId))
    .leftJoin(parentTweet, eq(rawComments.replyTo, parentTweet.replyId));

  // Only join rootTweet if we are filtering by it to avoid unnecessary overhead
  if (filter.rootTweetAuthor) {
    query = query.leftJoin(rootTweet, eq(rawComments.tweetId, rootTweet.replyId)) as typeof query;
  }

  if (conditions.length > 0) {
    query = query.where(and(...conditions)) as typeof query;
  }

  // SQL Sort
  const sortBy = filter.sortBy || 'time_desc';
  switch (sortBy) {
    case 'time_desc':
      query = query.orderBy(desc(rawComments.createdAt)) as typeof query;
      break;
    case 'time_asc':
      query = query.orderBy(asc(rawComments.createdAt)) as typeof query;
      break;
    case 'value_desc':
      query = query.orderBy(desc(analyzedComments.valueScore)) as typeof query;
      break;
    case 'likes_desc':
      query = query.orderBy(desc(rawComments.likeCount)) as typeof query;
      break;
    default:
      query = query.orderBy(desc(rawComments.createdAt)) as typeof query;
  }

  // SQL Pagination
  const offset = filter.offset || 0;
  const limit = filter.limit || 50;
  
  query = query.limit(limit).offset(offset) as typeof query;

  return await query;
}

export async function getCommentStats(tweetId?: string, rootTweetAuthor?: string) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const rootTweet = alias(rawComments, "rootTweet");
  const conditions = [];
  if (tweetId) conditions.push(eq(rawComments.tweetId, tweetId));
  if (rootTweetAuthor) conditions.push(eq(rootTweet.authorHandle, rootTweetAuthor));

  let query = db
    .select({
      sentiment: analyzedComments.sentiment,
      valueScore: analyzedComments.valueScore,
      createdAt: rawComments.createdAt,
    })
    .from(rawComments)
    .leftJoin(analyzedComments, eq(rawComments.replyId, analyzedComments.replyId));

  if (rootTweetAuthor) {
    query = query.leftJoin(rootTweet, eq(rawComments.tweetId, rootTweet.replyId)) as typeof query;
  }
  if (conditions.length > 0) {
    query = query.where(and(...conditions)) as typeof query;
  }
  return await query;
}

export async function getUnanalyzedComments(limit: number = 10) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

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

export async function deleteConfig(key: string): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  
  await db.delete(systemConfig).where(eq(systemConfig.configKey, key));
}

// ============ Export Functions ============
export async function getAllCommentsForExport(filter?: CommentFilter) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const conditions = [];
  const rootTweet = alias(rawComments, "rootTweet");

  if (filter?.tweetId) {
    conditions.push(eq(rawComments.tweetId, filter.tweetId));
  }
  if (filter?.rootTweetAuthor) {
    conditions.push(eq(rootTweet.authorHandle, filter.rootTweetAuthor));
  }
  if (filter?.startTime) {
    conditions.push(gte(rawComments.createdAt, filter.startTime));
  }
  if (filter?.endTime) {
    conditions.push(lte(rawComments.createdAt, filter.endTime));
  }

  if (filter?.analyzed === true) {
    conditions.push(isNotNull(analyzedComments.replyId));
  } else if (filter?.analyzed === false) {
    conditions.push(isNull(analyzedComments.replyId));
  }

  if (filter?.analyzed !== false) {
    if (filter?.sentiments && filter.sentiments.length > 0) {
      conditions.push(inArray(analyzedComments.sentiment, filter.sentiments as any));
    }
    if (filter?.minValueScore !== undefined) {
      conditions.push(gte(analyzedComments.valueScore, String(filter.minValueScore)));
    }
    if (filter?.maxValueScore !== undefined) {
      conditions.push(lte(analyzedComments.valueScore, String(filter.maxValueScore)));
    }
  }

  let query = db
    .select({
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

  if (filter?.rootTweetAuthor) {
    query = query.leftJoin(rootTweet, eq(rawComments.tweetId, rootTweet.replyId)) as typeof query;
  }
  if (conditions.length > 0) {
    query = query.where(and(...conditions)) as typeof query;
  }

  query = query.orderBy(desc(rawComments.createdAt)) as typeof query;

  return await query;
}
