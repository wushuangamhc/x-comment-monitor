import { chromium, Browser, BrowserContext, Page } from 'playwright';
import { getConfig } from './db';

// Helper to add timeout to promises
function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(message)), ms))
  ]);
}

// Helper: retry page.goto to handle ERR_CONNECTION_CLOSED / transient network errors
async function gotoWithRetry(
  page: Page,
  url: string,
  options: { waitUntil?: 'domcontentloaded' | 'load' | 'commit'; timeout?: number } = {},
  maxAttempts = 3
): Promise<void> {
  const { waitUntil = 'domcontentloaded', timeout = 45000 } = options;
  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await page.goto(url, { waitUntil, timeout });
      return;
    } catch (e: any) {
      lastError = e;
      const msg = String(e?.message || e);
      const isRetryable = /ERR_CONNECTION_CLOSED|ERR_CONNECTION_RESET|ERR_NETWORK|timeout|Timeout/i.test(msg);
      if (attempt < maxAttempts && isRetryable) {
        await wait(3000 + attempt * 2000); // 3s, 5s, 7s
        continue;
      }
      throw e;
    }
  }
  if (lastError) throw lastError;
}

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
  progress?: ScrapeProgress;
}

// 采集进度
export interface ScrapeProgress {
  stage: 'init' | 'loading' | 'fetching_tweets' | 'fetching_replies' | 'complete' | 'error';
  message: string;
  tweetsFound: number;
  repliesFound: number;
  currentTweet: number;
  totalTweets: number;
  currentAccount: number;
  totalAccounts: number;
}

// 爬取速度配置
export interface ScrapeConfig {
  pageLoadDelay: number;
  scrollDelay: number;
  betweenTweetsDelay: number;
  randomDelay: boolean;
  randomDelayRange: [number, number];
}

// 默认配置 - 保守模式
export const DEFAULT_SCRAPE_CONFIG: ScrapeConfig = {
  pageLoadDelay: 3000,
  scrollDelay: 2500,
  betweenTweetsDelay: 5000,
  randomDelay: true,
  randomDelayRange: [1000, 3000],
};

// 预设配置
export const SCRAPE_PRESETS = {
  ultraSlow: {
    pageLoadDelay: 5000,
    scrollDelay: 4000,
    betweenTweetsDelay: 10000,
    randomDelay: true,
    randomDelayRange: [2000, 5000] as [number, number],
  },
  slow: {
    pageLoadDelay: 3000,
    scrollDelay: 2500,
    betweenTweetsDelay: 5000,
    randomDelay: true,
    randomDelayRange: [1000, 3000] as [number, number],
  },
  normal: {
    pageLoadDelay: 2000,
    scrollDelay: 1500,
    betweenTweetsDelay: 3000,
    randomDelay: true,
    randomDelayRange: [500, 1500] as [number, number],
  },
  fast: {
    pageLoadDelay: 1000,
    scrollDelay: 800,
    betweenTweetsDelay: 1500,
    randomDelay: true,
    randomDelayRange: [200, 800] as [number, number],
  },
};

let currentConfig: ScrapeConfig = { ...DEFAULT_SCRAPE_CONFIG };

// 多账号 Cookie 管理
let accountCookies: string[] = [];
let currentAccountIndex = 0;

export function setAccountCookies(cookies: string[]): void {
  accountCookies = cookies.filter(c => c && c.trim());
  currentAccountIndex = 0;
  console.log(`[Scraper] Loaded ${accountCookies.length} account(s)`);
}

export function getAccountCount(): number {
  return accountCookies.length;
}

export function addAccountCookie(cookie: string): void {
  if (cookie && cookie.trim()) {
    accountCookies.push(cookie.trim());
    console.log(`[Scraper] Added account, total: ${accountCookies.length}`);
  }
}

export function removeAccountCookie(index: number): void {
  if (index >= 0 && index < accountCookies.length) {
    accountCookies.splice(index, 1);
    if (currentAccountIndex >= accountCookies.length) {
      currentAccountIndex = 0;
    }
  }
}

export function getNextAccountCookie(): string | undefined {
  if (accountCookies.length === 0) return undefined;
  const cookie = accountCookies[currentAccountIndex];
  currentAccountIndex = (currentAccountIndex + 1) % accountCookies.length;
  return cookie;
}

export function getCurrentAccountIndex(): number {
  return currentAccountIndex;
}

export function setScrapeConfig(config: Partial<ScrapeConfig>): void {
  currentConfig = { ...currentConfig, ...config };
}

export function getScrapeConfig(): ScrapeConfig {
  return { ...currentConfig };
}

export function applyScrapePreset(preset: keyof typeof SCRAPE_PRESETS): void {
  currentConfig = { ...SCRAPE_PRESETS[preset] };
}

function getDelay(baseDelay: number): number {
  if (!currentConfig.randomDelay) return baseDelay;
  const [min, max] = currentConfig.randomDelayRange;
  const randomExtra = Math.floor(Math.random() * (max - min + 1)) + min;
  return baseDelay + randomExtra;
}

