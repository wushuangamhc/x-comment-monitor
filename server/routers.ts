import { COOKIE_NAME } from "@shared/const";
import { getSessionCookieOptions } from "./_core/cookies";
import { systemRouter } from "./_core/systemRouter";
import { publicProcedure, protectedProcedure, router } from "./_core/trpc";
import { z } from "zod";
import { invokeLLM } from "./_core/llm";
import { callDataApi } from "./_core/dataApi";
import { 
  getCommentsWithAnalysis, 
  getCommentStats, 
  getUnanalyzedComments,
  getTopCommenters,
  insertRawComment,
  insertRawComments,
  insertAnalyzedComment,
  getActiveMonitorTargets,
  insertMonitorTarget,
  updateMonitorTarget,
  deleteMonitorTarget,
  getConfig,
  setConfig,
  getAllConfigs,
  getAllCommentsForExport,
  deleteConfig,
} from "./db";
import { 
  scrapeUserComments as playwrightScrapeUserComments,
  scrapeRepliesByTweetId,
  getScrapeConfig,
  setScrapeConfig,
  applyScrapePreset,
  SCRAPE_PRESETS,
  setAccountCookies,
  addAccountCookie,
  removeAccountCookie,
  getAccountCount,
  closeBrowser,
  type ScrapeConfig,
  type ScrapeProgress,
  type ReplySortMode,
} from "./twitterScraper";
import { clearScrapeProgress, getScrapeProgress, setScrapeProgress } from "./scrapeProgressStore";
import { getPlaywrightStatus } from "./ensurePlaywright";

// Sentiment types
const sentimentEnum = z.enum(["positive", "neutral", "negative", "anger", "sarcasm"]);

// Comment filter schema
const commentFilterSchema = z.object({
  tweetId: z.string().optional(),
  authorHandles: z.array(z.string()).optional(),
  rootTweetAuthor: z.string().optional(),
  startTime: z.date().optional(),
  endTime: z.date().optional(),
  sentiments: z.array(sentimentEnum).optional(),
  minValueScore: z.number().min(0).max(1).optional(),
  maxValueScore: z.number().min(0).max(1).optional(),
  sortBy: z.enum(['time_desc', 'time_asc', 'value_desc', 'likes_desc']).optional(),
  limit: z.number().min(1).max(100).optional(),
  offset: z.number().min(0).optional(),
  analyzed: z.boolean().optional(),
});

// Raw comment schema for insertion
const rawCommentSchema = z.object({
  replyId: z.string(),
  tweetId: z.string(),
  authorId: z.string(),
  authorName: z.string(),
  authorHandle: z.string(),
  text: z.string(),
  createdAt: z.date(),
  likeCount: z.number().default(0),
  replyTo: z.string().optional(),
});

// Monitor target schema
const monitorTargetSchema = z.object({
  type: z.enum(["account", "tweet"]),
  targetId: z.string(),
  targetName: z.string().optional(),
  targetHandle: z.string().optional(),
});

const replySortModeEnum = z.enum(["recent", "top"]);

function normalizeErrorMessage(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return String(error);
}

function isBrowserLaunchFailure(error: unknown): boolean {
  const message = normalizeErrorMessage(error);
  return /Browser launch failed|Failed to launch the browser process|libnss3\.so|Browser initialization timed out/i.test(
    message,
  );
}

function toApifySort(sortMode: ReplySortMode): "Latest" | "Top" {
  return sortMode === "top" ? "Top" : "Latest";
}

