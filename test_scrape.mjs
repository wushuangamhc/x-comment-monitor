import { chromium } from 'playwright';

const cookies = [
  { name: 'guest_id', value: 'v1%3A176954096344106334', domain: '.x.com' },
  { name: 'ct0', value: 'c554967da16ddffe1e5b290d913d4149634221f14aaf12a095e5075c38747d1936b547966ae213fe2e409918549c256838551acc1c99686de3c9aab1a51d6ec2e1c93aad4d7e7fa70bee48140e334ca4', domain: '.x.com' },
  { name: 'twid', value: 'u%3D2016227976564932608', domain: '.x.com' }
];

async function test() {
  let browser;
  try {
    console.log('启动浏览器...');
    browser = await chromium.launch({
      headless: true,
      executablePath: '/root/.cache/ms-playwright/chromium_headless_shell-1208/chrome-headless-shell-linux64/chrome-headless-shell',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    });
    
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 800 }
    });
    
    await context.addCookies(cookies.map(c => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: '/'
    })));
    
    const page = await context.newPage();
    
    console.log('访问 BitgetWalletCN 主页...');
    await page.goto('https://x.com/BitgetWalletCN', { waitUntil: 'networkidle', timeout: 30000 });
    
    await page.waitForTimeout(3000);
    
    const pageContent = await page.content();
    const hasLoginButton = pageContent.includes('Log in') || pageContent.includes('Sign up');
    console.log('登录状态:', hasLoginButton ? '未登录/需要登录' : '可能已登录');
    
    const tweets = await page.evaluate(() => {
      const articles = document.querySelectorAll('article[data-testid="tweet"]');
      return Array.from(articles).slice(0, 5).map(article => {
        const textEl = article.querySelector('[data-testid="tweetText"]');
        const timeEl = article.querySelector('time');
        return {
          text: textEl?.textContent?.substring(0, 100) || 'No text',
          time: timeEl?.getAttribute('datetime') || 'No time'
        };
      });
    });
    
    console.log('找到推文数量:', tweets.length);
    tweets.forEach((t, i) => {
      console.log(`推文 ${i+1}: ${t.text}... (${t.time})`);
    });
    
    await browser.close();
    console.log('测试完成!');
  } catch (e) {
    console.error('错误:', e.message);
    if (browser) await browser.close();
  }
}

test();
