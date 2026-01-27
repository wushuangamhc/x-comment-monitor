import { chromium } from 'playwright';

const cookies = [
  { name: 'auth_token', value: '7a8b6b4a02b22038cd3c00bf2eba40b44eae2684', domain: '.x.com' },
  { name: '__cuid', value: '9605ee62a4474360bb4dbbf84572aed2', domain: '.x.com' },
  { name: 'd_prefs', value: 'MToxLGNvbnNlbnRfdmVyc2lvbjoyLHRleHRfdmVyc2lvbjoxMDAw', domain: '.x.com' },
  { name: 'dnt', value: '1', domain: '.x.com' },
  { name: 'guest_id', value: 'v1%3A176954096344106334', domain: '.x.com' },
  { name: 'guest_id_marketing', value: 'v1%3A176954096344106334', domain: '.x.com' },
  { name: 'guest_id_ads', value: 'v1%3A176954096344106334', domain: '.x.com' },
  { name: 'personalization_id', value: '"v1_AkqXOuJ5AoNyiAegjU6PiA=="', domain: '.x.com' },
  { name: 'gt', value: '2016227051674689673', domain: '.x.com' },
  { name: 'g_state', value: '{"i_l":0,"i_ll":1769540964687,"i_b":"TuFZAC2J4VL7Uu5sTLqPsxhd9O5Ypat5eRVUXBZfK0Y","i_e":{"enable_itp_optimization":3}}', domain: '.x.com' },
  { name: 'ct0', value: 'c554967da16ddffe1e5b290d913d4149634221f14aaf12a095e5075c38747d1936b547966ae213fe2e409918549c256838551acc1c99686de3c9aab1a51d6ec2e1c93aad4d7e7fa70bee48140e334ca4', domain: '.x.com' },
  { name: 'lang', value: 'en', domain: '.x.com' },
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
    await page.goto('https://x.com/BitgetWalletCN', { waitUntil: 'domcontentloaded', timeout: 60000 });
    
    // 等待页面加载
    await page.waitForTimeout(5000);
    
    // 截图
    await page.screenshot({ path: '/home/ubuntu/x_page_auth.png', fullPage: false });
    console.log('截图已保存');
    
    const title = await page.title();
    console.log('页面标题:', title);
    
    // 等待推文加载
    try {
      await page.waitForSelector('article[data-testid="tweet"]', { timeout: 15000 });
    } catch (e) {
      console.log('等待推文超时，继续检查页面...');
    }
    
    const tweets = await page.evaluate(() => {
      const articles = document.querySelectorAll('article[data-testid="tweet"]');
      return Array.from(articles).slice(0, 5).map(article => {
        const textEl = article.querySelector('[data-testid="tweetText"]');
        const timeEl = article.querySelector('time');
        const linkEl = article.querySelector('a[href*="/status/"]');
        return {
          text: textEl?.textContent?.substring(0, 80) || 'No text',
          time: timeEl?.getAttribute('datetime') || 'No time',
          link: linkEl?.getAttribute('href') || 'No link'
        };
      });
    });
    
    console.log('找到推文数量:', tweets.length);
    tweets.forEach((t, i) => {
      console.log(`\n推文 ${i+1}:`);
      console.log(`  内容: ${t.text}...`);
      console.log(`  时间: ${t.time}`);
      console.log(`  链接: ${t.link}`);
    });
    
    // 如果找到推文，尝试获取第一条的评论
    if (tweets.length > 0 && tweets[0].link !== 'No link') {
      const tweetUrl = 'https://x.com' + tweets[0].link;
      console.log('\n\n--- 尝试获取第一条推文的评论 ---');
      console.log('访问:', tweetUrl);
      
      await page.goto(tweetUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForTimeout(5000);
      
      // 截图评论页
      await page.screenshot({ path: '/home/ubuntu/x_replies.png', fullPage: false });
      
      const replies = await page.evaluate(() => {
        const articles = document.querySelectorAll('article[data-testid="tweet"]');
        // 跳过第一条（原推文）
        return Array.from(articles).slice(1, 6).map(article => {
          const textEl = article.querySelector('[data-testid="tweetText"]');
          const userEl = article.querySelector('[data-testid="User-Name"]');
          return {
            text: textEl?.textContent?.substring(0, 80) || 'No text',
            user: userEl?.textContent || 'Unknown'
          };
        });
      });
      
      console.log('找到评论数量:', replies.length);
      replies.forEach((r, i) => {
        console.log(`\n评论 ${i+1}:`);
        console.log(`  用户: ${r.user}`);
        console.log(`  内容: ${r.text}...`);
      });
    }
    
    await browser.close();
    console.log('\n测试完成!');
  } catch (e) {
    console.error('错误:', e.message);
    if (browser) await browser.close();
  }
}

test();