async function scrapeTweetRepliesViaApify(params: {
  tweetId: string;
  apifyToken: string;
  maxReplies: number;
  progressKey: string;
  sortMode?: ReplySortMode;
}): Promise<{
  success: boolean;
  method: "apify";
  error?: string;
  commentsCount: number;
  message?: string;
}> {
  const { tweetId, apifyToken, maxReplies, progressKey, sortMode = "recent" } = params;
  const apifySort = toApifySort(sortMode);

  const setApifyProgress = (stage: ScrapeProgress["stage"], message: string, repliesFound = 0) => {
    setScrapeProgress(progressKey, {
      stage,
      message,
      tweetsFound: 1,
      repliesFound,
      currentTweet: 1,
      totalTweets: 1,
      currentAccount: 0,
      totalAccounts: 1,
    });
  };

  const saveRootTweet = async (tweet: {
    id: string;
    text: string;
    authorName: string;
    authorHandle: string;
    createdAt: string;
    likeCount: number;
  }) => {
    try {
      await insertRawComment({
        replyId: tweet.id,
        tweetId: tweet.id,
        authorId: "unknown",
        authorName: tweet.authorName,
        authorHandle: tweet.authorHandle,
        text: tweet.text,
        createdAt: new Date(tweet.createdAt),
        likeCount: tweet.likeCount,
        replyTo: undefined,
      });
    } catch (_) {
      // Ignore duplicate errors.
    }
  };

  const saveReply = async (reply: {
    id: string;
    text: string;
    authorId: string;
    authorName: string;
    authorHandle: string;
    createdAt: string;
    likeCount: number;
    replyTo: string;
  }) => {
    try {
      await insertRawComment({
        replyId: reply.id,
        tweetId: reply.replyTo,
        authorId: reply.authorId,
        authorName: reply.authorName,
        authorHandle: reply.authorHandle,
        text: reply.text,
        createdAt: new Date(reply.createdAt),
        likeCount: reply.likeCount,
        replyTo: reply.replyTo,
      });
    } catch (_) {
      // Ignore duplicate errors.
    }
  };

  try {
    setApifyProgress("loading", `Puppeteer unavailable, falling back to Apify for tweet ${tweetId}...`, 0);

    const runResponse = await fetch(
      `https://api.apify.com/v2/acts/apidojo~twitter-scraper-lite/runs?token=${apifyToken}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          searchTerms: [`conversation_id:${tweetId}`],
          sort: apifySort,
          maxItems: maxReplies + 1,
        }),
      },
    );

    if (!runResponse.ok) {
      const errorText = await runResponse.text();
      return {
        success: false,
        method: "apify",
        error: `Failed to start Apify run: ${errorText}`,
        commentsCount: 0,
      };
    }

    const runPayload = await runResponse.json();
    const runId = runPayload.data?.id as string | undefined;
    const datasetId = runPayload.data?.defaultDatasetId as string | undefined;
    if (!runId || !datasetId) {
      return {
        success: false,
        method: "apify",
        error: "Apify run was created but runId/datasetId is missing",
        commentsCount: 0,
      };
    }

    setApifyProgress("loading", "Apify run started, waiting for completion...", 0);

    let runStatus = "RUNNING";
    for (let attempt = 0; attempt < 80 && runStatus === "RUNNING"; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 3000));
      const statusResponse = await fetch(`https://api.apify.com/v2/actor-runs/${runId}?token=${apifyToken}`);
      const statusPayload = await statusResponse.json();
      runStatus = statusPayload.data?.status || "FAILED";
    }

    if (runStatus !== "SUCCEEDED") {
      return {
        success: false,
        method: "apify",
        error: `Apify run did not succeed: ${runStatus}`,
        commentsCount: 0,
      };
    }

    const datasetResponse = await fetch(`https://api.apify.com/v2/datasets/${datasetId}/items?token=${apifyToken}`);
    const items = await datasetResponse.json();
    if (!Array.isArray(items) || items.length === 0) {
      return {
        success: false,
        method: "apify",
        error: "No tweet/reply items returned by Apify for this tweet ID",
        commentsCount: 0,
      };
    }

    const toStringSafe = (value: unknown, fallback = "") =>
      typeof value === "string" ? value : value == null ? fallback : String(value);

    let savedReplies = 0;
    let rootInserted = false;

    for (const item of items) {
      const itemId = toStringSafe(item?.id).trim();
      if (!itemId) continue;

      const conversationId = toStringSafe(item?.conversationId ?? item?.conversation_id);
      const inReplyTo = toStringSafe(item?.inReplyToStatusId ?? item?.in_reply_to_status_id ?? item?.replyToStatusId);
      const sameConversation = conversationId === tweetId || inReplyTo === tweetId || itemId === tweetId;
      if (!sameConversation) continue;

      const text = toStringSafe(item?.text ?? item?.fullText ?? item?.full_text);
      const authorName = toStringSafe(item?.author?.name ?? item?.userName ?? item?.user?.name, "Unknown");
      const authorHandle = toStringSafe(
        item?.author?.userName ?? item?.author?.screenName ?? item?.userScreenName ?? item?.user?.screen_name,
        "unknown",
      );
      const authorId = toStringSafe(item?.author?.id ?? item?.userId ?? item?.user?.id, "unknown");
      const likeCount = Number(item?.likeCount ?? item?.favoriteCount ?? item?.favorite_count ?? 0);
      const createdAtRaw = item?.createdAt ?? item?.created_at ?? new Date().toISOString();
      const createdAt = new Date(createdAtRaw);
      const createdAtISO = Number.isNaN(createdAt.getTime()) ? new Date().toISOString() : createdAt.toISOString();

      if (itemId === tweetId) {
        await saveRootTweet({
          id: itemId,
          text,
          authorName,
          authorHandle,
          createdAt: createdAtISO,
          likeCount: Number.isFinite(likeCount) ? likeCount : 0,
        });
        rootInserted = true;
        continue;
      }

      await saveReply({
        id: itemId,
        text,
        authorId,
        authorName,
        authorHandle,
        createdAt: createdAtISO,
        likeCount: Number.isFinite(likeCount) ? likeCount : 0,
        replyTo: inReplyTo || tweetId,
      });

      savedReplies++;
      if (savedReplies % 20 === 0) {
        setApifyProgress("fetching_replies", `Fetched ${savedReplies} replies via Apify...`, savedReplies);
      }
    }

    if (!rootInserted) {
      await saveRootTweet({
        id: tweetId,
        text: "",
        authorName: "Unknown",
        authorHandle: "unknown",
        createdAt: new Date().toISOString(),
        likeCount: 0,
      });
    }

    setApifyProgress("complete", `Completed via Apify: ${savedReplies} replies`, savedReplies);
    return {
      success: true,
      method: "apify",
      commentsCount: savedReplies,
      message: `Apify fetched ${savedReplies} replies`,
    };
  } catch (error) {
    return {
      success: false,
      method: "apify",
      error: normalizeErrorMessage(error),
      commentsCount: 0,
    };
  }
}

