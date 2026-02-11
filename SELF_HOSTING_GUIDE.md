# X 评论监控系统 — 自建服务器部署指南

本文档面向服务器运维人员，说明如何将 **X 评论实时监控与 AI 分析系统** 部署到自有服务器上，使 Puppeteer（Chromium）采集功能正常运行。

---

## 1. 环境要求

| 项目 | 最低要求 | 推荐 |
|------|---------|------|
| 操作系统 | Ubuntu 20.04 / CentOS 7 | Ubuntu 22.04 LTS |
| CPU | 1 核 | 2 核+ |
| 内存 | 2 GB | 4 GB（Chromium 运行时约占 300–500 MB） |
| 磁盘 | 2 GB 空闲 | 10 GB+ |
| Node.js | 18.x | 22.x LTS |
| 包管理器 | pnpm 8+ | pnpm 10+ |
| 数据库 | MySQL 5.7 | MySQL 8.0 / TiDB |
| 网络 | 能访问 twitter.com（或配置 HTTP/SOCKS5 代理） | 海外服务器或稳定代理 |

---

## 2. 安装系统依赖（关键步骤）

Puppeteer 启动 Chromium 时需要一系列系统级共享库。如果缺少这些库，会报 `libnss3.so: cannot open shared object file` 等错误。**这是部署成功的关键步骤，不可跳过。**

### Ubuntu / Debian

```bash
sudo apt-get update
sudo apt-get install -y \
  libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 \
  libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 \
  libxrandr2 libgbm1 libpango-1.0-0 libcairo2 \
  libasound2 libxshmfence1 libx11-xcb1 libxcb-dri3-0 \
  libxss1 libxtst6 libgtk-3-0 \
  fonts-noto-cjk fonts-noto-color-emoji \
  ca-certificates wget gnupg
```

### CentOS / RHEL / Amazon Linux

```bash
sudo yum install -y \
  nss atk at-spi2-atk cups-libs libdrm \
  libxkbcommon libXcomposite libXdamage \
  libXrandr mesa-libgbm pango cairo \
  alsa-lib libxshmfence libX11-xcb \
  libXScrnSaver libXtst gtk3 \
  google-noto-cjk-fonts \
  ca-certificates wget
```

### 验证依赖是否安装成功

安装完成后可以用以下命令快速验证核心库是否存在：

```bash
ldconfig -p | grep libnss3
# 应输出类似：libnss3.so (libc6,x86-64) => /usr/lib/x86_64-linux-gnu/libnss3.so
```

如果无输出，说明安装不成功，需要排查。

---

## 3. 安装 Node.js 和 pnpm

如果服务器尚未安装 Node.js，推荐使用 nvm 管理：

```bash
# 安装 nvm
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
source ~/.bashrc

# 安装 Node.js 22 LTS
nvm install 22
nvm use 22

# 安装 pnpm
npm install -g pnpm
```

验证版本：

```bash
node -v   # 应输出 v22.x.x
pnpm -v   # 应输出 10.x.x
```

---

## 4. 准备数据库

项目使用 **MySQL**（兼容 TiDB）。需要创建一个数据库并获取连接字符串。

### 方式一：本机安装 MySQL

```bash
# Ubuntu
sudo apt-get install -y mysql-server
sudo systemctl start mysql
sudo systemctl enable mysql

# 创建数据库和用户
sudo mysql -e "
  CREATE DATABASE x_comment_monitor CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
  CREATE USER 'monitor'@'localhost' IDENTIFIED BY '你的密码';
  GRANT ALL PRIVILEGES ON x_comment_monitor.* TO 'monitor'@'localhost';
  FLUSH PRIVILEGES;
"
```

连接字符串为：`mysql://monitor:你的密码@localhost:3306/x_comment_monitor`

### 方式二：使用云数据库

如果使用阿里云 RDS、AWS RDS、TiDB Cloud 等，直接获取连接字符串即可。格式为：

```
mysql://用户名:密码@主机地址:端口/数据库名
```

如果云数据库要求 SSL 连接，在连接字符串后追加 `?ssl={"rejectUnauthorized":true}`。

---

## 5. 克隆代码与安装依赖

```bash
# 克隆仓库
git clone https://github.com/wushuangamhc/x-comment-monitor.git
cd x-comment-monitor

# 安装项目依赖（会自动安装 puppeteer-core 和 @sparticuz/chromium）
pnpm install
```

---

## 6. 配置环境变量

在项目根目录创建 `.env` 文件：

