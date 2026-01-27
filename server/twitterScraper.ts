import { chromium, Browser, BrowserContext, Page } from 'playwright';

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

let browserInstance: Browser | null = null;

async function getBrowser(): Promise<Browser> {
  if (!browserInstance || !browserInstance.isConnected()) {
    // 尝试多种方式启动浏览器
    const possiblePaths = [
      // chromium_headless_shell (Playwright 默认使用)
      '/root/.cache/ms-playwright/chromium_headless_shell-1208/chrome-headless-shell-linux64/chrome-headless-shell',
      '/home/ubuntu/.cache/ms-playwright/chromium_headless_shell-1208/chrome-headless-shell-linux64/chrome-headless-shell',
      // chromium (备选)
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
          console.log('[Playwright] Found browser at:', p);
          break;
        }
      } catch (e) {
        // Continue
      }
    }

    try {
      // 优先使用找到的路径
      if (executablePath) {
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
      } else {
        // 回退到默认启动方式
        console.log('[Playwright] No custom path found, using default launch');
        browserInstance = await chromium.launch({
          headless: true,
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
    } catch (launchError: any) {
      console.error('[Playwright] Launch failed:', launchError.message);
      throw new Error(`Playwright 浏览器启动失败: ${launchError.message}。请确保已安装浏览器 (npx playwright install chromium)`);
    }
  }
  return browserInstance;
}

async function createContext(cookies?: string): Promise<BrowserContext> {
  const browser = await getBrowser();
  
  const userAgents = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
  ];
  const randomUserAgent = userAgents[Math.floor(Math.random() * userAgents.length)];
  
  const context = await browser.newContext({
    userAgent: randomUserAgent,
    viewport: { width: 1280 + Math.floor(Math.random() * 200), height: 800 + Math.floor(Math.random() * 100) },
    locale: 'en-US',
  });

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

// 主要爬取函数 - 支持进度回调
export async function scrapeUserComments(
  username: string,
  maxTweets: number = 10,
  cookies?: string,
  onProgress?: ProgressCallback
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
    updateProgress({ stage: 'loading', message: '正在启动浏览器...' });
    
    context = await createContext(useCookies);
    page = await context.newPage();
    
    updateProgress({ message: `正在访问 @${username} 的主页...` });
    
    // 访问用户主页
    await page.goto(`https://x.com/${username}`, { waitUntil: 'networkidle', timeout: 30000 });
    await wait(currentConfig.pageLoadDelay);

    // 检查是否需要登录
    const loginButton = await page.$('a[href="/login"]');
    if (loginButton && !useCookies) {
      updateProgress({ stage: 'error', message: '需要登录才能查看内容' });
      return { success: false, error: '需要登录才能查看完整内容，请在设置中配置 X Cookie', progress };
    }

    updateProgress({ stage: 'fetching_tweets', message: '正在获取推文列表...' });

    // 获取推文
    const tweets: Tweet[] = [];
    let scrollCount = 0;
    const maxScrolls = Math.ceil(maxTweets / 3) + 5;

    while (tweets.length < maxTweets && scrollCount < maxScrolls) {
      const tweetElements = await page.$$('article[data-testid="tweet"]');
      
      for (const el of tweetElements) {
        if (tweets.length >= maxTweets) break;
        
        try {
          const tweetLink = await el.$('a[href*="/status/"]');
          const href = await tweetLink?.getAttribute('href');
          const tweetId = href?.match(/status\/(\d+)/)?.[1];
          
          if (!tweetId || tweets.some(t => t.id === tweetId)) continue;

          const textEl = await el.$('[data-testid="tweetText"]');
          const text = await textEl?.textContent() || '';
          
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

      try {
        await page.goto(`https://x.com/${tweet.authorHandle}/status/${tweet.id}`, { 
          waitUntil: 'networkidle', 
          timeout: 30000 
        });
        await wait(currentConfig.pageLoadDelay);

        // 滚动加载评论
        let replyScrollCount = 0;
        const maxReplyScrolls = 5;
        
        while (replyScrollCount < maxReplyScrolls) {
          const replyElements = await page.$$('article[data-testid="tweet"]');
          
          for (const el of replyElements) {
            try {
              const replyLink = await el.$('a[href*="/status/"]');
              const href = await replyLink?.getAttribute('href');
              const replyId = href?.match(/status\/(\d+)/)?.[1];
              
              // 跳过原推文
              if (!replyId || replyId === tweet.id || allReplies.some(r => r.id === replyId)) continue;

              const textEl = await el.$('[data-testid="tweetText"]');
              const text = await textEl?.textContent() || '';
              
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

              allReplies.push({
                id: replyId,
                text,
                authorId: authorMatch?.[2] || 'unknown',
                authorName: authorMatch?.[1]?.trim() || 'Unknown',
                authorHandle: authorMatch?.[2] || 'unknown',
                createdAt: datetime,
                likeCount: parseCount(await likeEl?.textContent()),
                replyTo: tweet.id,
              });

              updateProgress({ 
                repliesFound: allReplies.length,
                message: `第 ${i + 1}/${tweets.length} 条推文，已获取 ${allReplies.length} 条评论...`
              });
            } catch (e) {
              // Skip this reply
            }
          }

          await page.evaluate(() => window.scrollBy(0, 600));
          await wait(currentConfig.scrollDelay);
          replyScrollCount++;
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

// 关闭浏览器
export async function closeBrowser(): Promise<void> {
  if (browserInstance) {
    await browserInstance.close().catch(() => {});
    browserInstance = null;
  }
}
