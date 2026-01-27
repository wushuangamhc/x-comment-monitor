import { chromium, Browser, Page, BrowserContext } from 'playwright';

interface Tweet {
  id: string;
  text: string;
  authorName: string;
  authorHandle: string;
  createdAt: string;
  likeCount: number;
  replyCount: number;
  retweetCount: number;
}

interface Reply {
  id: string;
  text: string;
  authorId: string;
  authorName: string;
  authorHandle: string;
  createdAt: string;
  likeCount: number;
  replyTo: string;
}

interface ScrapeResult {
  success: boolean;
  tweets?: Tweet[];
  replies?: Reply[];
  error?: string;
}

// 爬取速度配置
export interface ScrapeConfig {
  // 页面加载后的基础延迟（毫秒）
  pageLoadDelay: number;
  // 滚动间隔（毫秒）
  scrollDelay: number;
  // 推文间的延迟（毫秒）
  betweenTweetsDelay: number;
  // 是否启用随机延迟
  randomDelay: boolean;
  // 随机延迟范围（毫秒）
  randomDelayRange: [number, number];
}

// 默认配置 - 保守模式，避免被封
export const DEFAULT_SCRAPE_CONFIG: ScrapeConfig = {
  pageLoadDelay: 3000,        // 页面加载后等待 3 秒
  scrollDelay: 2500,          // 滚动间隔 2.5 秒
  betweenTweetsDelay: 5000,   // 推文间延迟 5 秒
  randomDelay: true,          // 启用随机延迟
  randomDelayRange: [1000, 3000], // 随机增加 1-3 秒
};

// 预设配置
export const SCRAPE_PRESETS = {
  // 极慢模式 - 最安全
  ultraSlow: {
    pageLoadDelay: 5000,
    scrollDelay: 4000,
    betweenTweetsDelay: 10000,
    randomDelay: true,
    randomDelayRange: [2000, 5000] as [number, number],
  },
  // 慢速模式 - 安全
  slow: {
    pageLoadDelay: 3000,
    scrollDelay: 2500,
    betweenTweetsDelay: 5000,
    randomDelay: true,
    randomDelayRange: [1000, 3000] as [number, number],
  },
  // 正常模式 - 有一定风险
  normal: {
    pageLoadDelay: 2000,
    scrollDelay: 1500,
    betweenTweetsDelay: 3000,
    randomDelay: true,
    randomDelayRange: [500, 1500] as [number, number],
  },
  // 快速模式 - 高风险
  fast: {
    pageLoadDelay: 1000,
    scrollDelay: 1000,
    betweenTweetsDelay: 2000,
    randomDelay: true,
    randomDelayRange: [300, 800] as [number, number],
  },
};

// 当前配置
let currentConfig: ScrapeConfig = { ...DEFAULT_SCRAPE_CONFIG };

// 设置爬取配置
export function setScrapeConfig(config: Partial<ScrapeConfig>): void {
  currentConfig = { ...currentConfig, ...config };
}

// 获取当前配置
export function getScrapeConfig(): ScrapeConfig {
  return { ...currentConfig };
}

// 应用预设
export function applyScrapePreset(preset: keyof typeof SCRAPE_PRESETS): void {
  currentConfig = { ...SCRAPE_PRESETS[preset] };
}

// 计算实际延迟（包含随机部分）
function getDelay(baseDelay: number): number {
  if (!currentConfig.randomDelay) {
    return baseDelay;
  }
  const [min, max] = currentConfig.randomDelayRange;
  const randomExtra = Math.floor(Math.random() * (max - min + 1)) + min;
  return baseDelay + randomExtra;
}

// 等待函数
async function wait(baseDelay: number): Promise<void> {
  const delay = getDelay(baseDelay);
  await new Promise(resolve => setTimeout(resolve, delay));
}

// Store browser instance for reuse
let browserInstance: Browser | null = null;

