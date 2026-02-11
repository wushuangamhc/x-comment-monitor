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

// Local dev fallback when DATABASE_URL is not configured.
const devConfigStore = new Map<
  string,
  { id: number; value: string; description: string | null; updatedAt: Date }
>();
let devConfigSeq = 1;

const devMonitorStore: MonitorTarget[] = [];
let devMonitorSeq = 1;

type DevRawCommentRow = {
  id: number;
  replyId: string;
  tweetId: string;
  authorId: string;
  authorName: string;
  authorHandle: string;
  text: string;
  createdAt: Date;
  likeCount: number;
  replyTo: string | null;
  fetchedAt: Date;
};

type DevAnalyzedRow = {
  id: number;
  replyId: string;
  sentiment: "positive" | "neutral" | "negative" | "anger" | "sarcasm";
  valueScore: string;
  valueType: string[];
  summary: string;
  analyzedAt: Date;
};

const devRawCommentStore: DevRawCommentRow[] = [];
let devRawCommentSeq = 1;

const devAnalyzedStore = new Map<string, DevAnalyzedRow>();
let devAnalyzedSeq = 1;

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
function normalizeCorruptedMediaTags(text: string): string {
  if (!text) return text;
  return text
    .replace(/\[鍥剧墖\]/g, "[图片]")
    .replace(/\[瑙嗛\]/g, "[视频]")
    .replace(/\[閾炬帴\]/g, "[链接]");
}

export async function insertRawComment(comment: InsertRawComment): Promise<void> {
  const normalizedComment: InsertRawComment = {
    ...comment,
    text: normalizeCorruptedMediaTags(comment.text),
  };
  const db = await getDb();
  if (!db) {
    if (process.env.NODE_ENV === "development") {
      const existing = devRawCommentStore.find((c) => c.replyId === normalizedComment.replyId);
      if (existing) {
        existing.text = normalizedComment.text;
        existing.likeCount = normalizedComment.likeCount ?? existing.likeCount;
        existing.fetchedAt = new Date();
        return;
      }

      devRawCommentStore.push({
        id: devRawCommentSeq++,
        replyId: normalizedComment.replyId,
        tweetId: normalizedComment.tweetId,
        authorId: normalizedComment.authorId,
        authorName: normalizedComment.authorName,
        authorHandle: normalizedComment.authorHandle,
        text: normalizedComment.text,
        createdAt: normalizedComment.createdAt,
        likeCount: normalizedComment.likeCount ?? 0,
        replyTo: normalizedComment.replyTo ?? null,
        fetchedAt: new Date(),
      });
      return;
    }
    throw new Error("Database not available");
  }
  
  await db.insert(rawComments).values(normalizedComment).onDuplicateKeyUpdate({
    set: {
      text: normalizedComment.text,
      likeCount: normalizedComment.likeCount,
      fetchedAt: new Date(),
    },
  });
}

