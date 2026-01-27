import { describe, expect, it, vi, beforeEach } from "vitest";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";

// Mock the database functions
vi.mock("./db", () => ({
  getCommentsWithAnalysis: vi.fn().mockResolvedValue([
    {
      replyId: "reply-1",
      tweetId: "tweet-1",
      authorId: "author-1",
      authorName: "Test User",
      authorHandle: "testuser",
      text: "This is a test comment",
      createdAt: new Date("2024-01-01T12:00:00Z"),
      likeCount: 10,
      sentiment: "positive",
      valueScore: "0.85",
      summary: "测试摘要",
    },
  ]),
  getCommentStats: vi.fn().mockResolvedValue([
    { sentiment: "positive", valueScore: "0.85", createdAt: new Date() },
    { sentiment: "neutral", valueScore: "0.50", createdAt: new Date() },
  ]),
  getTopCommenters: vi.fn().mockResolvedValue([
    { authorHandle: "testuser", count: 5 },
  ]),
  getUnanalyzedComments: vi.fn().mockResolvedValue([]),
  insertRawComment: vi.fn().mockResolvedValue(undefined),
  insertRawComments: vi.fn().mockResolvedValue(undefined),
  insertAnalyzedComment: vi.fn().mockResolvedValue(undefined),
  getActiveMonitorTargets: vi.fn().mockResolvedValue([]),
  insertMonitorTarget: vi.fn().mockResolvedValue(undefined),
  updateMonitorTarget: vi.fn().mockResolvedValue(undefined),
  deleteMonitorTarget: vi.fn().mockResolvedValue(undefined),
  getConfig: vi.fn().mockResolvedValue(null),
  setConfig: vi.fn().mockResolvedValue(undefined),
  getAllConfigs: vi.fn().mockResolvedValue([]),
}));

function createPublicContext(): TrpcContext {
  return {
    user: null,
    req: {
      protocol: "https",
      headers: {},
    } as TrpcContext["req"],
    res: {
      clearCookie: vi.fn(),
    } as unknown as TrpcContext["res"],
  };
}

function createAuthContext(): TrpcContext {
  return {
    user: {
      id: 1,
      openId: "test-user",
      email: "test@example.com",
      name: "Test User",
      loginMethod: "manus",
      role: "user",
      createdAt: new Date(),
      updatedAt: new Date(),
      lastSignedIn: new Date(),
    },
    req: {
      protocol: "https",
      headers: {},
    } as TrpcContext["req"],
    res: {
      clearCookie: vi.fn(),
    } as unknown as TrpcContext["res"],
  };
}

describe("comments.list", () => {
  it("returns comments with analysis data", async () => {
    const ctx = createPublicContext();
    const caller = appRouter.createCaller(ctx);

    const result = await caller.comments.list({});

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      replyId: "reply-1",
      authorName: "Test User",
      sentiment: "positive",
      valueScore: "0.85",
    });
  });

  it("accepts filter parameters", async () => {
    const ctx = createPublicContext();
    const caller = appRouter.createCaller(ctx);

    const result = await caller.comments.list({
      tweetId: "tweet-1",
      sentiments: ["positive", "neutral"],
      minValueScore: 0.5,
      maxValueScore: 1.0,
      sortBy: "time_desc",
      limit: 50,
    });

    expect(result).toBeDefined();
  });
});

describe("comments.stats", () => {
  it("returns comment statistics", async () => {
    const ctx = createPublicContext();
    const caller = appRouter.createCaller(ctx);

    const result = await caller.comments.stats({});

    expect(result).toMatchObject({
      totalComments: 2,
      sentimentCounts: expect.any(Object),
      valueDistribution: expect.any(Array),
    });
  });
});

describe("comments.topCommenters", () => {
  it("returns top commenters list", async () => {
    const ctx = createPublicContext();
    const caller = appRouter.createCaller(ctx);

    const result = await caller.comments.topCommenters({ limit: 10 });

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      authorHandle: "testuser",
      count: 5,
    });
  });
});

describe("comments.add", () => {
  it("requires authentication", async () => {
    const ctx = createPublicContext();
    const caller = appRouter.createCaller(ctx);

    await expect(
      caller.comments.add({
        replyId: "new-reply",
        tweetId: "tweet-1",
        authorId: "author-1",
        authorName: "New User",
        authorHandle: "newuser",
        text: "New comment",
        createdAt: new Date(),
        likeCount: 0,
      })
    ).rejects.toThrow();
  });

  it("allows authenticated users to add comments", async () => {
    const ctx = createAuthContext();
    const caller = appRouter.createCaller(ctx);

    const result = await caller.comments.add({
      replyId: "new-reply",
      tweetId: "tweet-1",
      authorId: "author-1",
      authorName: "New User",
      authorHandle: "newuser",
      text: "New comment",
      createdAt: new Date(),
      likeCount: 0,
    });

    expect(result).toEqual({ success: true });
  });
});

describe("monitors.list", () => {
  it("returns active monitor targets", async () => {
    const ctx = createPublicContext();
    const caller = appRouter.createCaller(ctx);

    const result = await caller.monitors.list();

    expect(Array.isArray(result)).toBe(true);
  });
});

describe("config.list", () => {
  it("requires authentication", async () => {
    const ctx = createPublicContext();
    const caller = appRouter.createCaller(ctx);

    await expect(caller.config.list()).rejects.toThrow();
  });

  it("returns configs for authenticated users", async () => {
    const ctx = createAuthContext();
    const caller = appRouter.createCaller(ctx);

    const result = await caller.config.list();

    expect(Array.isArray(result)).toBe(true);
  });
});