async function getBrowser(): Promise<Browser> {
  if (!browserInstance || !browserInstance.isConnected()) {
    // 强制使用 chromium 而不是 chromium_headless_shell
    // 按优先级查找可用的浏览器路径
    const possiblePaths = [
      '/root/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome',
      '/home/ubuntu/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome',
      process.env.HOME + '/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome',
    ];
    
    let executablePath: string | undefined;
    const fs = await import('fs');
    
    for (const p of possiblePaths) {
      try {
        if (fs.existsSync(p)) {
          executablePath = p;
          console.log('[Playwright] Using browser at:', p);
          break;
        }
      } catch (e) {
        // Continue to next path
      }
    }

    if (!executablePath) {
      console.error('[Playwright] No browser found at any of:', possiblePaths);
      throw new Error('Playwright 浏览器未找到，请联系管理员');
    }

    browserInstance = await chromium.launch({
      headless: true,
      executablePath,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--disable-gpu',
        '--single-process',
      ],
    });
  }
  return browserInstance;
}

async function createContext(cookies?: string): Promise<BrowserContext> {
  const browser = await getBrowser();
  
  // 随机选择一个 User-Agent
  const userAgents = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15',
  ];
  const randomUserAgent = userAgents[Math.floor(Math.random() * userAgents.length)];
  
  const context = await browser.newContext({
    userAgent: randomUserAgent,
    viewport: { width: 1280 + Math.floor(Math.random() * 200), height: 800 + Math.floor(Math.random() * 100) },
    locale: 'en-US',
  });

  // Set cookies if provided
  if (cookies) {
    try {
      const cookieArray = JSON.parse(cookies);
      if (Array.isArray(cookieArray)) {
        await context.addCookies(cookieArray.map((c: any) => ({
          name: c.name,
          value: c.value,
          domain: c.domain || '.x.com',
          path: c.path || '/',
        })));
      }
    } catch (e) {
      console.error('Failed to parse cookies:', e);
    }
  }

  return context;
}

// Parse relative time to Date
function parseRelativeTime(timeStr: string): Date {
  const now = new Date();
  const match = timeStr.match(/(\d+)\s*(s|m|h|d)/);
  if (match) {
    const value = parseInt(match[1]);
    const unit = match[2];
    switch (unit) {
      case 's': return new Date(now.getTime() - value * 1000);
      case 'm': return new Date(now.getTime() - value * 60 * 1000);
      case 'h': return new Date(now.getTime() - value * 60 * 60 * 1000);
      case 'd': return new Date(now.getTime() - value * 24 * 60 * 60 * 1000);
    }
  }
  // Try parsing as date string
  const parsed = new Date(timeStr);
  return isNaN(parsed.getTime()) ? now : parsed;
}

// Parse count string (e.g., "1.2K" -> 1200)
function parseCount(countStr: string): number {
  if (!countStr) return 0;
  const cleaned = countStr.trim().toLowerCase();
  if (cleaned.endsWith('k')) {
    return Math.round(parseFloat(cleaned) * 1000);
  }
  if (cleaned.endsWith('m')) {
    return Math.round(parseFloat(cleaned) * 1000000);
  }
  return parseInt(cleaned) || 0;
}

/**
 * Scrape tweets from a user's profile
 */
