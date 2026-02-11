import puppeteer from 'puppeteer-core';
import chromium from '@sparticuz/chromium';
import { getConfig } from './db';
import type { Browser, Page, BrowserContext as PuppeteerBrowserContext, ElementHandle } from 'puppeteer-core';
import fs from 'node:fs';

async function elGetAttribute(handle: ElementHandle<Element> | null, name: string): Promise<string | null> {
  if (!handle) return null;
  return handle.evaluate((el, attr) => (el as HTMLElement).getAttribute(attr), name);
}
async function elTextContent(handle: ElementHandle<Element> | null): Promise<string> {
  if (!handle) return '';
  return (await handle.evaluate((el) => (el as HTMLElement).textContent)) ?? '';
}

// Extract status id from a tweet article. Prefer the anchor that contains <time>.
async function extractStatusIdFromArticle(
  articleEl: ElementHandle<Element>,
  rootTweetId?: string
): Promise<string | null> {
  try {
    return await articleEl.evaluate((el, rootId) => {
      const anchors = Array.from(el.querySelectorAll('a[href*="/status/"]')) as HTMLAnchorElement[];
      const ids = anchors
        .map((a) => (a.getAttribute('href') || '').match(/status\/(\d+)/)?.[1] || null)
        .filter((id): id is string => !!id);

      if (ids.length === 0) return null;

      const timeAnchor = anchors.find((a) => a.querySelector('time'));
      const timeId = (timeAnchor?.getAttribute('href') || '').match(/status\/(\d+)/)?.[1] || null;
      if (timeId && (!rootId || timeId !== rootId || ids.length === 1)) return timeId;

      if (rootId) {
        const nonRoot = ids.find((id) => id !== rootId);
        if (nonRoot) return nonRoot;
      }

      return ids[ids.length - 1] || null;
    }, rootTweetId ?? null);
  } catch {
    return null;
  }
}


/** Context-like wrapper: creates pages with viewport/cookies set (Puppeteer has no context options). */
export interface ScraperContext {
  newPage(): Promise<Page>;
  close(): Promise<void>;
}

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
  options: { waitUntil?: 'domcontentloaded' | 'load'; timeout?: number } = {},
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

// 閲囬泦杩涘害
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

// 鐖彇閫熷害閰嶇疆
export interface ScrapeConfig {
  pageLoadDelay: number;
  scrollDelay: number;
  betweenTweetsDelay: number;
  randomDelay: boolean;
  randomDelayRange: [number, number];
}

export type ReplySortMode = 'recent' | 'top';

export interface ReplyScrapeOptions {
  sortMode?: ReplySortMode;
  expandFoldedReplies?: boolean;
}

// 榛樿閰嶇疆 - 淇濆畧妯″紡
export const DEFAULT_SCRAPE_CONFIG: ScrapeConfig = {
  pageLoadDelay: 3000,
  scrollDelay: 2500,
  betweenTweetsDelay: 5000,
  randomDelay: true,
  randomDelayRange: [1000, 3000],
};

// 棰勮閰嶇疆
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

// 澶氳处鍙?Cookie 绠＄悊
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

/** Puppeteer: click first element matching selector whose text matches regex. */
async function clickByText(page: Page, selector: string, textPattern: string, flags = 'i'): Promise<boolean> {
  const handle = await page.evaluateHandle((sel, patternStr, f) => {
    const re = new RegExp(patternStr, f);
    const nodes = document.querySelectorAll(sel);
    for (const el of Array.from(nodes)) {
      if (re.test((el.textContent || '').trim())) return el;
    }
    return null;
  }, selector, textPattern, flags);
  try {
    const el = handle.asElement() as import('puppeteer-core').ElementHandle<Element> | null;
    if (!el) return false;
    await el.click();
    return true;
  } finally {
    await handle.dispose().catch(() => {});
  }
}