async function wait(baseDelay: number): Promise<void> {
  const delay = getDelay(baseDelay);
  await new Promise(resolve => setTimeout(resolve, delay));
}

// Helper to find the Y position of the "More tweets" / recommendation divider
async function getCutoffY(page: Page): Promise<number> {
  try {
    const primaryColumn = await page.$('[data-testid="primaryColumn"]');
    if (!primaryColumn) return Infinity;

    // Match common headers for recommendations (English, Chinese, and variants)
    // Anchored to avoid matching "Show more replies"
    const patterns = [
      'text=/^(More tweets|Discover more|You might like|更多推文|发现更多|推荐内容)$/i',
      'text=/^(Recommended for you|Recommended|For you|Trending|Who to follow|关注)$/i',
    ];
    for (const selector of patterns) {
      try {
        const cutoffHeader = await primaryColumn.$(selector);
        if (cutoffHeader) {
          const box = await cutoffHeader.boundingBox();
          if (box) return box.y;
        }
      } catch (_) {
        continue;
      }
    }

    // Structure fallback: block that contains "Recommended" text or Follow-style CTA
    try {
      const recommendedBlock = await primaryColumn.$('text=/Recommended|推荐/i');
      if (recommendedBlock) {
        const box = await recommendedBlock.boundingBox();
        if (box) return box.y;
      }
    } catch (_) {
      // ignore
    }
  } catch (e) {
    // Ignore errors and continue scraping if cutoff not found
  }
  return Infinity;
}

// 检测推文/回复中的图片、视频，返回占位文本 [图片][视频]
async function getMediaPlaceholders(articleEl: { $: (selector: string) => Promise<{ dispose?: () => Promise<void> } | null> }): Promise<string> {
  let s = '';
  try {
    const photo = await articleEl.$('[data-testid="tweetPhoto"]');
    if (photo) { s += ' [图片]'; (photo as any).dispose?.(); }
    const videoPlayer = await articleEl.$('[data-testid="videoPlayer"]');
    if (videoPlayer) { s += ' [视频]'; (videoPlayer as any).dispose?.(); }
    if (!s.includes('[视频]')) {
      const videoTag = await articleEl.$('video');
      if (videoTag) { s += ' [视频]'; (videoTag as any).dispose?.(); }
    }
  } catch (_) { /* ignore */ }
  return s;
}

let browserInstance: Browser | null = null;

async function getBrowser(): Promise<Browser> {
  if (!browserInstance || !browserInstance.isConnected()) {
    try {
      console.log('[Playwright] Launching browser...');

      // Proxy: 优先使用应用内配置（设置页），其次环境变量 .env
      const configProxy = await getConfig('PLAYWRIGHT_PROXY');
      const proxyServer = (configProxy?.trim() || '') || process.env.HTTPS_PROXY || process.env.ALL_PROXY || process.env.http_proxy || process.env.https_proxy;
      const launchOptions: any = {
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-accelerated-2d-canvas',
          '--disable-gpu',
          '--ignore-certificate-errors',
        ],
      };
      if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH) {
        launchOptions.executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
      }
      if (proxyServer) {
        console.log(`[Playwright] Using proxy: ${proxyServer}`);
        launchOptions.proxy = { server: proxyServer };
      } else {
        console.log('[Playwright] No proxy configured, attempting direct connection');
      }

      console.log('[Playwright] Attempting launch...');
      browserInstance = await withTimeout(
        chromium.launch(launchOptions),
        30000,
        "Browser launch timed out after 30s"
      );
      console.log('[Playwright] Launch successful');
      
    } catch (launchError: any) {
      console.error('[Playwright] Launch failed:', launchError.message);
      throw new Error(`Playwright 浏览器启动失败: ${launchError.message}。请确保已安装浏览器 (npx playwright install chromium)`);
    }
  }
  return browserInstance;
}

async function createContext(cookies?: string): Promise<BrowserContext> {
  console.log('[Playwright] Creating context...');
  const browser = await getBrowser();

  // 每次创建 context 时都带上当前代理（与 getBrowser 同源：设置页 > 环境变量），
  // 这样即使用户先做了 Tweet ID 采集再设代理、或浏览器是早前无代理启动的，新 context 也会走代理
  const configProxy = await getConfig('PLAYWRIGHT_PROXY');
  const proxyServer = (configProxy?.trim() || '') || process.env.HTTPS_PROXY || process.env.ALL_PROXY || process.env.http_proxy || process.env.https_proxy;
  const contextOptions: Parameters<Browser['newContext']>[0] = {
    userAgent: [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
    ][Math.floor(Math.random() * 3)],
    viewport: { width: 1280 + Math.floor(Math.random() * 200), height: 800 + Math.floor(Math.random() * 100) },
    locale: 'en-US',
    ignoreHTTPSErrors: true,
  };
  if (proxyServer) {
    contextOptions.proxy = { server: proxyServer };
    console.log('[Playwright] Context using proxy:', proxyServer);
  }

  console.log('[Playwright] Opening new context...');
  const context = await withTimeout(
    browser.newContext(contextOptions),
    30000,
    "Context creation timed out after 30s"
  );
  console.log('[Playwright] Context created successfully');

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
      console.error('[Scraper] Failed to parse cookies:', e);
    }
  }

  return context;
}