```bash
cat > .env << 'EOF'
# ========== 必填 ==========
# MySQL 数据库连接字符串
DATABASE_URL=mysql://monitor:你的密码@localhost:3306/x_comment_monitor

# JWT 签名密钥（随机长字符串，用于 session cookie 签名）
JWT_SECRET=请替换为一个随机字符串比如用uuidgen生成

# 服务端口（默认 3000）
PORT=3000

# 运行环境
NODE_ENV=production

# ========== 可选：认证相关 ==========
# 如果不需要 OAuth 登录，可以不配置以下变量
# 系统会自动以开发模式绕过登录（见第 8 节说明）
# VITE_OAUTH_PORTAL_URL=https://your-oauth-portal
# VITE_APP_ID=your-app-id
# OAUTH_SERVER_URL=https://your-oauth-api

# ========== 可选：代理配置 ==========
# 如果服务器无法直接访问 twitter.com，配置代理
# 支持 HTTP 和 SOCKS5 代理
# PROXY_URL=socks5://127.0.0.1:1080
# PROXY_URL=http://127.0.0.1:7890

# ========== 可选：Apify 备选采集 ==========
# 如果需要 Apify 作为备选采集方式（付费）
# 可以在网页设置页面中配置，也可以在这里预设
# APIFY_TOKEN=your-apify-token
EOF
```

**关于 `JWT_SECRET` 的生成：**

```bash
# 方法一：使用 uuidgen
uuidgen

# 方法二：使用 openssl
openssl rand -hex 32
```

---

## 7. 初始化数据库并构建

```bash
# 推送数据库表结构（自动创建所有需要的表）
pnpm db:push

# 构建生产版本
pnpm build
```

`pnpm db:push` 会创建以下表：

| 表名 | 用途 |
|------|------|
| `users` | 用户账号（OAuth 登录后自动创建） |
| `raw_comments` | 原始评论数据（采集结果） |
| `analyzed_comments` | AI 分析结果（情绪、价值评分等） |
| `system_config` | 系统配置（Cookie、Apify Token 等） |

---

## 8. 关于登录认证

项目原始设计使用 Manus OAuth 登录。自建部署时有两种处理方式：

### 方式一：绕过登录（推荐用于内部工具）

代码中已经内置了开发模式绕过逻辑。如果 `.env` 中没有配置 `VITE_OAUTH_PORTAL_URL`，系统会自动以开发者身份登录，无需任何 OAuth 配置。

如果需要在生产环境也绕过登录，可以在 `server/_core/context.ts` 中找到 `DEV_AUTH_BYPASS` 相关逻辑，将其条件改为始终启用即可。

### 方式二：接入自己的 OAuth

如果需要正式的登录系统，可以替换 `server/_core/` 下的 OAuth 逻辑，接入公司内部的 SSO 或第三方 OAuth（如 GitHub OAuth、Google OAuth 等）。

---

## 9. 启动服务

### 直接启动（测试用）

```bash
node dist/index.js
```

服务启动后访问 `http://服务器IP:3000` 即可。

### 使用 PM2 管理进程（生产推荐）

```bash
# 安装 PM2
npm install -g pm2

# 启动服务
pm2 start dist/index.js --name x-comment-monitor

# 查看状态
pm2 status

# 查看日志
pm2 logs x-comment-monitor

# 保存进程列表（重启后自动恢复）
pm2 save

# 设置开机自启
pm2 startup
```

---

## 10. Nginx 反向代理（可选）

如果需要绑定域名或启用 HTTPS，使用 Nginx 做反向代理：

```bash
sudo apt-get install -y nginx
```

创建配置文件 `/etc/nginx/sites-available/x-comment-monitor`：

```nginx
server {
    listen 80;
    server_name your-domain.com;  # 替换为你的域名

    # 上传文件大小限制（如果有文件上传需求）
    client_max_body_size 50M;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # 采集请求可能耗时较长，设置较大的超时
        proxy_read_timeout 300s;
        proxy_connect_timeout 60s;
        proxy_send_timeout 300s;
    }
}
```

启用配置：

```bash
sudo ln -s /etc/nginx/sites-available/x-comment-monitor /etc/nginx/sites-enabled/
sudo nginx -t          # 测试配置
sudo systemctl reload nginx
```

如需 HTTPS，推荐使用 Let's Encrypt：

```bash
sudo apt-get install -y certbot python3-certbot-nginx
sudo certbot --nginx -d your-domain.com
```

---

## 11. 部署后验证

按以下步骤验证部署是否成功：