const EXPAND_REPLY_BUTTON_PATTERN =
  'Show more replies|Show more|Show additional replies|Show hidden replies|more replies|View more|Load more|See more|Show probable spam|显示更多|更多回复|查看更多回复|展开更多回复|可能为垃圾';

async function switchReplySortTab(page: Page, sortMode: ReplySortMode): Promise<boolean> {
  const pattern =
    sortMode === 'top'
      ? 'Top|Most relevant|热门|最相关'
      : 'Recent|Latest|Most recent|最新|最近';
  if (await clickByText(page, 'a[role="tab"]', pattern)) return true;
  return clickByText(page, 'div[role="tab"]', pattern);
}

// Helper to find the Y position of the "More tweets" / recommendation divider (Puppeteer: no text selectors, use evaluate)
async function getCutoffY(page: Page): Promise<number> {
  try {
    const y = await page.evaluate(() => {
      const primary = document.querySelector('[data-testid="primaryColumn"]');
      if (!primary) return Infinity;

      const markerPatterns = [
        /^More posts$/i,
        /^More tweets$/i,
        /^Discover more$/i,
        /^You might like$/i,
        /^Related posts$/i,
        /^更多推文$/,
        /^更多帖子$/,
        /^发现更多$/,
        /^你可能喜欢$/,
        /^相关帖子$/,
      ];

      let cutoff = Infinity;
      const nodes = primary.querySelectorAll('div[role="heading"], h1, h2, div[dir="auto"], span');
      for (const el of Array.from(nodes)) {
        const text = (el.textContent || '').trim();
        if (!markerPatterns.some((pattern) => pattern.test(text))) continue;
        const rect = (el as Element).getBoundingClientRect();
        const absY = rect.top + window.scrollY;
        if (absY <= window.scrollY + 250) continue;
        if (absY < cutoff) cutoff = absY;
      }
      return cutoff;
    });
    return typeof y === 'number' ? y : Infinity;
  } catch {
    return Infinity;
  }
}

// Detect login wall on tweet detail pages where replies are gated.
async function hasReplyLoginWall(page: Page): Promise<boolean> {
  try {
    return await page.evaluate(() => {
      const text = document.body?.innerText || '';
      const hasLoginPrompt = /(log in|sign in|登录|登入|注册|创建账号)/i.test(text);
      const hasReplyEntry = /(查看\s*\d+\s*条回复|view\s*\d+\s*repl(y|ies))/i.test(text);
      const tweetCards = document.querySelectorAll('article[data-testid="tweet"]').length;
      return hasLoginPrompt && hasReplyEntry && tweetCards <= 2;
    });
  } catch {
    return false;
  }
}

// Detect media in tweet/reply and append placeholders like [图片] [视频].
async function getMediaPlaceholders(articleEl: import('puppeteer-core').ElementHandle): Promise<string> {
  let s = '';
  try {
    const photo = await articleEl.$('[data-testid="tweetPhoto"]');
    if (photo) { s += ' [图片]'; }
    const videoPlayer = await articleEl.$('[data-testid="videoPlayer"]');
    if (videoPlayer) { s += ' [视频]'; }
    if (!s.includes('[视频]')) {
      const videoTag = await articleEl.$('video');
      if (videoTag) { s += ' [视频]'; }
    }
  } catch (_) { /* ignore */ }
  return s;
}

let browserInstance: Browser | null = null;

function findLocalChromePath(): string | undefined {
  if (process.env.CHROME_EXECUTABLE_PATH) {
    return process.env.CHROME_EXECUTABLE_PATH;
  }

  const candidates =
    process.platform === 'win32'
      ? [
          'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
          'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
          'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
          'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
        ]
      : process.platform === 'darwin'
      ? [
          '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
          '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
        ]
      : [
          '/usr/bin/google-chrome',
          '/usr/bin/google-chrome-stable',
          '/usr/bin/chromium',
          '/usr/bin/chromium-browser',
          '/usr/bin/microsoft-edge',
        ];

  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return undefined;
}

