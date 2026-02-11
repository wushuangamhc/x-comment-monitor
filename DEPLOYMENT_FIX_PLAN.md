# X Comment Monitor - 部署修复计划

## 一、线上部署环境说明（Manus Publish）

### 运行环境
- **OS**: 精简版 Linux 容器（**不是完整 Ubuntu**，缺少很多系统库）
- **运行用户**: `root`（所有路径基于 `/root/`）
- **Node.js**: 22.x
- **包管理器**: pnpm
- **构建流程**: `pnpm install` → `pnpm build` → `pnpm start`
- **构建产物**: esbuild 打包为 **ESM 格式**（`"type": "module"`），输出到 `dist/index.js`

### 数据库
- **类型**: MySQL（TiDB 兼容）
- **ORM**: Drizzle ORM（使用 `drizzle-orm/mysql-core`）
- **连接**: 通过 `DATABASE_URL` 环境变量，使用 `mysql2` 驱动
- **重要**: schema 必须使用 `mysqlTable`，**不能用 `sqliteTable`**

### 关键限制
1. **没有预装 `chromium-browser`** — 容器中 `/usr/bin/chromium-browser` 不存在
2. **没有预装系统图形库** — 缺少 `libglib-2.0.so.0` 等共享库
3. **Playwright 的 `npx playwright install chromium`** 能下载二进制文件到 `/root/.cache/ms-playwright/`，但因为缺少系统依赖库（libglib、libnss、libatk 等），下载的 Chromium 无法运行
4. **ESM 格式** — 不能使用 `require()`，必须用 `import`
5. **esbuild 打包** — `--packages=external` 意味着 node_modules 中的包不会被打包进 dist，运行时从 node_modules 加载

### 环境变量（已自动注入，不需要手动设置）
- `DATABASE_URL` — MySQL 连接字符串
- `JWT_SECRET` — Session 签名密钥
- `VITE_APP_ID` — OAuth 应用 ID
- `OAUTH_SERVER_URL` — OAuth 后端地址
- `BUILT_IN_FORGE_API_URL` / `BUILT_IN_FORGE_API_KEY` — 内置 LLM API
- `PORT` — 服务端口（不要硬编码）

---

## 二、错误根因分析

### 错误日志关键信息
```
/root/.cache/ms-playwright/chromium_headless_shell-1208/chrome-headless-shell-linux64/chrome-headless-shell: 
error while loading shared libraries: libglib-2.0.so.0: cannot open shared object file: No such file or directory
```

### 根因
1. `postinstall` 脚本成功下载了 Playwright 的 Chromium 到 `/root/.cache/ms-playwright/`
2. 但线上容器是精简版 Linux，**缺少 Chromium 运行所需的系统共享库**（libglib-2.0、libnss3、libatk 等）
3. `findChromiumPath()` 没找到系统 Chromium（因为确实没有），所以 `systemPath` 为 `undefined`
4. 三个策略全部失败：
   - Strategy 1（系统 Chromium）：路径不存在
   - Strategy 2（channel 模式）：同样找不到
   - Strategy 3（Playwright 默认）：二进制存在但缺少 .so 库，启动崩溃

### 结论
**Playwright 在 Manus 的线上部署容器中无法工作**，因为容器缺少 Chromium 运行所需的系统级共享库，且我们无法在容器中安装系统包（没有 apt-get 权限）。

---

## 三、修复方案

### 推荐方案：使用 Puppeteer + `@puppeteer/browsers` 或 `puppeteer-core` + `chrome-aws-lambda`

#### 方案 A：Puppeteer + `@sparticuz/chromium`（强烈推荐）

`@sparticuz/chromium` 是专为无服务器/精简容器环境设计的 Chromium，**自带所有依赖库**，不需要系统安装任何东西。

**步骤：**

1. 安装依赖：
```bash
pnpm add puppeteer-core @sparticuz/chromium
pnpm remove playwright
```

2. 重写 `server/twitterScraper.ts` 中的浏览器启动逻辑：
```typescript
import puppeteer from 'puppeteer-core';
import chromium from '@sparticuz/chromium';

async function getBrowser() {
  const executablePath = await chromium.executablePath();
  
  const browser = await puppeteer.launch({
    args: chromium.args,
    defaultViewport: chromium.defaultViewport,
    executablePath: executablePath,
    headless: chromium.headless,
  });
  
  return browser;
}
```

3. **API 差异注意**：Puppeteer 和 Playwright 的 API 有差异，需要逐一替换：

| Playwright | Puppeteer |
|---|---|
| `browser.newContext()` | `browser.createBrowserContext()` 或直接 `browser.newPage()` |
| `context.newPage()` | `browser.newPage()` |
| `page.goto(url)` | `page.goto(url)` (相同) |
| `page.waitForSelector(sel)` | `page.waitForSelector(sel)` (相同) |
| `page.locator(sel).click()` | `page.click(sel)` |
| `page.locator(sel).textContent()` | `page.$eval(sel, el => el.textContent)` |
| `page.evaluate()` | `page.evaluate()` (相同) |
| `page.waitForTimeout(ms)` | `await new Promise(r => setTimeout(r, ms))` |
| `context.addCookies([...])` | `page.setCookie(...cookies)` |
| `page.route(url, handler)` | `page.setRequestInterception(true)` + `page.on('request', ...)` |