// 进度回调类型
export type ProgressCallback = (progress: ScrapeProgress) => void;

// 单条评论回调：每爬到一条评论时调用，便于「边爬边显」
export type OnReplyCallback = (reply: Reply) => void | Promise<void>;
// 根推文回调：在抓取某条推文的回复之前调用，便于先写入父推文，列表按 rootTweetAuthor 过滤时能立即看到新回复
export type OnTweetCallback = (tweet: Tweet) => void | Promise<void>;

// 主要爬取函数 - 支持进度回调、单条评论回调和根推文回调
// maxRepliesPerTweet: 每条推文最多拉取的评论数；0 或不传表示不限制，直到连续多轮滚动无新评论为止
export async function scrapeUserComments(
  username: string,
  maxTweets: number = 10,
  cookies?: string,
  onProgress?: ProgressCallback,
  onReply?: OnReplyCallback,
  onTweet?: OnTweetCallback,
  maxRepliesPerTweet: number = 0
): Promise<ScrapeResult> {
  // 使用传入的 cookies 或轮换账号
  const useCookies = cookies || getNextAccountCookie();
  const accountIndex = cookies ? 0 : getCurrentAccountIndex();
  const totalAccounts = cookies ? 1 : Math.max(1, getAccountCount());
  
  const progress: ScrapeProgress = {
    stage: 'init',
    message: '正在初始化...',
    tweetsFound: 0,
    repliesFound: 0,
    currentTweet: 0,
    totalTweets: maxTweets,
    currentAccount: accountIndex,
    totalAccounts,
  };
  
  const updateProgress = (updates: Partial<ScrapeProgress>) => {
    Object.assign(progress, updates);
    onProgress?.(progress);
  };

  if (!username) {
    return { success: false, error: '用户名不能为空', progress };
  }

  let context: BrowserContext | null = null;
  let page: Page | null = null;

  try {
    console.log('[Scraper] Starting scrape for user:', username);
    updateProgress({ stage: 'loading', message: '正在检测运行环境...' });
    await wait(500); // Small delay to let UI show the message

    const proxy = process.env.HTTPS_PROXY || process.env.ALL_PROXY;
    if (proxy) {
      updateProgress({ message: `检测到代理配置: ${proxy}` });
      await wait(500);
    } else {
      updateProgress({ message: '未检测到代理，将直连尝试...' });
      await wait(500);
    }

    updateProgress({ message: '正在启动浏览器核心...' });
    console.log('[Scraper] Calling createContext...');
    
    // Add a race timeout for context creation specifically
    const contextPromise = createContext(useCookies);
    const contextTimeout = new Promise<never>((_, reject) => 
        setTimeout(() => reject(new Error('Browser initialization timed out (15s)')), 15000)
    );
    
    try {
        context = await Promise.race([contextPromise, contextTimeout]);
    } catch (initError: any) {
        console.error('[Scraper] Context creation failed/timed out:', initError);
        throw new Error(`浏览器启动失败: ${initError.message}`);
    }
    
    console.log('[Scraper] Context created, creating new page...');
    updateProgress({ message: '正在创建页面上下文...' });
    await wait(500);
    page = await context.newPage();
    
    updateProgress({ message: `正在导航至 @${username} 主页...` });
    console.log(`[Scraper] Navigating to https://x.com/${username}`);
    
    // 访问用户主页（使用重试 + 更长超时，x.com 经常较慢或偶发超时）
    try {
      await gotoWithRetry(page, `https://x.com/${username}`, { waitUntil: 'domcontentloaded', timeout: 60000 }, 3);
    } catch (navError: any) {
      const msg = String(navError?.message || navError);
      if (msg.includes('ERR_CONNECTION_CLOSED') || msg.includes('ERR_CONNECTION_REFUSED') || msg.includes('net::ERR')) {
        throw new Error(
          '无法连接 X (x.com)：连接被关闭或拒绝。若在本机运行，请检查网络/防火墙或设置代理（HTTPS_PROXY）；若在云服务器（如 Railway）上运行，X 可能封禁机房 IP，采集需在本地运行或配置可访问 X 的代理。'
        );
      }
      throw navError;
    }
    
    // Scroll down slightly to trigger lazy loading
    // For high-profile accounts like elonmusk, we need to scroll more to bypass pinned tweets or heavy headers
    await page.evaluate(() => window.scrollBy(0, 1000));
    await wait(1000); 

    // Explicitly wait for content to load
    try {
      // Wait for tabs first (usually appears before tweets)
      await page.waitForSelector('[role="tablist"]', { timeout: 15000 });
      // Then wait for tweets
      await page.waitForSelector('article[data-testid="tweet"]', { timeout: 15000 });
    } catch (e) {
      console.log('[Scraper] Wait for content timeout, retrying scroll...');
      await page.evaluate(() => window.scrollBy(0, 500));
      await wait(2000);
    }

    await wait(currentConfig.pageLoadDelay);

    // 检查是否需要登录
    // Use a more specific selector and wait briefly to ensure it's not a false positive
    try {
        const loginButton = await page.waitForSelector('a[href*="/login"]', { timeout: 3000 }).catch(() => null);
        
        // Also check for the "Sign in to X" text which often appears in the modal
        const signInText = await page.$('text="Sign in to X"').catch(() => null);
        
        if ((loginButton || signInText) && !useCookies) {
          console.warn('[Scraper] Login required detected');
          updateProgress({ stage: 'error', message: '需要登录才能查看内容' });
          return { success: false, error: '需要登录才能查看完整内容，请在设置中配置 X Cookie', progress };
        }
    } catch (e) {
        // Ignore errors during login check
    }

    updateProgress({ stage: 'fetching_tweets', message: '正在获取推文列表...' });

    // 获取推文
    const tweets: Tweet[] = [];
    let scrollCount = 0;
    const maxScrolls = Math.ceil(maxTweets / 3) + 5;

    while (tweets.length < maxTweets && scrollCount < maxScrolls) {
      let tweetElements = await page.$$('article[data-testid="tweet"]');
      
      // Retry if no tweets found on first scroll
      if (tweetElements.length === 0 && scrollCount === 0) {
          console.log('[Scraper] No tweets found initially, waiting and retrying...');
          await wait(3000);
          tweetElements = await page.$$('article[data-testid="tweet"]');
      }

      console.log(`[Scraper] Found ${tweetElements.length} tweet elements on current scroll view.`);
      
      // Calculate the cutoff line for this scroll position
      const cutoffY = await getCutoffY(page);
      let reachedEnd = false;

      for (const el of tweetElements) {
        if (tweets.length >= maxTweets) break;
        
        try {
          // Check if this tweet is below the "More tweets" line
          const box = await el.boundingBox();
          if (box && box.y > cutoffY) {
              console.log('[Scraper] Reached "More tweets" section, stopping profile scrape.');
              reachedEnd = true;
              break; // Stop processing current batch
          }

          const tweetLink = await el.$('a[href*="/status/"]');
          const href = await tweetLink?.getAttribute('href');
          const tweetId = href?.match(/status\/(\d+)/)?.[1];
          
          if (!tweetId) {
             console.log('[Scraper] Skipped tweet element: No ID found');
             continue;
          }
          if (tweets.some(t => t.id === tweetId)) {
             // console.log(`[Scraper] Skipped duplicate tweet: ${tweetId}`);
             continue;
          }

          const textEl = await el.$('[data-testid="tweetText"]');
          let text = await textEl?.textContent() || '';
          // 无正文时用卡片标题占位
          if (!text.trim()) {
             const card = await el.$('[data-testid="card.wrapper"]');
             if (card) {
                 const cardTitleEl = await card.$('div[dir="auto"][style*="color: rgb(15, 20, 25)"], span');
                 const cardTitle = await cardTitleEl?.textContent();
                 if (cardTitle) text = `[链接] ${cardTitle.slice(0, 50)}`;
                 else text = '[链接]';
             }
          }
          text = text.trim() + (await getMediaPlaceholders(el));

          const authorEl = await el.$('[data-testid="User-Name"]');
          const authorText = await authorEl?.textContent() || '';
          const authorMatch = authorText.match(/(.+?)@(\w+)/);
          
          const timeEl = await el.$('time');
          const datetime = await timeEl?.getAttribute('datetime') || new Date().toISOString();
          
          // 获取互动数据
          const likeEl = await el.$('[data-testid="like"] span');
          const replyEl = await el.$('[data-testid="reply"] span');
          const retweetEl = await el.$('[data-testid="retweet"] span');
          
          const parseCount = (text: string | null | undefined): number => {
            if (!text) return 0;
            const num = text.replace(/[,K]/g, '');
            if (text.includes('K')) return parseFloat(num) * 1000;
            return parseInt(num) || 0;
          };

          tweets.push({
            id: tweetId,
            text,
            authorName: authorMatch?.[1]?.trim() || username,
            authorHandle: authorMatch?.[2] || username,
            createdAt: datetime,
            likeCount: parseCount(await likeEl?.textContent()),
            replyCount: parseCount(await replyEl?.textContent()),
            retweetCount: parseCount(await retweetEl?.textContent()),
          });

          updateProgress({ 
            tweetsFound: tweets.length,
            message: `已找到 ${tweets.length}/${maxTweets} 条推文...`
          });
        } catch (e) {
          // Skip this tweet
        }
      }

      if (reachedEnd) break;

      if (tweets.length < maxTweets) {
        await page.evaluate(() => window.scrollBy(0, 800));
        await wait(currentConfig.scrollDelay);
        scrollCount++;
      }
    }

    updateProgress({ 
      stage: 'fetching_replies',
      totalTweets: tweets.length,
      message: `共找到 ${tweets.length} 条推文，开始获取评论...`
    });

    // 获取每条推文的评论
    const allReplies: Reply[] = [];
    
    for (let i = 0; i < tweets.length; i++) {
      const tweet = tweets[i];
      updateProgress({
        currentTweet: i + 1,
        message: `正在获取第 ${i + 1}/${tweets.length} 条推文的评论...`
      });

      // 先写入根推文，这样按 rootTweetAuthor 过滤的列表能立即显示即将抓取的回复（边爬边显）
      if (onTweet) {
        try {
          await Promise.resolve(onTweet(tweet));
        } catch (e) {
          console.error('[Scraper] onTweet error:', e);
        }
      }

      try {
        // OPTIMIZATION: Faster navigation with explicit content wait
        await page.goto(`https://x.com/${tweet.authorHandle}/status/${tweet.id}`, { 
          waitUntil: 'domcontentloaded', 
          timeout: 60000 
        });

        // Wait for the conversation to load
        try {
          await page.waitForSelector('article[data-testid="tweet"]', { timeout: 15000 });
        } catch (e) {
          // If selector times out, it might be a single tweet with no replies or slow load
          // We proceed to scraping attempt anyway
        }
        
        await wait(currentConfig.pageLoadDelay);

        // 优先切换到「最新」回复，否则 X 默认「最热」只显示部分评论
        try {
          const latestTab = page.locator('a[role="tab"]').filter({ hasText: /Latest|最新/i }).first();
          if ((await latestTab.count()) > 0) {
            await latestTab.click();
            await wait(2000);
            console.log('[Scraper] Switched to Latest replies.');
          }
        } catch (_) { /* ignore */ }

        // 滚动加载评论：无新评论则停 或 达到 maxRepliesPerTweet
        const repliesCountBeforeThisTweet = allReplies.length;
        let consecutiveScrollsWithNoNew = 0;
        const maxScrollsWithNoNew = 8; // 连续 8 轮无新评论才停（慢网络时更稳）
        let scrollBudget = 500; // 单条推文最多滚动轮数（防止死循环）
        
        while (consecutiveScrollsWithNoNew < maxScrollsWithNoNew && scrollBudget > 0) {
          scrollBudget--;
          const countBeforeScroll = allReplies.length;
          const replyElements = await page.$$('article[data-testid="tweet"]');
          
          // Calculate cutoff
          const cutoffY = await getCutoffY(page);
          let reachedEnd = false;

          for (const el of replyElements) {
            try {
              // Check boundary
              const box = await el.boundingBox();
              if (box && box.y > cutoffY) {
                  console.log('[Scraper] Reached "More tweets" recommendations, stopping reply scrape.');
                  reachedEnd = true;
                  break;
              }

              const replyLink = await el.$('a[href*="/status/"]');
              const href = await replyLink?.getAttribute('href');
              const replyId = href?.match(/status\/(\d+)/)?.[1];
              
              // 跳过原推文
              if (!replyId || replyId === tweet.id || allReplies.some(r => r.id === replyId)) continue;

              const textEl = await el.$('[data-testid="tweetText"]');
              let text = (await textEl?.textContent() || '').trim() + (await getMediaPlaceholders(el));

              const authorEl = await el.$('[data-testid="User-Name"]');
              const authorText = await authorEl?.textContent() || '';
              const authorMatch = authorText.match(/(.+?)@(\w+)/);
              
              const timeEl = await el.$('time');
              const datetime = await timeEl?.getAttribute('datetime') || new Date().toISOString();
              
              const likeEl = await el.$('[data-testid="like"] span');
              const parseCount = (text: string | null | undefined): number => {
                if (!text) return 0;
                const num = text.replace(/[,K]/g, '');
                if (text.includes('K')) return parseFloat(num) * 1000;
                return parseInt(num) || 0;
              };

              const replyLikeCount = parseCount(await likeEl?.textContent());

              const reply: Reply = {
                id: replyId,
                text,
                authorId: authorMatch?.[2] || 'unknown',
                authorName: authorMatch?.[1]?.trim() || 'Unknown',
                authorHandle: authorMatch?.[2] || 'unknown',
                createdAt: datetime,
                likeCount: replyLikeCount,
                replyTo: tweet.id,
              };
              allReplies.push(reply);

              // 边爬边显：每抓到一条就通知（例如写入 DB，前端轮询即可看到）
              if (onReply) {
                try {
                  await Promise.resolve(onReply(reply));
                } catch (e) {
                  console.error('[Scraper] onReply error:', e);
                }
              }

              updateProgress({ 
                repliesFound: allReplies.length,
                message: `第 ${i + 1}/${tweets.length} 条推文，已获取 ${allReplies.length} 条评论...`
              });
            } catch (e) {
              // Skip this reply
            }
          }

          if (reachedEnd) break;

          // 若设置了每条推文评论上限且已达标，则停止
          const repliesForThisTweet = allReplies.length - repliesCountBeforeThisTweet;
          if (maxRepliesPerTweet > 0 && repliesForThisTweet >= maxRepliesPerTweet) {
            console.log(`[Scraper] Reached maxRepliesPerTweet=${maxRepliesPerTweet} for this tweet, stopping.`);
            break;
          }

          // 本轮是否有新评论：无则累计，连续多轮无新则视为到底
          if (allReplies.length === countBeforeScroll) {
            consecutiveScrollsWithNoNew++;
          } else {
            consecutiveScrollsWithNoNew = 0;
          }

          // Try to find "Show more replies" button
          try {
            const showMoreBtn = await page.$('div[role="button"]:has-text("Show more replies"), div[role="button"]:has-text("显示更多回复"), div[role="button"]:has-text("Show probable spam")');
            if (showMoreBtn && await showMoreBtn.isVisible()) {
              console.log('[Scraper] Clicking "Show more replies" button...');
              await showMoreBtn.click();
              await wait(2000);
              scrollBudget += 20; // 点击「更多」后多给一些滚动预算
            }
          } catch (e) {
            // Ignore button errors
          }

          await page.evaluate(() => window.scrollBy(0, 800));
          await wait(currentConfig.scrollDelay);
        }

        // 推文间延迟
        if (i < tweets.length - 1) {
          await wait(currentConfig.betweenTweetsDelay);
        }
      } catch (e) {
        console.error(`[Scraper] Failed to get replies for tweet ${tweet.id}:`, e);
      }
    }

    updateProgress({
      stage: 'complete',
      message: `采集完成！共获取 ${tweets.length} 条推文，${allReplies.length} 条评论`,
    });

    return { 
      success: true, 
      tweets, 
      replies: allReplies,
      progress,
    };
  } catch (error: any) {
    console.error('[Scraper] Error:', error);
    updateProgress({
      stage: 'error',
      message: `采集失败: ${error.message}`,
    });
    return { 
      success: false, 
      error: error.message,
      progress,
    };
  } finally {
    if (page) await page.close().catch(() => {});
    if (context) await context.close().catch(() => {});
  }
}