export async function scrapeUserTweets(
  username: string,
  cookies?: string,
  maxTweets: number = 20
): Promise<ScrapeResult> {
  let context: BrowserContext | null = null;
  let page: Page | null = null;

  try {
    context = await createContext(cookies);
    page = await context.newPage();

    // Navigate to user's profile
    const url = `https://x.com/${username}`;
    await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });

    // 页面加载后等待
    await wait(currentConfig.pageLoadDelay);

    // Wait for tweets to load
    await page.waitForSelector('article[data-testid="tweet"]', { timeout: 15000 }).catch(() => null);

    // Check if login is required
    const loginPrompt = await page.$('text="Sign in"');
    if (loginPrompt) {
      return { success: false, error: '需要登录 X 账号才能查看内容，请在设置中配置 Cookie' };
    }

    const tweets: Tweet[] = [];
    let scrollAttempts = 0;
    const maxScrollAttempts = Math.min(10, Math.ceil(maxTweets / 3)); // 限制滚动次数

    while (tweets.length < maxTweets && scrollAttempts < maxScrollAttempts) {
      // Extract tweets from current view
      const tweetElements = await page.$$('article[data-testid="tweet"]');

      for (const element of tweetElements) {
        if (tweets.length >= maxTweets) break;

        try {
          // Get tweet link to extract ID
          const tweetLink = await element.$('a[href*="/status/"]');
          const href = tweetLink ? await tweetLink.getAttribute('href') : null;
          const idMatch = href?.match(/\/status\/(\d+)/);
          const id = idMatch ? idMatch[1] : `temp_${Date.now()}_${Math.random()}`;

          // Skip if already collected
          if (tweets.some(t => t.id === id)) continue;

          // Get tweet text
          const textElement = await element.$('[data-testid="tweetText"]');
          const text = textElement ? await textElement.innerText() : '';

          // Get author info
          const authorElement = await element.$('[data-testid="User-Name"]');
          const authorText = authorElement ? await authorElement.innerText() : '';
          const authorParts = authorText.split('\n');
          const authorName = authorParts[0] || 'Unknown';
          const authorHandle = (authorParts[1] || '').replace('@', '') || username;

          // Get time
          const timeElement = await element.$('time');
          const timeAttr = timeElement ? await timeElement.getAttribute('datetime') : null;
          const createdAt = timeAttr || new Date().toISOString();

          // Get engagement counts
          const likeButton = await element.$('[data-testid="like"]');
          const likeText = likeButton ? await likeButton.innerText() : '0';
          const likeCount = parseCount(likeText);

          const replyButton = await element.$('[data-testid="reply"]');
          const replyText = replyButton ? await replyButton.innerText() : '0';
          const replyCount = parseCount(replyText);

          const retweetButton = await element.$('[data-testid="retweet"]');
          const retweetText = retweetButton ? await retweetButton.innerText() : '0';
          const retweetCount = parseCount(retweetText);

          tweets.push({
            id,
            text,
            authorName,
            authorHandle,
            createdAt,
            likeCount,
            replyCount,
            retweetCount,
          });
        } catch (e) {
          // Skip this tweet if extraction fails
          continue;
        }
      }

      // Scroll down to load more
      await page.evaluate(() => window.scrollBy(0, 800));
      await wait(currentConfig.scrollDelay);
      scrollAttempts++;
    }

    return { success: true, tweets };
  } catch (error) {
    return { success: false, error: String(error) };
  } finally {
    if (page) await page.close();
    if (context) await context.close();
  }
}

/**
 * Scrape replies to a specific tweet
 */