4. Cookie 格式差异：
```typescript
// Playwright cookie 格式
{ name: 'auth', value: 'xxx', domain: '.x.com', path: '/' }

// Puppeteer cookie 格式（相同，但设置方式不同）
await page.setCookie({ name: 'auth', value: 'xxx', domain: '.x.com', path: '/' });
```

#### 方案 B：保留 Playwright 但使用 `playwright-core` + `@playwright/browser-chromium`

如果不想改 API，可以尝试：
```bash
pnpm remove playwright
pnpm add playwright-core
```
然后手动指定一个静态编译的 Chromium。但这个方案不如方案 A 可靠。

---

## 四、具体改动文件清单

### 必须修改的文件：

1. **`package.json`**
   - 移除 `playwright` 依赖
   - 添加 `puppeteer-core` 和 `@sparticuz/chromium`
   - 移除 `postinstall` 中的 playwright install 脚本

2. **`server/twitterScraper.ts`**（核心文件，约 800 行）
   - 替换所有 `import { chromium, Browser, BrowserContext, Page } from 'playwright'` 为 Puppeteer 等价
   - 重写 `getBrowser()` 函数
   - 重写 `createContext()` 函数
   - 替换所有 Playwright 特有 API 调用为 Puppeteer 等价
   - 注意：`page.route()` 在 Puppeteer 中是 `page.setRequestInterception(true)` + 事件监听

3. **`server/ensurePlaywright.ts`**
   - 可以删除或简化，因为 `@sparticuz/chromium` 自带一切

4. **`server/_core/index.ts`**
   - 移除 `import { startPlaywrightSetup } from "../ensurePlaywright"` 和调用

5. **`server/routers.ts`**
   - 移除 `getPlaywrightStatus` 相关 import 和路由（如果不再需要）
   - 或者改为返回 Puppeteer 状态

### 不需要修改的文件：
- `drizzle/schema.ts` — 保持 MySQL 版本不变
- `server/db.ts` — 数据库操作不变
- `client/` 下的所有前端文件 — 不受影响
- `server/scrapeProgressStore.ts` — 不受影响

---

## 五、本地开发 vs 线上部署的差异

| 项目 | 本地开发 (你的电脑) | Manus 线上部署 |
|---|---|---|
| OS | macOS / Ubuntu 完整版 | 精简 Linux 容器 |
| 用户 | 你的用户 | root |
| 系统库 | 完整 | 极度精简，缺少图形库 |
| 浏览器 | 可以用 Playwright 默认 | 必须用自带依赖的方案 |
| 数据库 | 你用的 SQLite | **必须用 MySQL**（`mysqlTable`） |
| 端口 | 随意 | 通过 `process.env.PORT` |
| ESM | tsx 直接运行 | esbuild 打包为 ESM |

### 本地开发建议
- 本地可以继续用 Playwright（方便调试）
- 通过环境变量区分：
```typescript
const isProduction = process.env.NODE_ENV === 'production';
// 生产环境用 @sparticuz/chromium，开发环境用 Playwright
```

---

## 六、给 Codex 的提示词建议

```
请帮我将这个 Node.js 项目中的 Playwright 浏览器自动化替换为 Puppeteer + @sparticuz/chromium。

背景：
- 项目部署在精简 Linux 容器中，没有系统级图形库（libglib-2.0 等）
- Playwright 下载的 Chromium 因缺少共享库无法启动
- @sparticuz/chromium 是专为此类环境设计的，自带所有依赖

需要修改的文件：
1. package.json - 替换 playwright 为 puppeteer-core + @sparticuz/chromium
2. server/twitterScraper.ts - 将所有 Playwright API 替换为 Puppeteer 等价 API
3. server/ensurePlaywright.ts - 删除或简化
4. server/_core/index.ts - 移除 ensurePlaywright 相关代码
5. server/routers.ts - 移除 getPlaywrightStatus 相关代码

关键 API 映射：
- browser.newContext() → browser.createBrowserContext() 或直接 browser.newPage()
- context.addCookies() → page.setCookie()
- page.locator(sel).click() → page.click(sel)
- page.route() → page.setRequestInterception(true) + page.on('request', ...)
- page.waitForTimeout(ms) → new Promise(r => setTimeout(r, ms))

注意事项：
- 项目使用 ESM 格式（"type": "module"），不能用 require()
- 数据库使用 MySQL（drizzle-orm/mysql-core），不要改成 SQLite
- 不要修改 drizzle/schema.ts 和 server/db.ts
- 保持所有前端文件不变
```

---

## 七、修复完成后的协作流程

1. 你在本地修复并推送到 `git@github.com:wushuangamhc/x-comment-monitor.git`
2. 告诉我 "代码已推送到 GitHub"
3. 我会拉取最新代码，**只同步业务文件**（不覆盖 schema.ts 和 db.ts 的 MySQL 部分）
4. 我来处理 MySQL 兼容性（如果你本地用 SQLite 开发的话）
5. 我保存 checkpoint 并引导你发布

---

## 八、快速验证清单

修复完成后，请在本地验证：
- [ ] `pnpm install` 无报错
- [ ] `pnpm build` 无报错（esbuild 打包成功）
- [ ] `node dist/index.js` 能启动（不需要连数据库，只要不崩溃）
- [ ] 浏览器能启动：在代码中加个测试，调用 `getBrowser()` 看是否成功
- [ ] 没有 `require()` 动态导入（grep 检查：`grep -rn "require(" server/*.ts`）