/** Launch browser using @sparticuz/chromium (works in serverless/slim containers). */
async function getBrowser(): Promise<Browser> {
  if (!browserInstance || !browserInstance.connected) {
    const configProxy = await getConfig('PLAYWRIGHT_PROXY');
    const proxyServer = (configProxy?.trim() || '') || process.env.HTTPS_PROXY || process.env.ALL_PROXY || process.env.http_proxy || process.env.https_proxy;
    const useSparticuz = process.env.NODE_ENV === 'production' && process.platform === 'linux';
    const launchCandidates: Array<{ label: string; opts: Parameters<typeof puppeteer.launch>[0] }> = [];

    if (useSparticuz) {
      launchCandidates.push({
        label: '@sparticuz/chromium',
        opts: {
          args: chromium.args,
          defaultViewport: chromium.defaultViewport,
          executablePath: await chromium.executablePath(),
          headless: chromium.headless,
        },
      });
    }

    const localPath = findLocalChromePath();
    if (localPath) {
      launchCandidates.push({
        label: `local browser (${localPath})`,
        opts: {
          executablePath: localPath,
          headless: true,
          args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
        },
      });
    } else if (!useSparticuz) {
      launchCandidates.push({
        label: 'chrome channel',
        opts: {
          channel: 'chrome',
          headless: true,
          args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
        },
      });
    }

    if (launchCandidates.length === 0) {
      throw new Error('No browser candidate found. Please set CHROME_EXECUTABLE_PATH.');
    }

    let lastError: unknown = null;
    for (const candidate of launchCandidates) {
      try {
        const opts = { ...candidate.opts };
        if (proxyServer) (opts as any).args = [...(opts.args || []), `--proxy-server=${proxyServer}`];
        console.log(`[Scraper] Launching browser with ${candidate.label}...`);
        browserInstance = await withTimeout(puppeteer.launch(opts), 30000, 'Browser launch timed out');
        console.log(`[Scraper] Browser launched successfully via ${candidate.label}`);
        break;
      } catch (error) {
        lastError = error;
        console.warn(`[Scraper] Browser launch failed via ${candidate.label}:`, error);
      }
    }

    if (!browserInstance) {
      throw new Error(`Browser launch failed for all candidates: ${String((lastError as any)?.message || lastError)}`);
    }
  }
  return browserInstance;
}

async function createContext(cookies?: string): Promise<ScraperContext> {
  console.log('[Scraper] Creating context...');
  const browser = await getBrowser();

  const userAgent = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
  ][Math.floor(Math.random() * 3)];
  const viewport = { width: 1280 + Math.floor(Math.random() * 200), height: 800 + Math.floor(Math.random() * 100) };

  const configProxy = await getConfig('PLAYWRIGHT_PROXY');
  const proxyServer = (configProxy?.trim() || '') || process.env.HTTPS_PROXY || process.env.ALL_PROXY || process.env.http_proxy || process.env.https_proxy;
  if (proxyServer) console.log('[Scraper] Context using proxy:', proxyServer);

  const rawContext = await withTimeout(
    browser.createBrowserContext(),
    30000,
    'Context creation timed out after 30s'
  );
  const ctx = rawContext as PuppeteerBrowserContext;

  const cookieList: Array<{ name: string; value: string; domain?: string; path?: string }> = [];
  if (cookies) {
    try {
      const cookieArray = JSON.parse(cookies);
      if (Array.isArray(cookieArray)) {
        for (const c of cookieArray) {
          cookieList.push({
            name: c.name,
            value: c.value,
            domain: c.domain || '.x.com',
            path: c.path || '/',
          });
        }
      }
    } catch (e) {
      console.error('[Scraper] Failed to parse cookies:', e);
    }
  }

  const wrapper: ScraperContext = {
    async newPage() {
      const page = await ctx.newPage();
      await page.setViewport(viewport);
      await page.setUserAgent(userAgent);
      await page.setBypassCSP(true);
      if (cookieList.length) await page.setCookie(...cookieList);
      return page;
    },
    async close() {
      await ctx.close();
    },
  };
  console.log('[Scraper] Context created successfully');
  return wrapper;
}