| 步骤 | 操作 | 预期结果 |
|------|------|---------|
| 1 | 浏览器访问 `http://服务器IP:3000` | 看到监控面板首页 |
| 2 | 进入「设置」页面，配置 X Cookie | 保存成功，无报错 |
| 3 | 在首页输入 X 用户名，点击采集 | 进度条正常推进，评论数据出现在列表中 |
| 4 | 检查服务器日志 `pm2 logs` | 无 `libnss3.so` 等错误 |

如果步骤 3 报错 `libnss3.so` 相关错误，说明第 2 节的系统依赖没有安装完整，请重新执行安装命令。

如果步骤 3 报错连接超时（timeout），说明服务器无法访问 twitter.com，需要配置代理（在设置页面或 `.env` 中配置 `PROXY_URL`）。

---

## 12. 常见问题

### Q: Chromium 启动报错 `libnss3.so` / `libgbm.so` 等

**原因：** 系统缺少 Chromium 运行所需的共享库。

**解决：** 执行第 2 节的 `apt-get install` 命令安装所有依赖。

### Q: 采集超时，无法连接 twitter.com

**原因：** 国内服务器无法直接访问 twitter.com。

**解决：** 在设置页面配置代理地址，或在 `.env` 中设置 `PROXY_URL`。推荐使用海外服务器（如 AWS 新加坡、Vultr 东京等）。

### Q: 数据库连接失败

**原因：** `DATABASE_URL` 配置错误，或 MySQL 服务未启动。

**解决：** 检查 MySQL 是否运行（`systemctl status mysql`），验证连接字符串中的用户名、密码、主机、端口、数据库名是否正确。

### Q: 端口被占用

**原因：** 3000 端口已被其他服务占用。

**解决：** 在 `.env` 中修改 `PORT=3001`（或其他空闲端口），同时更新 Nginx 配置中的 `proxy_pass` 端口。

### Q: 内存不足导致 Chromium 崩溃

**原因：** 服务器内存不足（Chromium 单实例约需 300–500 MB）。

**解决：** 升级服务器内存至 4 GB 以上，或添加 swap 空间：

```bash
sudo fallocate -l 2G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

---

## 13. 更新部署

当代码有更新时，执行以下命令：

```bash
cd x-comment-monitor
git pull origin main
pnpm install          # 安装新依赖（如有）
pnpm db:push          # 推送数据库变更（如有）
pnpm build            # 重新构建
pm2 restart x-comment-monitor
```

---

## 快速部署脚本（一键执行）

将以下脚本保存为 `deploy.sh`，修改数据库配置后执行 `bash deploy.sh`：

```bash
#!/bin/bash
set -e

echo "=== 1. 安装系统依赖 ==="
sudo apt-get update
sudo apt-get install -y \
  libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 \
  libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 \
  libxrandr2 libgbm1 libpango-1.0-0 libcairo2 \
  libasound2 libxshmfence1 libx11-xcb1 libxcb-dri3-0 \
  libxss1 libxtst6 libgtk-3-0 \
  fonts-noto-cjk ca-certificates mysql-server

echo "=== 2. 安装 Node.js 22 ==="
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
npm install -g pnpm pm2

echo "=== 3. 配置 MySQL ==="
sudo systemctl start mysql
sudo mysql -e "
  CREATE DATABASE IF NOT EXISTS x_comment_monitor CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
  CREATE USER IF NOT EXISTS 'monitor'@'localhost' IDENTIFIED BY 'ChangeThisPassword123!';
  GRANT ALL PRIVILEGES ON x_comment_monitor.* TO 'monitor'@'localhost';
  FLUSH PRIVILEGES;
"

echo "=== 4. 克隆并构建 ==="
cd /opt
git clone https://github.com/wushuangamhc/x-comment-monitor.git || true
cd x-comment-monitor

cat > .env << 'EOF'
DATABASE_URL=mysql://monitor:ChangeThisPassword123!@localhost:3306/x_comment_monitor
JWT_SECRET=$(openssl rand -hex 32)
PORT=3000
NODE_ENV=production
EOF

pnpm install
pnpm db:push
pnpm build

echo "=== 5. 启动服务 ==="
pm2 delete x-comment-monitor 2>/dev/null || true
pm2 start dist/index.js --name x-comment-monitor
pm2 save
pm2 startup

echo "=== 部署完成！访问 http://$(hostname -I | awk '{print $1}'):3000 ==="
```

> **注意：** 请务必修改脚本中的数据库密码 `ChangeThisPassword123!` 为安全的密码。
