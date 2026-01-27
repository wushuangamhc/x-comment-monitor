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
} from "./db";

// Sentiment types
const sentimentEnum = z.enum(["positive", "neutral", "negative", "anger", "sarcasm"]);

// Comment filter schema
const commentFilterSchema = z.object({
  tweetId: z.string().optional(),
  authorHandles: z.array(z.string()).optional(),
  startTime: z.date().optional(),
  endTime: z.date().optional(),
  sentiments: z.array(sentimentEnum).optional(),
  minValueScore: z.number().min(0).max(1).optional(),
  maxValueScore: z.number().min(0).max(1).optional(),
  sortBy: z.enum(['time_desc', 'time_asc', 'value_desc', 'likes_desc']).optional(),
  limit: z.number().min(1).max(100).optional(),
  offset: z.number().min(0).optional(),
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

    stats: publicProcedure
      .input(z.object({ tweetId: z.string().optional() }))
      .query(async ({ input }) => {
        const stats = await getCommentStats(input.tweetId);
        
        const sentimentCounts: Record<string, number> = {
          positive: 0, neutral: 0, negative: 0, anger: 0, sarcasm: 0,
        };
        const valueDistribution: number[] = Array(10).fill(0);
        const sentimentOverTime: Record<string, Record<string, number>> = {};
        
        stats.forEach(item => {
          if (item.sentiment) sentimentCounts[item.sentiment]++;
          if (item.valueScore) {
            const bucket = Math.min(Math.floor(parseFloat(item.valueScore) * 10), 9);
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
                  valueScore: { type: "number", description: "评论价值评分 0-1" },
                  valueType: { type: "array", items: { type: "string" }, description: "价值类型数组" },
                  summary: { type: "string", description: "一句话摘要" },
                },
                required: ["sentiment", "valueScore", "valueType", "summary"],
                additionalProperties: false,
              },
            },
          },
        });

        const content = response.choices[0]?.message?.content as string | undefined;
        if (!content) throw new Error("AI analysis failed: no response");

        const analysis = JSON.parse(content);
        analysis.valueScore = Math.max(0, Math.min(1, analysis.valueScore));
        
        await insertAnalyzedComment({
          replyId: input.replyId,
          sentiment: analysis.sentiment,
          valueScore: analysis.valueScore.toFixed(2),
          valueType: analysis.valueType,
          summary: analysis.summary,
        });

        return analysis;
      }),

    analyzeUnanalyzed: protectedProcedure
      .input(z.object({ limit: z.number().min(1).max(20).default(5) }))
      .mutation(async ({ input }) => {
        const unanalyzed = await getUnanalyzedComments(input.limit);
        const results = [];

        for (const comment of unanalyzed) {
          try {
            const prompt = `分析以下 X/Twitter 评论，返回 JSON 格式的分析结果：

评论内容：
"${comment.text}"

请分析并返回以下字段：
1. sentiment: 情绪类型，必须是以下之一：positive、neutral、negative、anger、sarcasm
2. valueScore: 评论价值评分（0-1）
3. valueType: 价值类型数组
4. summary: 一句话摘要（中文，20字以内）

只返回 JSON，不要其他内容。`;

            const response = await invokeLLM({
              messages: [
                { role: "system", content: "你是一个专业的社交媒体舆情分析师。" },
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
                      sentiment: { type: "string", enum: ["positive", "neutral", "negative", "anger", "sarcasm"] },
                      valueScore: { type: "number" },
                      valueType: { type: "array", items: { type: "string" } },
                      summary: { type: "string" },
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
              analysis.valueScore = Math.max(0, Math.min(1, analysis.valueScore));
              
              await insertAnalyzedComment({
                replyId: comment.replyId,
                sentiment: analysis.sentiment,
                valueScore: analysis.valueScore.toFixed(2),
                valueType: analysis.valueType,
                summary: analysis.summary,
              });

              results.push({ replyId: comment.replyId, success: true, analysis });
            }
          } catch (error) {
            results.push({ replyId: comment.replyId, success: false, error: String(error) });
          }
        }

        return { analyzed: results.filter(r => r.success).length, results };
      }),

    generateOpinionClusters: publicProcedure
      .input(z.object({ tweetId: z.string().optional() }))
      .query(async ({ input }) => {
        const comments = await getCommentsWithAnalysis({
          tweetId: input.tweetId,
          minValueScore: 0.4,
          limit: 50,
        });

        if (comments.length === 0) return { clusters: [] };

        const commentTexts = comments
          .filter(c => c.summary)
          .map(c => `- ${c.summary} (情绪: ${c.sentiment}, 价值: ${c.valueScore})`)
          .join('\n');

        const prompt = `基于以下评论摘要，提取 3-5 个主要观点类别，每个类别给出：
1. 观点名称（简短）
2. 观点描述（一句话）
3. 代表性评论索引（从0开始）
4. 该观点的评论数量占比估计

评论列表：
${commentTexts}

返回 JSON 格式。`;

        try {
          const response = await invokeLLM({
            messages: [
              { role: "system", content: "你是一个专业的舆情分析师，擅长从大量评论中提取关键观点。" },
              { role: "user", content: prompt },
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
                          name: { type: "string", description: "观点名称" },
                          description: { type: "string", description: "观点描述" },
                          representativeIndex: { type: "number", description: "代表性评论索引" },
                          percentage: { type: "number", description: "占比估计" },
                        },
                        required: ["name", "description", "representativeIndex", "percentage"],
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
        return { success: true };
      }),

    list: protectedProcedure.query(async () => {
      return await getAllConfigs();
    }),
  }),

  // Twitter data collection router
  twitter: router({
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