export async function scrapeTweetReplies(
  tweetId: string,
  cookies?: string,
  maxReplies: number = 50
): Promise<ScrapeResult> {
  let context: BrowserContext | null = null;
  let page: Page | null = null;

  try {
    context = await createContext(cookies);
    page = await context.newPage();

    // We need to find the tweet URL first - try common patterns
    // Navigate directly to tweet
    const url = `https://x.com/i/web/status/${tweetId}`;
    await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });

    // 页面加载后等待
    await wait(currentConfig.pageLoadDelay);

    // Wait for replies to load
    await page.waitForSelector('article[data-testid="tweet"]', { timeout: 15000 }).catch(() => null);

    // Check if login is required
    const loginPrompt = await page.$('text="Sign in"');
    if (loginPrompt) {
      return { success: false, error: '需要登录 X 账号才能查看评论，请在设置中配置 Cookie' };
    }

    const replies: Reply[] = [];
    let scrollAttempts = 0;
    const maxScrollAttempts = Math.min(15, Math.ceil(maxReplies / 5)); // 限制滚动次数
    let isFirstTweet = true;

    while (replies.length < maxReplies && scrollAttempts < maxScrollAttempts) {
      const tweetElements = await page.$$('article[data-testid="tweet"]');

      for (const element of tweetElements) {
        if (replies.length >= maxReplies) break;

        try {
          // Get reply link to extract ID
          const replyLink = await element.$('a[href*="/status/"]');
          const href = replyLink ? await replyLink.getAttribute('href') : null;
          const idMatch = href?.match(/\/status\/(\d+)/);
          const id = idMatch ? idMatch[1] : `temp_${Date.now()}_${Math.random()}`;

          // Skip the original tweet (first one)
          if (isFirstTweet && id === tweetId) {
            isFirstTweet = false;
            continue;
          }
          isFirstTweet = false;

          // Skip if already collected
          if (replies.some(r => r.id === id)) continue;

          // Get reply text
          const textElement = await element.$('[data-testid="tweetText"]');
          const text = textElement ? await textElement.innerText() : '';

          // Get author info
          const authorElement = await element.$('[data-testid="User-Name"]');
          const authorText = authorElement ? await authorElement.innerText() : '';
          const authorParts = authorText.split('\n');
          const authorName = authorParts[0] || 'Unknown';
          const authorHandle = (authorParts[1] || '').replace('@', '') || 'unknown';

          // Get time
          const timeElement = await element.$('time');
          const timeAttr = timeElement ? await timeElement.getAttribute('datetime') : null;
          const createdAt = timeAttr || new Date().toISOString();

          // Get like count
          const likeButton = await element.$('[data-testid="like"]');
          const likeText = likeButton ? await likeButton.innerText() : '0';
          const likeCount = parseCount(likeText);

          replies.push({
            id,
            text,
            authorId: authorHandle, // Use handle as ID since we can't get real ID easily
            authorName,
            authorHandle,
            createdAt,
            likeCount,
            replyTo: tweetId,
          });
        } catch (e) {
          continue;
        }
      }

      // Scroll down to load more replies
      await page.evaluate(() => window.scrollBy(0, 600));
      await wait(currentConfig.scrollDelay);
      scrollAttempts++;
    }

    return { success: true, replies };
  } catch (error) {
    return { success: false, error: String(error) };
  } finally {
    if (page) await page.close();
    if (context) await context.close();
  }
}

/**
 * Scrape all replies for a user's recent tweets
 */
export async function scrapeUserComments(
  username: string,
  cookies?: string,
  maxTweets: number = 10,
  maxRepliesPerTweet: number = 30
): Promise<{ success: boolean; totalReplies: number; tweets: Tweet[]; replies: Reply[]; error?: string }> {
  // First get user's tweets
  const tweetsResult = await scrapeUserTweets(username, cookies, maxTweets);
  
  if (!tweetsResult.success || !tweetsResult.tweets) {
    return { success: false, totalReplies: 0, tweets: [], replies: [], error: tweetsResult.error };
  }

  const allReplies: Reply[] = [];
  const tweets = tweetsResult.tweets;

  // For each tweet with replies, scrape the replies
  for (const tweet of tweets) {
    if (tweet.replyCount > 0) {
      const repliesResult = await scrapeTweetReplies(tweet.id, cookies, maxRepliesPerTweet);
      if (repliesResult.success && repliesResult.replies) {
        allReplies.push(...repliesResult.replies);
      }
      // 推文间延迟 - 使用配置的延迟
      await wait(currentConfig.betweenTweetsDelay);
    }
  }

  return {
    success: true,
    totalReplies: allReplies.length,
    tweets,
    replies: allReplies,
  };
}

/**
 * Close browser instance
 */
export async function closeBrowser(): Promise<void> {
  if (browserInstance) {
    await browserInstance.close();
    browserInstance = null;
  }
}