// 杩涘害鍥炶皟绫诲瀷
export type ProgressCallback = (progress: ScrapeProgress) => void;

// 鍗曟潯璇勮鍥炶皟锛氭瘡鐖埌涓€鏉¤瘎璁烘椂璋冪敤锛屼究浜庛€岃竟鐖竟鏄俱€?
export type OnReplyCallback = (reply: Reply) => void | Promise<void>;
// 鏍规帹鏂囧洖璋冿細鍦ㄦ姄鍙栨煇鏉℃帹鏂囩殑鍥炲涔嬪墠璋冪敤锛屼究浜庡厛鍐欏叆鐖舵帹鏂囷紝鍒楄〃鎸?rootTweetAuthor 杩囨护鏃惰兘绔嬪嵆鐪嬪埌鏂板洖澶?
export type OnTweetCallback = (tweet: Tweet) => void | Promise<void>;

// 涓昏鐖彇鍑芥暟 - 鏀寔杩涘害鍥炶皟銆佸崟鏉¤瘎璁哄洖璋冨拰鏍规帹鏂囧洖璋?
// maxRepliesPerTweet: 姣忔潯鎺ㄦ枃鏈€澶氭媺鍙栫殑璇勮鏁帮紱0 鎴栦笉浼犺〃绀轰笉闄愬埗锛岀洿鍒拌繛缁杞粴鍔ㄦ棤鏂拌瘎璁轰负姝?
export async function scrapeUserComments(
  username: string,
  maxTweets: number = 10,
  cookies?: string,
  onProgress?: ProgressCallback,
  onReply?: OnReplyCallback,
  onTweet?: OnTweetCallback,
  maxRepliesPerTweet: number = 0,
  options: ReplyScrapeOptions = {}
): Promise<ScrapeResult> {
  // 浣跨敤浼犲叆鐨?cookies 鎴栬疆鎹㈣处鍙?
  const useCookies = cookies || getNextAccountCookie();
  const accountIndex = cookies ? 0 : getCurrentAccountIndex();
  const totalAccounts = cookies ? 1 : Math.max(1, getAccountCount());
  const replySortMode = options.sortMode ?? 'recent';
  const expandFoldedReplies = options.expandFoldedReplies === true;
  
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

  let context: ScraperContext | null = null;
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
      updateProgress({ message: '未检测到代理，将尝试直连...' });
      await wait(500);
    }

    updateProgress({ message: '正在启动浏览器内核...' });
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
    
    updateProgress({ message: `正在导航到 @${username} 主页...` });
    console.log(`[Scraper] Navigating to https://x.com/${username}`);
    
    // 璁块棶鐢ㄦ埛涓婚〉锛堜娇鐢ㄩ噸璇?+ 鏇撮暱瓒呮椂锛寈.com 缁忓父杈冩參鎴栧伓鍙戣秴鏃讹級
    try {
      await gotoWithRetry(page, `https://x.com/${username}`, { waitUntil: 'domcontentloaded', timeout: 60000 }, 3);
    } catch (navError: any) {
      const msg = String(navError?.message || navError);
      if (msg.includes('ERR_CONNECTION_CLOSED') || msg.includes('ERR_CONNECTION_REFUSED') || msg.includes('net::ERR')) {
        throw new Error(
          '无法连接 X (x.com)：连接被关闭或拒绝。请检查网络或代理配置后重试。'
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

    // 妫€鏌ユ槸鍚﹂渶瑕佺櫥褰?
    try {
        const loginButton = await page.waitForSelector('a[href*="/login"]', { timeout: 3000 }).catch(() => null);
        const signInText = await page.evaluate(() =>
          Array.from(document.querySelectorAll('*')).some(el => (el.textContent || '').trim() === 'Sign in to X')
        ).catch(() => false);
        
        if ((loginButton || signInText) && !useCookies) {
          console.warn('[Scraper] Login required detected');
          updateProgress({ stage: 'error', message: '需要登录才能查看内容' });
          return { success: false, error: '需要登录才能查看完整内容，请在设置中配置 X Cookie', progress };
        }
    } catch (e) {
        // Ignore errors during login check
    }

    updateProgress({ stage: 'fetching_tweets', message: '正在获取推文列表...' });

    // 鑾峰彇鎺ㄦ枃
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
          if (box && Number.isFinite(cutoffY) && box.y > cutoffY) {
              console.log('[Scraper] Reached "More tweets" section, stopping profile scrape.');
              reachedEnd = true;
              break; // Stop processing current batch
          }

          const tweetId = await extractStatusIdFromArticle(el);
          
          if (!tweetId) {
             console.log('[Scraper] Skipped tweet element: No ID found');
             continue;
          }
          if (tweets.some(t => t.id === tweetId)) {
             // console.log(`[Scraper] Skipped duplicate tweet: ${tweetId}`);
             continue;
          }

          const textEl = await el.$('[data-testid="tweetText"]');
          let text = await elTextContent(textEl ?? null) || '';
          // 鏃犳鏂囨椂鐢ㄥ崱鐗囨爣棰樺崰浣?
          if (!text.trim()) {
             const card = await el.$('[data-testid="card.wrapper"]');
             if (card) {
                 const cardTitleEl = await card.$('div[dir="auto"][style*="color: rgb(15, 20, 25)"], span');
                 const cardTitle = await elTextContent(cardTitleEl ?? null);
                 if (cardTitle) text = `[链接] ${cardTitle.slice(0, 50)}`;
                 else text = '[链接]';
             }
          }
          text = text.trim() + (await getMediaPlaceholders(el));

          const authorEl = await el.$('[data-testid="User-Name"]');
          const authorText = await elTextContent(authorEl ?? null) || '';
          const authorMatch = authorText.match(/(.+?)@(\w+)/);
          
          const timeEl = await el.$('time');
          const datetime = (await elGetAttribute(timeEl ?? null, 'datetime')) || new Date().toISOString();
          
          // 鑾峰彇浜掑姩鏁版嵁
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
            likeCount: parseCount(await elTextContent(likeEl ?? null)),
            replyCount: parseCount(await elTextContent(replyEl ?? null)),
            retweetCount: parseCount(await elTextContent(retweetEl ?? null)),
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

    // 鑾峰彇姣忔潯鎺ㄦ枃鐨勮瘎璁?
    const allReplies: Reply[] = [];
    
    for (let i = 0; i < tweets.length; i++) {
      const tweet = tweets[i];
      updateProgress({
        currentTweet: i + 1,
        message: `正在获取第 ${i + 1}/${tweets.length} 条推文的评论...`
      });

      // 鍏堝啓鍏ユ牴鎺ㄦ枃锛岃繖鏍锋寜 rootTweetAuthor 杩囨护鐨勫垪琛ㄨ兘绔嬪嵆鏄剧ず鍗冲皢鎶撳彇鐨勫洖澶嶏紙杈圭埇杈规樉锛?
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

        if (await hasReplyLoginWall(page)) {
          const errorMsg = '当前会话无法展开评论（登录墙拦截）。请在设置中重新配置有效的 X Cookie 后重试。';
          updateProgress({ stage: 'error', message: errorMsg });
          return { success: false, error: errorMsg, progress };
        }

        // Prefer requested reply sort tab before scraping.
        try {
          if (await switchReplySortTab(page, replySortMode)) {
            await wait(2000);
            console.log(`[Scraper] Switched reply sort tab to ${replySortMode}.`);
          }
        } catch (_) { /* ignore */ }

        // 婊氬姩鍔犺浇璇勮锛氭棤鏂拌瘎璁哄垯鍋?鎴?杈惧埌 maxRepliesPerTweet
        const repliesCountBeforeThisTweet = allReplies.length;
        let consecutiveScrollsWithNoNew = 0;
        const maxScrollsWithNoNew = 8; // 杩炵画 8 杞棤鏂拌瘎璁烘墠鍋滐紙鎱㈢綉缁滄椂鏇寸ǔ锛?
        let scrollBudget = 500; // 鍗曟潯鎺ㄦ枃鏈€澶氭粴鍔ㄨ疆鏁帮紙闃叉姝诲惊鐜級
        
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
              if (box && Number.isFinite(cutoffY) && box.y > cutoffY) {
                  console.log('[Scraper] Reached "More tweets" recommendations, stopping reply scrape.');
                  reachedEnd = true;
                  break;
              }

              const replyId = await extractStatusIdFromArticle(el, tweet.id);
              
              // 璺宠繃鍘熸帹鏂?
              if (!replyId || replyId === tweet.id || allReplies.some(r => r.id === replyId)) continue;

              const textEl = await el.$('[data-testid="tweetText"]');
              let text = (await elTextContent(textEl ?? null) || '').trim() + (await getMediaPlaceholders(el));

              const authorEl = await el.$('[data-testid="User-Name"]');
              const authorText = await elTextContent(authorEl ?? null) || '';
              const authorMatch = authorText.match(/(.+?)@(\w+)/);
              
              const timeEl = await el.$('time');
              const datetime = (await elGetAttribute(timeEl ?? null, 'datetime')) || new Date().toISOString();
              
              const likeEl = await el.$('[data-testid="like"] span');
              const parseCount = (text: string | null | undefined): number => {
                if (!text) return 0;
                const num = text.replace(/[,K]/g, '');
                if (text.includes('K')) return parseFloat(num) * 1000;
                return parseInt(num) || 0;
              };

              const replyLikeCount = parseCount(await elTextContent(likeEl ?? null));

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

              // 杈圭埇杈规樉锛氭瘡鎶撳埌涓€鏉″氨閫氱煡锛堜緥濡傚啓鍏?DB锛屽墠绔疆璇㈠嵆鍙湅鍒帮級
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

          // 鑻ヨ缃簡姣忔潯鎺ㄦ枃璇勮涓婇檺涓斿凡杈炬爣锛屽垯鍋滄
          const repliesForThisTweet = allReplies.length - repliesCountBeforeThisTweet;
          if (maxRepliesPerTweet > 0 && repliesForThisTweet >= maxRepliesPerTweet) {
            console.log(`[Scraper] Reached maxRepliesPerTweet=${maxRepliesPerTweet} for this tweet, stopping.`);
            break;
          }

          // 鏈疆鏄惁鏈夋柊璇勮锛氭棤鍒欑疮璁★紝杩炵画澶氳疆鏃犳柊鍒欒涓哄埌搴?
          if (allReplies.length === countBeforeScroll) {
            consecutiveScrollsWithNoNew++;
          } else {
            consecutiveScrollsWithNoNew = 0;
          }

          if (expandFoldedReplies) {
            // Optionally expand folded replies / spam-filtered branches.
            try {
              const clicked = await clickByText(page, 'div[role="button"]', EXPAND_REPLY_BUTTON_PATTERN);
              if (clicked) {
                console.log('[Scraper] Clicking "show more replies" button...');
                await wait(2000);
                scrollBudget += 20;
              }
            } catch (e) {
              // Ignore button errors
            }
          }

          await page.evaluate(() => window.scrollBy(0, 800));
          await wait(currentConfig.scrollDelay);
        }

        // 鎺ㄦ枃闂村欢杩?
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

/** 浠呯埇鍙栨寚瀹?Tweet ID 涓嬬殑鍏ㄩ儴鍥炲锛堝叏閲忥紝鏃犻珮璧炶繃婊わ級 */
export async function scrapeRepliesByTweetId(
  tweetId: string,
  cookies?: string,
  onProgress?: ProgressCallback,
  onReply?: OnReplyCallback,
  onTweet?: OnTweetCallback,
  options: ReplyScrapeOptions = {}
): Promise<ScrapeResult> {
  const isDevMode = process.env.NODE_ENV !== 'production';
  const replyScrollDelayMs = Number(
    process.env.SCRAPER_REPLY_SCROLL_DELAY_MS ?? (isDevMode ? 1200 : 4800)
  );
  const maxScrollsWithNoNewLimit = Number(
    process.env.SCRAPER_MAX_SCROLLS_NO_NEW ?? (isDevMode ? 10 : 40)
  );
  const initialScrollBudget = Number(
    process.env.SCRAPER_SCROLL_BUDGET ?? (isDevMode ? 120 : 1800)
  );
  const maxBottomNoNew = Number(
    process.env.SCRAPER_BOTTOM_NO_NEW ?? (isDevMode ? 6 : 20)
  );
  const maxBottomRounds = Number(
    process.env.SCRAPER_BOTTOM_ROUNDS ?? (isDevMode ? 30 : 120)
  );
  const replySortMode = options.sortMode ?? 'recent';
  const expandFoldedReplies = options.expandFoldedReplies === true;

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
  let context: ScraperContext | null = null;
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
          error: '连接被关闭或超时，请检查网络或代理后重试。',
          progress,
        };
      }
    }
    // 缁欓〉闈㈡椂闂存覆鏌擄紙X 涓?SPA锛宒omcontentloaded 鍚庝粛浼氬紓姝ユ覆鏌撴帹鏂囷級
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
        return { success: false, error: '该推文不可用（可能已删除或仅限特定用户可见）', progress };
      }
      return { success: false, error: '无法加载该推文，请检查 Tweet ID、网络，并确认已配置有效 X Cookie', progress };
    }
    await wait(getScrapeConfig().pageLoadDelay);

    const articles = await page.$$('article[data-testid="tweet"]');
    if (articles.length === 0) {
      return { success: false, error: '页面上未找到推文', progress };
    }
    const first = articles[0];
    const parsedId = (await extractStatusIdFromArticle(first, tweetId)) || tweetId;
    const textEl = await first.$('[data-testid="tweetText"]');
    let text = await elTextContent(textEl ?? null) || '';
    if (!text.trim()) {
      const card = await first.$('[data-testid="card.wrapper"]');
      if (card) {
        const cardTitleEl = await card.$('div[dir="auto"], span');
        const cardTitle = await elTextContent(cardTitleEl ?? null);
        text = cardTitle ? `[链接] ${cardTitle.slice(0, 50)}` : '[链接]';
      }
    }
    text = text.trim() + (await getMediaPlaceholders(first));
    const authorEl = await first.$('[data-testid="User-Name"]');
    const authorText = await elTextContent(authorEl ?? null) || '';
    const authorMatch = authorText.match(/(.+?)@(\w+)/);
    const timeEl = await first.$('time');
    const datetime = (await elGetAttribute(timeEl ?? null, 'datetime')) || new Date().toISOString();
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
      likeCount: parseCount(await elTextContent(likeEl ?? null)),
      replyCount: parseCount(await elTextContent(replyEl ?? null)),
      retweetCount: parseCount(await elTextContent(retweetEl ?? null)),
    };
    if (onTweet) {
      try { await Promise.resolve(onTweet(rootTweet)); } catch (e) { console.error('[Scraper] onTweet error:', e); }
    }

    if (await hasReplyLoginWall(page)) {
      const errorMsg = '当前会话无法展开评论（登录墙拦截）。请在设置中重新配置有效的 X Cookie 后重试。';
      updateProgress({ stage: 'error', message: errorMsg });
      return { success: false, error: errorMsg, progress };
    }

    updateProgress({
      stage: 'fetching_replies',
      message: `正在获取该推文下全部评论（排序: ${replySortMode === 'top' ? 'Top' : 'Recent'}）...`,
    });
    try {
      if (await switchReplySortTab(page, replySortMode)) await wait(2000);
    } catch (_) {}

    const allReplies: Reply[] = [];
    const seenReplyIds = new Set<string>([rootTweet.id]);
    let lastReportedCount = 0;
    const processArticleList = async (replyElements: Awaited<ReturnType<Page['$$']>>, cutoffY: number) => {
      for (const el of replyElements) {
        try {
          const box = await el.boundingBox();
          if (box && Number.isFinite(cutoffY) && box.y > cutoffY) break;
          const replyId = await extractStatusIdFromArticle(el, rootTweet.id);
          if (!replyId || seenReplyIds.has(replyId)) continue;

          seenReplyIds.add(replyId);
          const textElR = await el.$('[data-testid="tweetText"]');
          let textR = (await elTextContent(textElR ?? null) || '').trim() + (await getMediaPlaceholders(el));
          const authorElR = await el.$('[data-testid="User-Name"]');
          const authorTextR = await elTextContent(authorElR ?? null) || '';
          const authorMatchR = authorTextR.match(/(.+?)@(\w+)/);
          const timeElR = await el.$('time');
          const datetimeR = (await elGetAttribute(timeElR ?? null, 'datetime')) || new Date().toISOString();
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
            likeCount: parseCountR(await elTextContent(likeElR ?? null)),
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

    // 绗竴闃舵锛氬父瑙勬粴鍔?+ 鐙傜偣銆屾樉绀烘洿澶氥€嶏紙鍙傛暟鍋忎繚瀹堬紝缃戠粶鎱篃鑳介噰鍏級
    let consecutiveScrollsWithNoNew = 0;
    let scrollBudget = initialScrollBudget;
    let firstPhaseRounds = 0;

    while (consecutiveScrollsWithNoNew < maxScrollsWithNoNewLimit && scrollBudget > 0) {
      scrollBudget--;
      firstPhaseRounds++;
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
      if (firstPhaseRounds % 5 === 0) {
        updateProgress({
          repliesFound: allReplies.length,
          message: `正在抓取评论... 第1阶段 ${firstPhaseRounds}轮，连续无新增 ${consecutiveScrollsWithNoNew} 轮`,
        });
      }

      if (expandFoldedReplies) {
        // Optionally expand folded replies / spam-filtered branches.
        for (let i = 0; i < 8; i++) {
          try {
            if (await clickByText(page, 'div[role="button"]', EXPAND_REPLY_BUTTON_PATTERN)) {
              await wait(4000);
              scrollBudget += 20;
              consecutiveScrollsWithNoNew = 0;
            } else break;
          } catch (_) { break; }
        }
      }

      const articles = await page.$$('article[data-testid="tweet"]');
      if (articles.length > 0) {
        try {
          await articles[articles.length - 1].evaluate((el) => el.scrollIntoView());
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

    // 第二阶段：滚动到底部做查漏补抓
    updateProgress({ message: `已获取 ${allReplies.length} 条，继续滚动到底部查漏...` });
    let bottomNoNewCount = 0;
    for (let round = 0; round < maxBottomRounds && bottomNoNewCount < maxBottomNoNew; round++) {
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
      if (round % 4 === 0) {
        updateProgress({
          repliesFound: allReplies.length,
          message: `正在抓取评论... 第2阶段 ${round + 1}/${maxBottomRounds} 轮`,
        });
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

// 鍏抽棴娴忚鍣?
export async function closeBrowser(): Promise<void> {
  if (browserInstance) {
    await browserInstance.close().catch(() => {});
    browserInstance = null;
  }
}