export const appRouter = router({
  system: systemRouter,
  auth: router({
    me: publicProcedure.query(opts => opts.ctx.user),
    logout: publicProcedure.mutation(({ ctx }) => {
      const cookieOptions = getSessionCookieOptions(ctx.req);
      ctx.res.clearCookie(COOKIE_NAME, { ...cookieOptions, maxAge: -1 });
      return { success: true } as const;
    }),
  }),

  // Comments router
  comments: router({
    list: publicProcedure
      .input(commentFilterSchema)
      .query(async ({ input }) => {
        return await getCommentsWithAnalysis(input);
      }),

    // 导出评论数据（无条数限制，与当前列表筛选条件一致）
    exportData: publicProcedure
      .input(z.object({
        tweetId: z.string().optional(),
        rootTweetAuthor: z.string().optional(),
        startTime: z.date().optional(),
        endTime: z.date().optional(),
        sentiments: z.array(sentimentEnum).optional(),
        minValueScore: z.number().min(0).max(1).optional(),
        maxValueScore: z.number().min(0).max(1).optional(),
        analyzed: z.boolean().optional(),
      }))
      .query(async ({ input }) => {
        return await getAllCommentsForExport(input);
      }),

    stats: publicProcedure
      .input(z.object({
        tweetId: z.string().optional(),
        rootTweetAuthor: z.string().optional(),
      }))
      .query(async ({ input }) => {
        const stats = await getCommentStats(input.tweetId, input.rootTweetAuthor);
        const sentimentCounts: Record<string, number> = {
          positive: 0, neutral: 0, negative: 0, anger: 0, sarcasm: 0,
        };
        const valueDistribution: number[] = Array(10).fill(0);
        const sentimentOverTime: Record<string, Record<string, number>> = {};
        
        stats.forEach(item => {
          if (item.sentiment) sentimentCounts[item.sentiment]++;
          if (item.valueScore) {
            const bucket = Math.min(Math.floor(parseFloat(String(item.valueScore)) * 10), 9);
            valueDistribution[bucket]++;
          }
          if (item.createdAt && item.sentiment) {
            const hour = new Date(item.createdAt).toISOString().slice(0, 13);
            if (!sentimentOverTime[hour]) {
              sentimentOverTime[hour] = { positive: 0, neutral: 0, negative: 0, anger: 0, sarcasm: 0 };
            }
            sentimentOverTime[hour][item.sentiment]++;
          }
        });
        
        return {
          totalComments: stats.length,
          analyzedComments: stats.filter(s => s.sentiment).length,
          sentimentCounts,
          valueDistribution,
          sentimentOverTime: Object.entries(sentimentOverTime)
            .map(([time, counts]) => ({ time, ...counts }))
            .sort((a, b) => a.time.localeCompare(b.time)),
        };
      }),

    topCommenters: publicProcedure
      .input(z.object({ 
        tweetId: z.string().optional(),
        limit: z.number().min(1).max(50).default(10),
      }))
      .query(async ({ input }) => {
        return await getTopCommenters(input.tweetId, input.limit);
      }),

    add: protectedProcedure
      .input(rawCommentSchema)
      .mutation(async ({ input }) => {
        await insertRawComment(input);
        return { success: true };
      }),

    addBatch: protectedProcedure
      .input(z.array(rawCommentSchema))
      .mutation(async ({ input }) => {
        await insertRawComments(input);
        return { success: true, count: input.length };
      }),
  }),

  // AI Analysis router
  analysis: router({
    analyzeComment: protectedProcedure
      .input(z.object({ replyId: z.string(), text: z.string() }))
      .mutation(async ({ input }) => {
        const prompt = `分析以下 X/Twitter 评论，返回 JSON 格式的分析结果：

评论内容：
"${input.text}"

请分析并返回以下字段：
1. sentiment: 情绪类型，必须是以下之一：positive（支持、认可）、neutral（陈述、围观）、negative（不满、批评）、anger（愤怒、攻击）、sarcasm（讽刺、阴阳）
2. valueScore: 评论价值评分（0-1），参考因素：是否有信息增量、是否代表一类人观点、是否可能影响舆论走向、是否容易被引用或传播
3. valueType: 价值类型数组，可能包含：informative（有信息量）、representative（代表性观点）、influential（有影响力）、viral（易传播）
4. summary: 一句话摘要（中文，20字以内）

只返回 JSON，不要其他内容。`;

        const response = await invokeLLM({
          messages: [
            { role: "system", content: "你是一个专业的社交媒体舆情分析师，擅长分析评论的情绪和价值。" },
            { role: "user", content: prompt },
          ],
          response_format: {
            type: "json_schema",
            json_schema: {
              name: "comment_analysis",
              strict: true,
              schema: {
                type: "object",
                properties: {
                  sentiment: { type: "string", enum: ["positive", "neutral", "negative", "anger", "sarcasm"], description: "情绪类型" },
                  valueScore: { type: "number", description: "价值评分 0-1" },
                  valueType: { type: "array", items: { type: "string" }, description: "价值类型" },
                  summary: { type: "string", description: "一句话摘要" },
                },
                required: ["sentiment", "valueScore", "valueType", "summary"],
                additionalProperties: false,
              },
            },
          },
        });

        const content = response.choices[0]?.message?.content as string | undefined;
        if (content) {
          const analysis = JSON.parse(content);
          await insertAnalyzedComment({
            replyId: input.replyId,
            sentiment: analysis.sentiment,
            valueScore: String(analysis.valueScore),
            valueType: analysis.valueType,
            summary: analysis.summary,
          });
          return { success: true, analysis };
        }

        return { success: false, error: "No analysis result" };
      }),

    analyzeUnanalyzed: protectedProcedure
      .input(z.object({ limit: z.number().min(1).max(50).default(10) }))
      .mutation(async ({ input }) => {
        const unanalyzed = await getUnanalyzedComments(input.limit);
        let analyzed = 0;

        for (const comment of unanalyzed) {
          try {
            const prompt = `分析以下 X/Twitter 评论，返回 JSON 格式的分析结果：

评论内容：
"${comment.text}"

请分析并返回以下字段：
1. sentiment: 情绪类型，必须是以下之一：positive（支持、认可）、neutral（陈述、围观）、negative（不满、批评）、anger（愤怒、攻击）、sarcasm（讽刺、阴阳）
2. valueScore: 评论价值评分（0-1），参考因素：是否有信息增量、是否代表一类人观点、是否可能影响舆论走向、是否容易被引用或传播
3. valueType: 价值类型数组，可能包含：informative（有信息量）、representative（代表性观点）、influential（有影响力）、viral（易传播）
4. summary: 一句话摘要（中文，20字以内）

只返回 JSON，不要其他内容。`;

            const response = await invokeLLM({
              messages: [
                { role: "system", content: "你是一个专业的社交媒体舆情分析师，擅长分析评论的情绪和价值。" },
                { role: "user", content: prompt },
              ],
              response_format: {
                type: "json_schema",
                json_schema: {
                  name: "comment_analysis",
                  strict: true,
                  schema: {
                    type: "object",
                    properties: {
                      sentiment: { type: "string", enum: ["positive", "neutral", "negative", "anger", "sarcasm"], description: "情绪类型" },
                      valueScore: { type: "number", description: "价值评分 0-1" },
                      valueType: { type: "array", items: { type: "string" }, description: "价值类型" },
                      summary: { type: "string", description: "一句话摘要" },
                    },
                    required: ["sentiment", "valueScore", "valueType", "summary"],
                    additionalProperties: false,
                  },
                },
              },
            });

            const content = response.choices[0]?.message?.content as string | undefined;
            if (content) {
              const analysis = JSON.parse(content);
              await insertAnalyzedComment({
                replyId: comment.replyId,
                sentiment: analysis.sentiment,
                valueScore: String(analysis.valueScore),
                valueType: analysis.valueType,
                summary: analysis.summary,
              });
              analyzed++;
            }
          } catch (error) {
            console.error(`Failed to analyze comment ${comment.replyId}:`, error);
          }
        }

        return { analyzed };
      }),

    // Generate opinion clusters
    generateClusters: protectedProcedure
      .input(z.object({
        tweetId: z.string().optional(),
        limit: z.number().min(5).max(100).default(50),
      }))
      .mutation(async ({ input }) => {
        const comments = await getCommentsWithAnalysis({
          tweetId: input.tweetId,
          limit: input.limit,
          sortBy: 'value_desc',
        });

        if (comments.length < 3) {
          return { clusters: [] };
        }

        try {
          const commentTexts = comments.map((c, i) => `[${i}] @${c.authorHandle}: ${c.text}`).join('\n');
          
          const response = await invokeLLM({
            messages: [
              { role: "system", content: "你是一个专业的舆情分析师，擅长将评论归类为不同的观点群组。" },
              { role: "user", content: `将以下评论归类为 3-5 个观点群组，每个群组需要：
1. label: 群组标签（中文，5字以内）
2. summary: 群组摘要（中文，30字以内）
3. sentiment: 主要情绪（positive/neutral/negative/anger/sarcasm）
4. count: 该群组的评论数量
5. representativeIndex: 最具代表性的评论索引号

评论列表：
${commentTexts}

返回 JSON 格式：{ "clusters": [...] }` },
            ],
            response_format: {
              type: "json_schema",
              json_schema: {
                name: "opinion_clusters",
                strict: true,
                schema: {
                  type: "object",
                  properties: {
                    clusters: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          label: { type: "string" },
                          summary: { type: "string" },
                          sentiment: { type: "string" },
                          count: { type: "integer" },
                          representativeIndex: { type: "integer" },
                        },
                        required: ["label", "summary", "sentiment", "count", "representativeIndex"],
                        additionalProperties: false,
                      },
                    },
                  },
                  required: ["clusters"],
                  additionalProperties: false,
                },
              },
            },
          });

          const content = response.choices[0]?.message?.content as string | undefined;
          if (content) {
            const result = JSON.parse(content);
            result.clusters = result.clusters.map((cluster: any) => ({
              ...cluster,
              representativeComment: comments[cluster.representativeIndex] || null,
            }));
            return result;
          }
        } catch (error) {
          console.error("Failed to generate opinion clusters:", error);
        }

        return { clusters: [] };
      }),
  }),

  // Monitor targets router
  monitors: router({
    list: publicProcedure.query(async () => {
      return await getActiveMonitorTargets();
    }),

    add: protectedProcedure
      .input(monitorTargetSchema)
      .mutation(async ({ input }) => {
        await insertMonitorTarget(input);
        return { success: true };
      }),

    update: protectedProcedure
      .input(z.object({
        id: z.number(),
        isActive: z.number().optional(),
        targetName: z.string().optional(),
      }))
      .mutation(async ({ input }) => {
        const { id, ...updates } = input;
        await updateMonitorTarget(id, updates);
        return { success: true };
      }),

    delete: protectedProcedure
      .input(z.object({ id: z.number() }))
      .mutation(async ({ input }) => {
        await deleteMonitorTarget(input.id);
        return { success: true };
      }),
  }),

  // Config router
  config: router({
    get: protectedProcedure
      .input(z.object({ key: z.string() }))
      .query(async ({ input }) => {
        return await getConfig(input.key);
      }),

    set: protectedProcedure
      .input(z.object({
        key: z.string(),
        value: z.string(),
        description: z.string().optional(),
      }))
      .mutation(async ({ input }) => {
        await setConfig(input.key, input.value, input.description);
        if (input.key === 'PLAYWRIGHT_PROXY') {
          await closeBrowser();
        }
        return { success: true };
      }),

    list: protectedProcedure.query(async () => {
      return await getAllConfigs();
    }),

    // 删除配置
    delete: protectedProcedure
      .input(z.object({ key: z.string() }))
      .mutation(async ({ input }) => {
        await deleteConfig(input.key);
        return { success: true };
      }),

    // Puppeteer 运行状态查询（保留旧路由名兼容）
    getPlaywrightStatus: protectedProcedure.query(() => {
      return getPlaywrightStatus();
    }),

    // 爬取频率配置
    getScrapeConfig: protectedProcedure.query(() => {
      return getScrapeConfig();
    }),

    setScrapeConfig: protectedProcedure
      .input(z.object({
        pageLoadDelay: z.number().min(1000).max(10000).optional(),
        scrollDelay: z.number().min(1000).max(10000).optional(),
        betweenTweetsDelay: z.number().min(2000).max(30000).optional(),
        randomDelay: z.boolean().optional(),
        randomDelayMin: z.number().min(500).max(10000).optional(),
        randomDelayMax: z.number().min(1000).max(15000).optional(),
      }))
      .mutation(({ input }) => {
        const config: Partial<ScrapeConfig> = {};
        if (input.pageLoadDelay !== undefined) config.pageLoadDelay = input.pageLoadDelay;
        if (input.scrollDelay !== undefined) config.scrollDelay = input.scrollDelay;
        if (input.betweenTweetsDelay !== undefined) config.betweenTweetsDelay = input.betweenTweetsDelay;
        if (input.randomDelay !== undefined) config.randomDelay = input.randomDelay;
        if (input.randomDelayMin !== undefined && input.randomDelayMax !== undefined) {
          config.randomDelayRange = [input.randomDelayMin, input.randomDelayMax];
        }
        setScrapeConfig(config);
        return { success: true, config: getScrapeConfig() };
      }),

    applyScrapePreset: protectedProcedure
      .input(z.object({
        preset: z.enum(['ultraSlow', 'slow', 'normal', 'fast']),
      }))
      .mutation(({ input }) => {
        applyScrapePreset(input.preset);
        return { success: true, config: getScrapeConfig() };
      }),

    getScrapePresets: publicProcedure.query(() => {
      return {
        presets: Object.keys(SCRAPE_PRESETS),
        descriptions: {
          ultraSlow: '极慢模式 - 最安全，推文间延迟 10+ 秒',
          slow: '慢速模式 - 安全，推文间延迟 5+ 秒（默认）',
          normal: '正常模式 - 有一定风险，推文间延迟 3+ 秒',
          fast: '快速模式 - 高风险，推文间延迟 2+ 秒',
        },
      };
    }),
  }),

  // Twitter data collection router
  twitter: router({
    getScrapeProgress: protectedProcedure
      .input(z.object({ username: z.string() }))
      .query(({ input }) => {
        return { progress: getScrapeProgress(input.username) };
      }),

    getUserProfile: protectedProcedure
      .input(z.object({ username: z.string() }))
      .query(async ({ input }) => {
        try {
          const result = await callDataApi("Twitter/get_user_profile_by_username", {
            query: { username: input.username },
          }) as any;
          
          if (result?.result?.data?.user?.result) {
            const userData = result.result.data.user.result;
            return {
              success: true,
              user: {
                id: userData.rest_id,
                name: userData.core?.name || userData.legacy?.name,
                handle: userData.core?.screen_name || userData.legacy?.screen_name,
                description: userData.legacy?.description,
                followersCount: userData.legacy?.followers_count,
                followingCount: userData.legacy?.friends_count,
                tweetsCount: userData.legacy?.statuses_count,
                profileImageUrl: userData.avatar?.image_url,
                isVerified: userData.is_blue_verified,
              },
            };
          }
          return { success: false, error: "User not found" };
        } catch (error) {
          return { success: false, error: String(error) };
        }
      }),

    getUserTweets: protectedProcedure
      .input(z.object({
        userId: z.string(),
        count: z.number().min(1).max(50).default(20),
        cursor: z.string().optional(),
      }))
      .query(async ({ input }) => {
        try {
          const result = await callDataApi("Twitter/get_user_tweets", {
            query: {
              user: input.userId,
              count: String(input.count),
              ...(input.cursor ? { cursor: input.cursor } : {}),
            },
          }) as any;

          const tweets: any[] = [];
          const instructions = result?.result?.timeline?.instructions || [];
          
          for (const instruction of instructions) {
            if (instruction.type === "TimelineAddEntries" || instruction.type === "TimelinePinEntry") {
              const entries = instruction.entries || (instruction.entry ? [instruction.entry] : []);
              for (const entry of entries) {
                if (entry.entryId?.startsWith("tweet-")) {
                  const tweetResult = entry.content?.itemContent?.tweet_results?.result;
                  if (tweetResult) {
                    const legacy = tweetResult.legacy || {};
                    const userLegacy = tweetResult.core?.user_results?.result?.legacy || {};
                    tweets.push({
                      id: tweetResult.rest_id,
                      text: legacy.full_text,
                      createdAt: legacy.created_at,
                      likeCount: legacy.favorite_count || 0,
                      retweetCount: legacy.retweet_count || 0,
                      replyCount: legacy.reply_count || 0,
                      authorId: tweetResult.core?.user_results?.result?.rest_id,
                      authorName: userLegacy.name,
                      authorHandle: userLegacy.screen_name,
                    });
                  }
                }
              }
            }
          }

          return { success: true, tweets, cursor: result?.cursor };
        } catch (error) {
          return { success: false, error: String(error), tweets: [] };
        }
      }),

    // Fetch user comments using Apify API
    fetchUserComments: protectedProcedure
      .input(z.object({
        username: z.string(),
        maxTweets: z.number().min(1).max(100).default(20),
        maxCommentsPerTweet: z.number().min(1).max(200).default(50),
      }))
      .mutation(async ({ input }) => {
        const apifyToken = await getConfig('APIFY_API_TOKEN');
        if (!apifyToken) {
          return { success: false, error: '请先在设置页面配置 Apify API Token', commentsCount: 0 };
        }

        try {
          const tweetsResponse = await fetch(
            `https://api.apify.com/v2/acts/apidojo~twitter-scraper-lite/runs?token=${apifyToken}`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                searchTerms: [`from:${input.username}`],
                sort: 'Latest',
                maxItems: input.maxTweets,
              }),
            }
          );

          if (!tweetsResponse.ok) {
            const errorText = await tweetsResponse.text();
            return { success: false, error: `Apify API 调用失败: ${errorText}`, commentsCount: 0 };
          }

          const tweetsRun = await tweetsResponse.json();
          const runId = tweetsRun.data?.id;
          if (!runId) {
            return { success: false, error: '无法启动 Apify 任务', commentsCount: 0 };
          }

          let runStatus = 'RUNNING';
          let attempts = 0;
          const maxAttempts = 60;
          while (runStatus === 'RUNNING' && attempts < maxAttempts) {
            await new Promise(resolve => setTimeout(resolve, 5000));
            const statusResponse = await fetch(
              `https://api.apify.com/v2/actor-runs/${runId}?token=${apifyToken}`
            );
            const statusData = await statusResponse.json();
            runStatus = statusData.data?.status || 'FAILED';
            attempts++;
          }

          if (runStatus !== 'SUCCEEDED') {
            return { success: false, error: `Apify 任务未完成: ${runStatus}`, commentsCount: 0 };
          }

          const datasetId = tweetsRun.data?.defaultDatasetId;
          const tweetsDataResponse = await fetch(
            `https://api.apify.com/v2/datasets/${datasetId}/items?token=${apifyToken}`
          );
          const tweets = await tweetsDataResponse.json();

          if (!tweets || tweets.length === 0) {
            return { success: false, error: '未找到该用户的推文', commentsCount: 0 };
          }

          let totalComments = 0;
          const tweetIds = tweets.slice(0, input.maxTweets).map((t: any) => t.id);

          for (const tweetId of tweetIds) {
            try {
              const repliesResponse = await fetch(
                `https://api.apify.com/v2/acts/apidojo~twitter-scraper-lite/runs?token=${apifyToken}`,
                {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    searchTerms: [`conversation_id:${tweetId}`],
                    sort: 'Latest',
                    maxItems: input.maxCommentsPerTweet,
                  }),
                }
              );

              if (!repliesResponse.ok) continue;

              const repliesRun = await repliesResponse.json();
              const repliesRunId = repliesRun.data?.id;
              if (!repliesRunId) continue;

              let repliesStatus = 'RUNNING';
              let repliesAttempts = 0;
              while (repliesStatus === 'RUNNING' && repliesAttempts < 30) {
                await new Promise(resolve => setTimeout(resolve, 3000));
                const statusResp = await fetch(
                  `https://api.apify.com/v2/actor-runs/${repliesRunId}?token=${apifyToken}`
                );
                const statusData = await statusResp.json();
                repliesStatus = statusData.data?.status || 'FAILED';
                repliesAttempts++;
              }

              if (repliesStatus !== 'SUCCEEDED') continue;

              const repliesDatasetId = repliesRun.data?.defaultDatasetId;
              const repliesDataResponse = await fetch(
                `https://api.apify.com/v2/datasets/${repliesDatasetId}/items?token=${apifyToken}`
              );
              const replies = await repliesDataResponse.json();

              for (const reply of replies) {
                if (reply.id === tweetId) continue;
                try {
                  await insertRawComment({
                    replyId: reply.id,
                    tweetId: tweetId,
                    authorId: reply.author?.id || reply.userId || 'unknown',
                    authorName: reply.author?.name || reply.userName || 'Unknown',
                    authorHandle: reply.author?.userName || reply.userScreenName || 'unknown',
                    text: reply.text || reply.fullText || '',
                    createdAt: new Date(reply.createdAt || Date.now()),
                    likeCount: reply.likeCount || reply.favoriteCount || 0,
                    replyTo: reply.inReplyToStatusId || tweetId,
                  });
                  totalComments++;
                } catch (err) {
                  // Ignore duplicate errors
                }
              }
            } catch (err) {
              console.error(`Failed to fetch replies for tweet ${tweetId}:`, err);
            }
          }

          return { success: true, commentsCount: totalComments, tweetsProcessed: tweetIds.length };
        } catch (error) {
          return { success: false, error: String(error), commentsCount: 0 };
        }
      }),

    // Puppeteer 自爬功能 - 免费（保留旧路由名兼容）
    scrapeWithPlaywright: protectedProcedure
      .input(z.object({
        username: z.string(),
        maxTweets: z.number().min(1).max(100).default(30),
        maxRepliesPerTweet: z.number().min(0).max(300).default(0),
      }))
      .mutation(async ({ input }) => {
        const xCookies = await getConfig('X_COOKIES');
        
        try {
          clearScrapeProgress(input.username);
          const result = await playwrightScrapeUserComments(
            input.username,
            input.maxTweets,
            xCookies || undefined,
            (p) => setScrapeProgress(input.username, p),
            undefined,
            undefined,
            input.maxRepliesPerTweet
          );

          if (!result.success) {
            return { success: false, error: result.error, commentsCount: 0, tweetsCount: 0 };
          }

          let insertedCount = 0;
          
          if (result.tweets) {
            for (const tweet of result.tweets) {
              try {
                await insertRawComment({
                  replyId: tweet.id,
                  tweetId: tweet.id,
                  authorId: 'unknown',
                  authorName: tweet.authorName,
                  authorHandle: tweet.authorHandle,
                  text: tweet.text,
                  createdAt: new Date(tweet.createdAt),
                  likeCount: tweet.likeCount,
                  replyTo: undefined,
                });
              } catch (e) {
                // Ignore duplicates
              }
            }
          }

          if (result.replies) {
            for (const reply of result.replies) {
              try {
                await insertRawComment({
                  replyId: reply.id,
                  tweetId: reply.replyTo,
                  authorId: reply.authorId,
                  authorName: reply.authorName,
                  authorHandle: reply.authorHandle,
                  text: reply.text,
                  createdAt: new Date(reply.createdAt),
                  likeCount: reply.likeCount,
                  replyTo: reply.replyTo,
                });
                insertedCount++;
              } catch (err) {
                // Ignore duplicate errors
              }
            }
          }

          return {
            success: true,
            commentsCount: insertedCount,
            tweetsCount: result.tweets?.length || 0,
            totalScraped: result.replies?.length || 0,
          };
        } catch (error) {
          setScrapeProgress(input.username, {
            stage: "error",
            message: `采集失败: ${String(error)}`,
            tweetsFound: 0,
            repliesFound: 0,
            currentTweet: 0,
            totalTweets: input.maxTweets,
            currentAccount: 0,
            totalAccounts: 1,
          });
          return { success: false, error: String(error), commentsCount: 0, tweetsCount: 0 };
        }
      }),

    // 仅爬取指定 Tweet ID 下全部评论
    scrapeByTweetId: protectedProcedure
      .input(
        z.object({
          tweetId: z.string().min(1, "请输入 Tweet ID"),
          replySortMode: replySortModeEnum.default("recent"),
          expandFoldedReplies: z.boolean().default(false),
        }),
      )
      .mutation(async ({ input }) => {
        const xCookies = await getConfig('X_COOKIES');
        const apifyToken = await getConfig('APIFY_API_TOKEN');
        const tweetId = input.tweetId.trim();
        const maxReplies = 300;
        const progressKey = `tweet:${tweetId}`;
        let playwrightError: string | null = null;
        try {
          clearScrapeProgress(progressKey);
          const onTweet = async (tweet: { id: string; text: string; authorName: string; authorHandle: string; createdAt: string; likeCount: number }) => {
            try {
              await insertRawComment({
                replyId: tweet.id,
                tweetId: tweet.id,
                authorId: 'unknown',
                authorName: tweet.authorName,
                authorHandle: tweet.authorHandle,
                text: tweet.text,
                createdAt: new Date(tweet.createdAt),
                likeCount: tweet.likeCount,
                replyTo: undefined,
              });
            } catch (err) {
              /* ignore duplicate */
            }
          };
          const onReply = async (reply: { id: string; text: string; authorId: string; authorName: string; authorHandle: string; createdAt: string; likeCount: number; replyTo: string }) => {
            try {
              await insertRawComment({
                replyId: reply.id,
                tweetId: reply.replyTo,
                authorId: reply.authorId,
                authorName: reply.authorName,
                authorHandle: reply.authorHandle,
                text: reply.text,
                createdAt: new Date(reply.createdAt),
                likeCount: reply.likeCount,
                replyTo: reply.replyTo,
              });
            } catch (err) {
              /* ignore duplicate */
            }
          };
          const scrapePromise = scrapeRepliesByTweetId(
            tweetId,
            xCookies || undefined,
            (p) => setScrapeProgress(progressKey, p),
            onReply,
            onTweet,
            {
              sortMode: input.replySortMode,
              expandFoldedReplies: input.expandFoldedReplies,
            },
          );
          const hardTimeoutMs = 10 * 60 * 1000;
          const hardTimeout = new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error(`采集超时（>${hardTimeoutMs / 1000}s），请稍后重试`)), hardTimeoutMs)
          );
          const result = await Promise.race([scrapePromise, hardTimeout]);
          if (!result.success) {
            playwrightError = result.error || 'Puppeteer scrape failed';
            if (apifyToken) {
              const apifyResult = await scrapeTweetRepliesViaApify({
                tweetId,
                apifyToken,
                maxReplies,
                progressKey,
                sortMode: input.replySortMode,
              });
              if (apifyResult.success) return apifyResult;
              return {
                success: false,
                method: 'apify',
                error: `${apifyResult.error || 'Apify scrape failed'} (Puppeteer error: ${playwrightError})`,
                commentsCount: 0,
              };
            }
            return { success: false, method: 'puppeteer', error: result.error || '采集失败', commentsCount: 0 };
          }
          return {
            success: true,
            commentsCount: result.replies?.length ?? 0,
            message: `已采集 ${result.replies?.length ?? 0} 条评论，可在此页查看与导出`,
          };
        } catch (error: any) {
          const errorMessage = normalizeErrorMessage(error);
          if (apifyToken && isBrowserLaunchFailure(errorMessage)) {
            const apifyResult = await scrapeTweetRepliesViaApify({
              tweetId,
              apifyToken,
              maxReplies,
              progressKey,
              sortMode: input.replySortMode,
            });
            if (apifyResult.success) return apifyResult;
            return {
              success: false,
              method: 'apify',
              error: `${apifyResult.error || 'Apify scrape failed'} (Puppeteer error: ${errorMessage})`,
              commentsCount: 0,
            };
          }
          setScrapeProgress(progressKey, {
            stage: 'error',
            message: String(error?.message || error),
            tweetsFound: 0,
            repliesFound: 0,
            currentTweet: 0,
            totalTweets: 1,
            currentAccount: 0,
            totalAccounts: 1,
          });
          return { success: false, error: String(error?.message || error), commentsCount: 0 };
        }
      }),

    // 智能采集 - 优先使用 Puppeteer，Apify 作为备选
    smartFetch: protectedProcedure
      .input(z.object({
        username: z.string(),
        maxTweets: z.number().min(1).max(100).default(30),
        maxRepliesPerTweet: z.number().min(0).max(300).default(0),
        preferredMethod: z.enum(['puppeteer', 'playwright', 'apify', 'auto']).default('auto'),
        replySortMode: replySortModeEnum.default("recent"),
        expandFoldedReplies: z.boolean().default(false),
      }))
      .mutation(async ({ input }) => {
        const xCookies = await getConfig('X_COOKIES');
        const apifyToken = await getConfig('APIFY_API_TOKEN');
        let playwrightError: string | null = null;

        // Auto mode: try Puppeteer first, then Apify
        if (input.preferredMethod === 'auto' || input.preferredMethod === 'playwright' || input.preferredMethod === 'puppeteer') {
          try {
            clearScrapeProgress(input.username);
            // 边爬边显：先写入根推文再写回复
            let insertedReplyCount = 0;
            const onTweet = async (tweet: { id: string; text: string; authorName: string; authorHandle: string; createdAt: string; likeCount: number }) => {
              try {
                await insertRawComment({
                  replyId: tweet.id,
                  tweetId: tweet.id,
                  authorId: 'unknown',
                  authorName: tweet.authorName,
                  authorHandle: tweet.authorHandle,
                  text: tweet.text,
                  createdAt: new Date(tweet.createdAt),
                  likeCount: tweet.likeCount,
                  replyTo: undefined,
                });
              } catch (err) {
                // Ignore duplicate errors
              }
            };
            const onReply = async (reply: { id: string; text: string; authorId: string; authorName: string; authorHandle: string; createdAt: string; likeCount: number; replyTo: string }) => {
              try {
                await insertRawComment({
                  replyId: reply.id,
                  tweetId: reply.replyTo,
                  authorId: reply.authorId,
                  authorName: reply.authorName,
                  authorHandle: reply.authorHandle,
                  text: reply.text,
                  createdAt: new Date(reply.createdAt),
                  likeCount: reply.likeCount,
                  replyTo: reply.replyTo,
                });
                insertedReplyCount++;
              } catch (err) {
                // Ignore duplicate errors
              }
            };
            const scrapePromise = playwrightScrapeUserComments(
              input.username,
              input.maxTweets,
              xCookies || undefined,
              (p) => setScrapeProgress(input.username, p),
              onReply,
              onTweet,
              input.maxRepliesPerTweet,
              {
                sortMode: input.replySortMode,
                expandFoldedReplies: input.expandFoldedReplies,
              },
            );
            // Hard timeout to prevent endless spinner on UI (10 minutes)
            const hardTimeoutMs = 10 * 60 * 1000;
            const hardTimeout = new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error(`采集超时（>${hardTimeoutMs / 1000}s），请稍后重试或降低推文数量`)), hardTimeoutMs)
            );
            const result = await Promise.race([scrapePromise, hardTimeout]);

            if (result.success) {
              // Also insert the parent tweets (replies already inserted via onReply)
              if (result.tweets) {
                for (const tweet of result.tweets) {
                  try {
                    await insertRawComment({
                      replyId: tweet.id,
                      tweetId: tweet.id,
                      authorId: 'unknown',
                      authorName: tweet.authorName,
                      authorHandle: tweet.authorHandle,
                      text: tweet.text,
                      createdAt: new Date(tweet.createdAt),
                      likeCount: tweet.likeCount,
                      replyTo: undefined,
                    });
                  } catch (e) {
                    // Ignore duplicates
                  }
                }
              }

              return {
                success: true,
                method: 'puppeteer',
                commentsCount: insertedReplyCount,
                tweetsCount: result.tweets?.length || 0,
                message: insertedReplyCount > 0
                  ? `使用 Puppeteer 成功采集 ${insertedReplyCount} 条评论`
                  : `使用 Puppeteer 完成采集，但未获取到评论`,
              };
            }

            // If Puppeteer failed and we're in auto mode, try Apify
            if (!result.success) {
              playwrightError = result.error || 'Puppeteer 采集失败';
            }

            if (input.preferredMethod === 'auto' && apifyToken) {
              console.log(`Puppeteer 采集失败 (${playwrightError})，尝试使用 Apify...`);
            } else if (!result.success) {
              return {
                success: false,
                method: 'puppeteer',
                error: result.error || 'Puppeteer 采集失败',
                commentsCount: 0,
              };
            }
          } catch (err) {
            playwrightError = String(err);
            setScrapeProgress(input.username, {
              stage: "error",
              message: `采集失败: ${String(err)}`,
              tweetsFound: 0,
              repliesFound: 0,
              currentTweet: 0,
              totalTweets: input.maxTweets,
              currentAccount: 0,
              totalAccounts: 1,
            });
            if (input.preferredMethod === 'playwright' || input.preferredMethod === 'puppeteer') {
              return {
                success: false,
                method: 'puppeteer',
                error: String(err),
                commentsCount: 0,
              };
            }
          }
        }

        // Try Apify if preferred or as fallback
        if (input.preferredMethod === 'apify' || input.preferredMethod === 'auto') {
          if (!apifyToken) {
            return {
              success: false,
              error: '请配置 X Cookie 或 Apify API Token',
              commentsCount: 0,
            };
          }

          try {
            console.log(`[Apify] 开始获取 @${input.username} 的推文...`);
            
            const tweetsResponse = await fetch(
              `https://api.apify.com/v2/acts/apidojo~twitter-scraper-lite/runs?token=${apifyToken}`,
              {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  searchTerms: [`from:${input.username}`],
                  sort: 'Latest',
                  maxItems: input.maxTweets,
                }),
              }
            );

            if (!tweetsResponse.ok) {
              const errorText = await tweetsResponse.text();
              if (errorText.includes("Monthly usage hard limit exceeded")) {
                let errorMsg = "Apify 本月额度已耗尽，无法继续采集。请升级 Apify 套餐或等待下月重置。";
                if (playwrightError) {
                  errorMsg += ` (注：Puppeteer 自爬也失败了: ${playwrightError})`;
                }
                return { success: false, method: 'apify', error: errorMsg, commentsCount: 0 };
              }
              return { success: false, method: 'apify', error: `Apify API 调用失败: ${errorText}`, commentsCount: 0 };
            }

            const tweetsRun = await tweetsResponse.json();
            const runId = tweetsRun.data?.id;
            const datasetId = tweetsRun.data?.defaultDatasetId;
            
            if (!runId) {
              return { success: false, method: 'apify', error: '无法启动 Apify 任务', commentsCount: 0 };
            }

            console.log(`[Apify] 任务已启动, runId: ${runId}, datasetId: ${datasetId}`);

            let runStatus = 'RUNNING';
            let attempts = 0;
            const maxAttempts = 60;
            
            while (runStatus === 'RUNNING' && attempts < maxAttempts) {
              await new Promise(resolve => setTimeout(resolve, 5000));
              const statusResponse = await fetch(
                `https://api.apify.com/v2/actor-runs/${runId}?token=${apifyToken}`
              );
              const statusData = await statusResponse.json();
              runStatus = statusData.data?.status || 'FAILED';
              attempts++;
              console.log(`[Apify] 任务状态: ${runStatus}, 尝试次数: ${attempts}`);
            }

            if (runStatus !== 'SUCCEEDED') {
              return { success: false, method: 'apify', error: `Apify 任务未完成: ${runStatus}`, commentsCount: 0 };
            }

            const tweetsDataResponse = await fetch(
              `https://api.apify.com/v2/datasets/${datasetId}/items?token=${apifyToken}`
            );
            const tweets = await tweetsDataResponse.json();
            console.log(`[Apify] 获取到 ${tweets?.length || 0} 条推文`);

            if (!tweets || tweets.length === 0) {
              return { success: false, method: 'apify', error: '未找到该用户的推文', commentsCount: 0 };
            }

            let totalComments = 0;
            const apifyReplySort = toApifySort(input.replySortMode);
            const tweetIds = tweets.slice(0, input.maxTweets).map((t: any) => t.id);
            console.log(`[Apify] 开始获取 ${tweetIds.length} 条推文的评论...`);

            for (let i = 0; i < tweetIds.length; i++) {
              const tweetId = tweetIds[i];
              try {
                console.log(`[Apify] 获取推文 ${tweetId} 的评论 (${i + 1}/${tweetIds.length})...`);
                
                const repliesResponse = await fetch(
                  `https://api.apify.com/v2/acts/apidojo~twitter-scraper-lite/runs?token=${apifyToken}`,
                  {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                      searchTerms: [`conversation_id:${tweetId}`],
                      sort: apifyReplySort,
                      maxItems: input.maxRepliesPerTweet,
                    }),
                  }
                );

                if (!repliesResponse.ok) continue;

                const repliesRun = await repliesResponse.json();
                const repliesRunId = repliesRun.data?.id;
                const repliesDatasetId = repliesRun.data?.defaultDatasetId;
                if (!repliesRunId) continue;

                let repliesStatus = 'RUNNING';
                let repliesAttempts = 0;
                while (repliesStatus === 'RUNNING' && repliesAttempts < 30) {
                  await new Promise(resolve => setTimeout(resolve, 3000));
                  const statusResp = await fetch(
                    `https://api.apify.com/v2/actor-runs/${repliesRunId}?token=${apifyToken}`
                  );
                  const statusData = await statusResp.json();
                  repliesStatus = statusData.data?.status || 'FAILED';
                  repliesAttempts++;
                }

                if (repliesStatus !== 'SUCCEEDED') continue;

                const repliesDataResponse = await fetch(
                  `https://api.apify.com/v2/datasets/${repliesDatasetId}/items?token=${apifyToken}`
                );
                const replies = await repliesDataResponse.json();
                console.log(`[Apify] 推文 ${tweetId} 获取到 ${replies?.length || 0} 条评论`);

                for (const reply of replies) {
                  if (reply.id === tweetId) continue;
                  try {
                    await insertRawComment({
                      replyId: reply.id || String(Date.now()) + Math.random(),
                      tweetId: tweetId,
                      authorId: reply.author?.id || reply.userId || reply.user?.id || 'unknown',
                      authorName: reply.author?.name || reply.userName || reply.user?.name || 'Unknown',
                      authorHandle: reply.author?.userName || reply.userScreenName || reply.user?.screen_name || 'unknown',
                      text: reply.text || reply.fullText || reply.full_text || '',
                      createdAt: new Date(reply.createdAt || reply.created_at || Date.now()),
                      likeCount: reply.likeCount || reply.favoriteCount || reply.favorite_count || 0,
                      replyTo: reply.inReplyToStatusId || reply.in_reply_to_status_id || tweetId,
                    });
                    totalComments++;
                  } catch (err) {
                    console.log(`[Apify] 插入评论失败:`, err);
                  }
                }
              } catch (err) {
                console.error(`[Apify] 获取推文 ${tweetId} 的评论失败:`, err);
              }
            }

            console.log(`[Apify] 完成！共获取 ${totalComments} 条评论`);
            return {
              success: true,
              method: 'apify',
              message: `使用 Apify 成功获取 ${totalComments} 条评论`,
              commentsCount: totalComments,
              tweetsCount: tweetIds.length,
            };
          } catch (err) {
            console.error('[Apify] 错误:', err);
            return { success: false, method: 'apify', error: String(err), commentsCount: 0 };
          }
        }

        return { success: false, error: '无可用的采集方式', commentsCount: 0 };
      }),

    importComments: protectedProcedure
      .input(z.object({
        tweetId: z.string(),
        comments: z.array(z.object({
          replyId: z.string(),
          authorId: z.string(),
          authorName: z.string(),
          authorHandle: z.string(),
          text: z.string(),
          createdAt: z.string(),
          likeCount: z.number().default(0),
          replyTo: z.string().optional(),
        })),
      }))
      .mutation(async ({ input }) => {
        const imported: string[] = [];
        for (const comment of input.comments) {
          try {
            await insertRawComment({
              replyId: comment.replyId,
              tweetId: input.tweetId,
              authorId: comment.authorId,
              authorName: comment.authorName,
              authorHandle: comment.authorHandle,
              text: comment.text,
              createdAt: new Date(comment.createdAt),
              likeCount: comment.likeCount,
              replyTo: comment.replyTo,
            });
            imported.push(comment.replyId);
          } catch (error) {
            console.error(`Failed to import comment ${comment.replyId}:`, error);
          }
        }
        return { success: true, imported: imported.length };
      }),
  }),
});

export type AppRouter = typeof appRouter;