export async function insertRawComments(comments: InsertRawComment[]): Promise<void> {
  const db = await getDb();
  if (!db) {
    if (process.env.NODE_ENV !== "development") throw new Error("Database not available");
    if (comments.length === 0) return;
    for (const comment of comments) {
      await insertRawComment(comment);
    }
    return;
  }
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

function hasCustomValueScoreRange(minValueScore?: number, maxValueScore?: number): boolean {
  if (minValueScore === undefined && maxValueScore === undefined) return false;
  const min = minValueScore ?? 0;
  const max = maxValueScore ?? 1;
  return min > 0 || max < 1;
}

export async function getCommentsWithAnalysis(filter: CommentFilter) {
  const db = await getDb();
  if (!db) {
    if (process.env.NODE_ENV !== "development") throw new Error("Database not available");

    const rootAuthorByTweetId = new Map<string, string>();
    for (const c of devRawCommentStore) {
      if (c.replyId === c.tweetId) rootAuthorByTweetId.set(c.tweetId, c.authorHandle);
    }

    let rows = devRawCommentStore.map((raw) => {
      const analysis = devAnalyzedStore.get(raw.replyId);
      const parent = raw.replyTo
        ? devRawCommentStore.find((p) => p.replyId === raw.replyTo)
        : undefined;

      return {
        id: raw.id,
        replyId: raw.replyId,
        tweetId: raw.tweetId,
        authorId: raw.authorId,
        authorName: raw.authorName,
        authorHandle: raw.authorHandle,
        text: normalizeCorruptedMediaTags(raw.text),
        createdAt: raw.createdAt,
        likeCount: raw.likeCount,
        replyTo: raw.replyTo,
        replyToText: parent?.text ? normalizeCorruptedMediaTags(parent.text) : null,
        sentiment: analysis?.sentiment ?? null,
        valueScore: analysis?.valueScore ?? null,
        valueType: analysis?.valueType ?? null,
        summary: analysis?.summary ?? null,
        analyzedAt: analysis?.analyzedAt ?? null,
      };
    });

    // Treat only real replies as comments; root tweets are used for context/filtering.
    rows = rows.filter((r) => r.replyId !== r.tweetId);

    if (filter.tweetId) rows = rows.filter((r) => r.tweetId === filter.tweetId);
    if (filter.authorHandles && filter.authorHandles.length > 0) {
      const set = new Set(filter.authorHandles);
      rows = rows.filter((r) => set.has(r.authorHandle));
    }
    if (filter.rootTweetAuthor) {
      rows = rows.filter((r) => rootAuthorByTweetId.get(r.tweetId) === filter.rootTweetAuthor);
    }
    if (filter.startTime) rows = rows.filter((r) => r.createdAt >= filter.startTime!);
    if (filter.endTime) rows = rows.filter((r) => r.createdAt <= filter.endTime!);

    if (filter.analyzed === true) rows = rows.filter((r) => r.sentiment !== null);
    if (filter.analyzed === false) rows = rows.filter((r) => r.sentiment === null);

    const applyValueScoreFilter = hasCustomValueScoreRange(filter.minValueScore, filter.maxValueScore);
    if (filter.analyzed !== false) {
      if (filter.sentiments && filter.sentiments.length > 0) {
        const s = new Set(filter.sentiments);
        rows = rows.filter((r) => r.sentiment && s.has(r.sentiment));
      }
      if (applyValueScoreFilter && filter.minValueScore !== undefined) {
        rows = rows.filter((r) => Number(r.valueScore ?? -1) >= filter.minValueScore!);
      }
      if (applyValueScoreFilter && filter.maxValueScore !== undefined) {
        rows = rows.filter((r) => Number(r.valueScore ?? 2) <= filter.maxValueScore!);
      }
    }

    const sortBy = filter.sortBy || "time_desc";
    rows.sort((a, b) => {
      if (sortBy === "time_asc") return a.createdAt.getTime() - b.createdAt.getTime();
      if (sortBy === "value_desc") return Number(b.valueScore ?? -1) - Number(a.valueScore ?? -1);
      if (sortBy === "likes_desc") return (b.likeCount ?? 0) - (a.likeCount ?? 0);
      return b.createdAt.getTime() - a.createdAt.getTime();
    });

    const offset = filter.offset || 0;
    const limit = filter.limit || 50;
    return rows.slice(offset, offset + limit);
  }

  const conditions = [];
  const parentTweet = alias(rawComments, "parentTweet");
  conditions.push(sql`${rawComments.replyId} <> ${rawComments.tweetId}`);
  
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

  const applyValueScoreFilter = hasCustomValueScoreRange(filter.minValueScore, filter.maxValueScore);
  // Only apply sentiment and score filters if we are NOT explicitly looking for unanalyzed comments
  if (filter.analyzed !== false) {
    if (filter.sentiments && filter.sentiments.length > 0) {
      conditions.push(inArray(analyzedComments.sentiment, filter.sentiments as any));
    }
    if (applyValueScoreFilter && filter.minValueScore !== undefined) {
      conditions.push(gte(analyzedComments.valueScore, String(filter.minValueScore)));
    }
    if (applyValueScoreFilter && filter.maxValueScore !== undefined) {
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

  const rows = await query;
  return rows.map((row: any) => ({
    ...row,
    text: normalizeCorruptedMediaTags(String(row.text ?? "")),
    replyToText: row.replyToText == null ? null : normalizeCorruptedMediaTags(String(row.replyToText)),
  }));
}

export async function getCommentStats(tweetId?: string, rootTweetAuthor?: string) {
  const db = await getDb();
  if (!db) {
    if (process.env.NODE_ENV !== "development") throw new Error("Database not available");

    const rootAuthorByTweetId = new Map<string, string>();
    for (const c of devRawCommentStore) {
      if (c.replyId === c.tweetId) rootAuthorByTweetId.set(c.tweetId, c.authorHandle);
    }

    let rows = devRawCommentStore;
    rows = rows.filter((r) => r.replyId !== r.tweetId);
    if (tweetId) rows = rows.filter((r) => r.tweetId === tweetId);
    if (rootTweetAuthor) {
      rows = rows.filter((r) => rootAuthorByTweetId.get(r.tweetId) === rootTweetAuthor);
    }

    return rows.map((r) => {
      const analysis = devAnalyzedStore.get(r.replyId);
      return {
        sentiment: analysis?.sentiment ?? null,
        valueScore: analysis?.valueScore ?? null,
        createdAt: r.createdAt,
      };
    });
  }

  const rootTweet = alias(rawComments, "rootTweet");
  const conditions = [];
  conditions.push(sql`${rawComments.replyId} <> ${rawComments.tweetId}`);
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
  if (!db) {
    if (process.env.NODE_ENV !== "development") throw new Error("Database not available");
    return devRawCommentStore
      .filter((r) => !devAnalyzedStore.has(r.replyId))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, limit);
  }

  return await db
    .select()
    .from(rawComments)
    .where(sql`${rawComments.replyId} NOT IN (SELECT replyId FROM analyzed_comments)`)
    .limit(limit);
}

export async function getTopCommenters(tweetId?: string, limit: number = 10) {
  const db = await getDb();
  if (!db) {
    if (process.env.NODE_ENV !== "development") throw new Error("Database not available");

    const counts = new Map<string, { authorHandle: string; authorName: string; count: number }>();
    for (const r of devRawCommentStore) {
      if (r.replyId === r.tweetId) continue;
      if (tweetId && r.tweetId !== tweetId) continue;
      const current = counts.get(r.authorHandle);
      if (current) {
        current.count += 1;
      } else {
        counts.set(r.authorHandle, {
          authorHandle: r.authorHandle,
          authorName: r.authorName,
          count: 1,
        });
      }
    }

    return Array.from(counts.values())
      .sort((a, b) => b.count - a.count)
      .slice(0, limit);
  }

  const conditions = tweetId
    ? [eq(rawComments.tweetId, tweetId), sql`${rawComments.replyId} <> ${rawComments.tweetId}`]
    : [sql`${rawComments.replyId} <> ${rawComments.tweetId}`];

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
  if (!db) {
    if (process.env.NODE_ENV !== "development") throw new Error("Database not available");
    const existing = devAnalyzedStore.get(analysis.replyId);
    const row: DevAnalyzedRow = {
      id: existing?.id ?? devAnalyzedSeq++,
      replyId: analysis.replyId,
      sentiment: analysis.sentiment,
      valueScore: String(analysis.valueScore),
      valueType: Array.isArray(analysis.valueType) ? analysis.valueType : [],
      summary: analysis.summary,
      analyzedAt: new Date(),
    };
    devAnalyzedStore.set(analysis.replyId, row);
    return;
  }
  
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
  if (!db) {
    if (process.env.NODE_ENV === "development") {
      return devMonitorStore.filter((m) => m.isActive === 1);
    }
    throw new Error("Database not available");
  }

  return await db.select().from(monitorTargets).where(eq(monitorTargets.isActive, 1));
}

export async function insertMonitorTarget(target: InsertMonitorTarget): Promise<void> {
  const db = await getDb();
  if (!db) {
    if (process.env.NODE_ENV === "development") {
      const now = new Date();
      devMonitorStore.push({
        id: devMonitorSeq++,
        type: target.type,
        targetId: target.targetId,
        targetName: target.targetName ?? null,
        targetHandle: target.targetHandle ?? null,
        isActive: target.isActive ?? 1,
        lastFetchedAt: null,
        createdAt: now,
        updatedAt: now,
      });
      return;
    }
    throw new Error("Database not available");
  }

  await db.insert(monitorTargets).values(target);
}

export async function updateMonitorTarget(id: number, updates: Partial<InsertMonitorTarget>): Promise<void> {
  const db = await getDb();
  if (!db) {
    if (process.env.NODE_ENV === "development") {
      const idx = devMonitorStore.findIndex((m) => m.id === id);
      if (idx < 0) return;
      devMonitorStore[idx] = {
        ...devMonitorStore[idx],
        ...updates,
        updatedAt: new Date(),
      };
      return;
    }
    throw new Error("Database not available");
  }

  await db.update(monitorTargets).set(updates).where(eq(monitorTargets.id, id));
}

export async function deleteMonitorTarget(id: number): Promise<void> {
  const db = await getDb();
  if (!db) {
    if (process.env.NODE_ENV === "development") {
      const idx = devMonitorStore.findIndex((m) => m.id === id);
      if (idx >= 0) devMonitorStore.splice(idx, 1);
      return;
    }
    throw new Error("Database not available");
  }

  await db.delete(monitorTargets).where(eq(monitorTargets.id, id));
}

// ============ System Config Functions ============
export async function getConfig(key: string): Promise<string | null> {
  const db = await getDb();
  if (!db) {
    if (process.env.NODE_ENV === "development") {
      return devConfigStore.get(key)?.value ?? null;
    }
    throw new Error("Database not available");
  }

  const result = await db.select().from(systemConfig).where(eq(systemConfig.configKey, key)).limit(1);
  return result.length > 0 ? result[0].configValue : null;
}

export async function setConfig(key: string, value: string, description?: string): Promise<void> {
  const db = await getDb();
  if (!db) {
    if (process.env.NODE_ENV === "development") {
      const current = devConfigStore.get(key);
      devConfigStore.set(key, {
        id: current?.id ?? devConfigSeq++,
        value,
        description: description ?? current?.description ?? null,
        updatedAt: new Date(),
      });
      return;
    }
    throw new Error("Database not available");
  }

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
  if (!db) {
    if (process.env.NODE_ENV === "development") {
      return Array.from(devConfigStore.entries()).map(([configKey, cfg]) => ({
        id: cfg.id,
        configKey,
        configValue: cfg.value,
        description: cfg.description,
        updatedAt: cfg.updatedAt,
      }));
    }
    throw new Error("Database not available");
  }

  return await db.select().from(systemConfig);
}

export async function deleteConfig(key: string): Promise<void> {
  const db = await getDb();
  if (!db) {
    if (process.env.NODE_ENV === "development") {
      devConfigStore.delete(key);
      return;
    }
    throw new Error("Database not available");
  }

  await db.delete(systemConfig).where(eq(systemConfig.configKey, key));
}

// ============ Export Functions ============
export async function getAllCommentsForExport(filter?: CommentFilter) {
  const db = await getDb();
  if (!db) {
    if (process.env.NODE_ENV !== "development") throw new Error("Database not available");
    const list = await getCommentsWithAnalysis({
      tweetId: filter?.tweetId,
      rootTweetAuthor: filter?.rootTweetAuthor,
      startTime: filter?.startTime,
      endTime: filter?.endTime,
      sentiments: filter?.sentiments,
      minValueScore: filter?.minValueScore,
      maxValueScore: filter?.maxValueScore,
      analyzed: filter?.analyzed,
      sortBy: "time_desc",
      limit: Number.MAX_SAFE_INTEGER,
      offset: 0,
    });

    return list.map((r: any) => ({
      replyId: r.replyId,
      tweetId: r.tweetId,
      authorId: r.authorId,
      authorName: r.authorName,
      authorHandle: r.authorHandle,
      text: normalizeCorruptedMediaTags(String(r.text ?? "")),
      createdAt: r.createdAt,
      likeCount: r.likeCount,
      replyTo: r.replyTo,
      sentiment: r.sentiment,
      valueScore: r.valueScore,
      valueType: r.valueType,
      summary: r.summary,
      analyzedAt: r.analyzedAt,
    }));
  }

  const conditions = [];
  const rootTweet = alias(rawComments, "rootTweet");
  conditions.push(sql`${rawComments.replyId} <> ${rawComments.tweetId}`);

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

  const applyValueScoreFilter = hasCustomValueScoreRange(filter?.minValueScore, filter?.maxValueScore);
  if (filter?.analyzed !== false) {
    if (filter?.sentiments && filter.sentiments.length > 0) {
      conditions.push(inArray(analyzedComments.sentiment, filter.sentiments as any));
    }
    if (applyValueScoreFilter && filter?.minValueScore !== undefined) {
      conditions.push(gte(analyzedComments.valueScore, String(filter.minValueScore)));
    }
    if (applyValueScoreFilter && filter?.maxValueScore !== undefined) {
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