/** 仅爬取指定 Tweet ID 下的全部回复（全量，无高赞过滤） */
export async function scrapeRepliesByTweetId(
  tweetId: string,
  cookies?: string,
  onProgress?: ProgressCallback,
  onReply?: OnReplyCallback,
  onTweet?: OnTweetCallback
): Promise<ScrapeResult> {
  const useCookies = cookies || getNextAccountCookie();
  const progress: ScrapeProgress = {
    stage: 'init',
    message: '正在初始化...',
    tweetsFound: 0,
    repliesFound: 0,
    currentTweet: 1,
    totalTweets: 1,
    currentAccount: 0,
    totalAccounts: 1,
  };
  const updateProgress = (updates: Partial<ScrapeProgress>) => {
    Object.assign(progress, updates);
    onProgress?.(progress);
  };
  let context: BrowserContext | null = null;
  let page: Page | null = null;

  try {
    const proxyForMsg = (await getConfig('PLAYWRIGHT_PROXY'))?.trim() || process.env.HTTPS_PROXY || process.env.ALL_PROXY;
    if (proxyForMsg) {
      updateProgress({ message: `检测到代理配置: ${proxyForMsg}` });
    } else {
      updateProgress({ message: '正在启动浏览器...' });
    }
    context = await createContext(useCookies);
    page = await context.newPage();
    updateProgress({ message: `正在打开推文 ${tweetId}...` });

    const urlsToTry = [
      `https://x.com/i/status/${tweetId}`,
      `https://twitter.com/i/status/${tweetId}`,
    ];
    let gotoOk = false;
    for (const url of urlsToTry) {
      try {
        await gotoWithRetry(page, url, { waitUntil: 'domcontentloaded', timeout: 45000 }, 3);
        gotoOk = true;
        break;
      } catch (e: any) {
        const msg = String(e?.message || e);
        if (urlsToTry.indexOf(url) < urlsToTry.length - 1 && /ERR_CONNECTION|ERR_NETWORK|timeout/i.test(msg)) {
          await wait(2000);
          continue;
        }
        updateProgress({ stage: 'error', message: `连接失败: ${msg.slice(0, 80)}` });
        return {
          success: false,
          error: '连接被关闭或超时，请检查网络/代理后重试；若在中国大陆可尝试使用代理访问 X/Twitter。',
          progress,
        };
      }
    }
    // 给页面时间渲染（X 为 SPA，domcontentloaded 后仍会异步渲染推文）
    await wait(4000);
    const tweetSelector = 'article[data-testid="tweet"]';
    try {
      await page.waitForSelector(tweetSelector, { timeout: 25000 });
    } catch (e) {
      const bodyText = await page.evaluate(() => document.body?.innerText?.slice(0, 500) || '').catch(() => '');
      const needLogin = /log in|sign in|登录|登入/i.test(bodyText) && /something went wrong|wrong|try again/i.test(bodyText) === false;
      if (needLogin) {
        return { success: false, error: '当前未登录或 Cookie 已失效，请在设置中重新配置 X Cookie 后再试', progress };
      }
      if (/this tweet (is )?unavailable|推文不可用|no longer available/i.test(bodyText)) {
        return { success: false, error: '该推文不可用（可能已删除或仅限特定用户）', progress };
      }
      return { success: false, error: '无法加载该推文，请检查 ID、网络，并确认已配置有效 X Cookie', progress };
    }
    await wait(getScrapeConfig().pageLoadDelay);

    const articles = await page.$$('article[data-testid="tweet"]');
    if (articles.length === 0) {
      return { success: false, error: '页面上未找到推文', progress };
    }
    const first = articles[0];
    const tweetLink = await first.$('a[href*="/status/"]');
    const href = await tweetLink?.getAttribute('href');
    const parsedId = href?.match(/status\/(\d+)/)?.[1] || tweetId;
    const textEl = await first.$('[data-testid="tweetText"]');
    let text = await textEl?.textContent() || '';
    if (!text.trim()) {
      const card = await first.$('[data-testid="card.wrapper"]');
      if (card) {
        const cardTitleEl = await card.$('div[dir="auto"], span');
        const cardTitle = await cardTitleEl?.textContent();
        text = cardTitle ? `[链接] ${cardTitle.slice(0, 50)}` : '[链接]';
      }
    }
    text = text.trim() + (await getMediaPlaceholders(first));
    const authorEl = await first.$('[data-testid="User-Name"]');
    const authorText = await authorEl?.textContent() || '';
    const authorMatch = authorText.match(/(.+?)@(\w+)/);
    const timeEl = await first.$('time');
    const datetime = await timeEl?.getAttribute('datetime') || new Date().toISOString();
    const likeEl = await first.$('[data-testid="like"] span');
    const replyEl = await first.$('[data-testid="reply"] span');
    const retweetEl = await first.$('[data-testid="retweet"] span');
    const parseCount = (t: string | null | undefined): number => {
      if (!t) return 0;
      const num = t.replace(/[,K]/g, '');
      if (t.includes('K')) return parseFloat(num) * 1000;
      return parseInt(num) || 0;
    };
    const rootTweet: Tweet = {
      id: parsedId,
      text,
      authorName: authorMatch?.[1]?.trim() || 'Unknown',
      authorHandle: authorMatch?.[2] || 'unknown',
      createdAt: datetime,
      likeCount: parseCount(await likeEl?.textContent()),
      replyCount: parseCount(await replyEl?.textContent()),
      retweetCount: parseCount(await retweetEl?.textContent()),
    };
    if (onTweet) {
      try { await Promise.resolve(onTweet(rootTweet)); } catch (e) { console.error('[Scraper] onTweet error:', e); }
    }

    updateProgress({ stage: 'fetching_replies', message: '正在获取该推文下全部评论...' });
    try {
      const latestTab = page.locator('a[role="tab"]').filter({ hasText: /Latest|最新/i }).first();
      if ((await latestTab.count()) > 0) {
        await latestTab.click();
        await wait(2000);
      }
    } catch (_) {}

    const allReplies: Reply[] = [];
    const seenReplyIds = new Set<string>([rootTweet.id]);
    let lastReportedCount = 0;
    const replyScrollDelayMs = 4800; // 评论区滚动后多等，网络慢时懒加载也能出来

    const processArticleList = async (replyElements: Awaited<ReturnType<Page['$$']>>, cutoffY: number) => {
      for (const el of replyElements) {
        try {
          const box = await el.boundingBox();
          if (box && box.y > cutoffY) break;
          const replyLink = await el.$('a[href*="/status/"]');
          const hrefR = await replyLink?.getAttribute('href');
          const replyId = hrefR?.match(/status\/(\d+)/)?.[1];
          if (!replyId || seenReplyIds.has(replyId)) continue;

          seenReplyIds.add(replyId);
          const textElR = await el.$('[data-testid="tweetText"]');
          let textR = (await textElR?.textContent() || '').trim() + (await getMediaPlaceholders(el));
          const authorElR = await el.$('[data-testid="User-Name"]');
          const authorTextR = await authorElR?.textContent() || '';
          const authorMatchR = authorTextR.match(/(.+?)@(\w+)/);
          const timeElR = await el.$('time');
          const datetimeR = await timeElR?.getAttribute('datetime') || new Date().toISOString();
          const likeElR = await el.$('[data-testid="like"] span');
          const parseCountR = (t: string | null | undefined): number => {
            if (!t) return 0;
            const num = t.replace(/[,K]/g, '');
            if (t.includes('K')) return parseFloat(num) * 1000;
            return parseInt(num) || 0;
          };
          const reply: Reply = {
            id: replyId,
            text: textR,
            authorId: authorMatchR?.[2] || 'unknown',
            authorName: authorMatchR?.[1]?.trim() || 'Unknown',
            authorHandle: authorMatchR?.[2] || 'unknown',
            createdAt: datetimeR,
            likeCount: parseCountR(await likeElR?.textContent()),
            replyTo: rootTweet.id,
          };
          allReplies.push(reply);
          if (onReply) {
            try { await Promise.resolve(onReply(reply)); } catch (e) { console.error('[Scraper] onReply error:', e); }
          }
          if (allReplies.length > lastReportedCount) {
            lastReportedCount = allReplies.length;
            updateProgress({ repliesFound: lastReportedCount, message: `已获取 ${lastReportedCount} 条评论` });
          }
        } catch (_) {}
      }
    };

    // 第一阶段：常规滚动 + 狂点「显示更多」（参数偏保守，网络慢也能采全）
    let consecutiveScrollsWithNoNew = 0;
    const maxScrollsWithNoNew = 40;
    let scrollBudget = 1800;

    while (consecutiveScrollsWithNoNew < maxScrollsWithNoNew && scrollBudget > 0) {
      scrollBudget--;
      const countBeforeScroll = allReplies.length;
      const replyElements = await page.$$('article[data-testid="tweet"]');
      const cutoffY = await getCutoffY(page);
      await processArticleList(replyElements, cutoffY);
      if (allReplies.length > lastReportedCount) {
        lastReportedCount = allReplies.length;
        updateProgress({ repliesFound: lastReportedCount, message: `已获取 ${lastReportedCount} 条评论` });
      }

      if (allReplies.length === countBeforeScroll) {
        consecutiveScrollsWithNoNew++;
      } else {
        consecutiveScrollsWithNoNew = 0;
      }

      // 尽量点光所有「显示更多」类按钮（多语言、多种文案）
      for (let i = 0; i < 8; i++) {
        try {
          const showMore = page.locator('div[role="button"]').filter({ hasText: /Show more|显示更多|more replies|更多回复|View more|Load more|See more|probable spam|可能为垃圾/i }).first();
          if ((await showMore.count()) > 0 && await showMore.isVisible()) {
            await showMore.scrollIntoViewIfNeeded();
            await wait(600);
            await showMore.click();
            await wait(4000);
            scrollBudget += 20;
            consecutiveScrollsWithNoNew = 0;
          } else break;
        } catch (_) { break; }
      }

      const articles = await page.$$('article[data-testid="tweet"]');
      if (articles.length > 0) {
        try {
          await articles[articles.length - 1].scrollIntoViewIfNeeded();
          await wait(1500);
        } catch (_) {}
      }
      await page.evaluate(() => {
        window.scrollBy(0, 1600);
        const col = document.querySelector('[data-testid="primaryColumn"]');
        if (col && (col as HTMLElement).scrollHeight > (col as HTMLElement).clientHeight) {
          (col as HTMLElement).scrollTop = (col as HTMLElement).scrollHeight;
        }
        const doc = document.documentElement;
        const maxScroll = Math.max(doc.scrollHeight, doc.scrollTop + 1600);
        window.scrollTo(0, maxScroll);
      });
      await wait(replyScrollDelayMs);
    }

    // 第二阶段：反复滚到页面最底部再采集，专门收尾懒加载（多轮多等，网络慢也能采全）
    updateProgress({ message: `已获取 ${allReplies.length} 条，继续滚到底部查漏...` });
    let bottomNoNewCount = 0;
    const maxBottomNoNew = 20;
    for (let round = 0; round < 120 && bottomNoNewCount < maxBottomNoNew; round++) {
      const countBefore = allReplies.length;
      await page.evaluate(() => {
        const h = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
        window.scrollTo(0, h);
      });
      await wait(replyScrollDelayMs);
      const replyElements = await page.$$('article[data-testid="tweet"]');
      const cutoffY = await getCutoffY(page);
      await processArticleList(replyElements, cutoffY);
      if (allReplies.length > lastReportedCount) {
        lastReportedCount = allReplies.length;
        updateProgress({ repliesFound: lastReportedCount, message: `已获取 ${lastReportedCount} 条评论` });
      }
      if (allReplies.length === countBefore) {
        bottomNoNewCount++;
      } else {
        bottomNoNewCount = 0;
      }
    }

    updateProgress({ stage: 'complete', message: `采集完成！共获取 ${allReplies.length} 条评论` });
    return { success: true, tweets: [rootTweet], replies: allReplies, progress };
  } catch (error: any) {
    console.error('[Scraper] scrapeRepliesByTweetId error:', error);
    updateProgress({ stage: 'error', message: `采集失败: ${error.message}` });
    return { success: false, error: error.message, progress };
  } finally {
    if (page) await page.close().catch(() => {});
    if (context) await context.close().catch(() => {});
  }
}

// 关闭浏览器
export async function closeBrowser(): Promise<void> {
  if (browserInstance) {
    await browserInstance.close().catch(() => {});
    browserInstance = null;
  }
}
