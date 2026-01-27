# X 评论实时监控与 AI 分析系统 - TODO

## 数据库设计
- [x] raw_comments 原始评论表（reply_id, tweet_id, author_id, author_name, author_handle, text, created_at, like_count, reply_to）
- [x] analyzed_comments AI 分析结果表（reply_id, sentiment, value_score, value_type, summary, analyzed_at）

## 后端 API
- [x] 评论 CRUD 接口
- [x] AI 分析服务（情绪/价值/摘要）
- [ ] X/Twitter 数据采集接口
- [x] 后台配置接口（API Key 管理）

## 前端页面
- [x] 顶部状态栏（监控对象、更新时间、时间范围选择）
- [x] 左侧筛选栏
  - [x] 按评论人筛选（@handle 搜索、多选、高频/高价值快捷筛选）
  - [x] 按时间筛选（时间轴拖拽、精确到分钟、区间选择）
  - [x] 按情绪筛选（positive/neutral/negative/anger/sarcasm 多选）
  - [x] 按评论价值筛选（滑动条、快捷按钮）
- [x] 评论列表区
  - [x] 默认按 created_at 倒序
  - [x] 排序切换（时间新→旧、旧→新、价值高→低、点赞高→低）
  - [x] 单条评论展示（作者、时间、情绪标签、价值评分、原文、AI 摘要）
  - [x] 视觉优化（情绪颜色区分、高价值高亮、噪音弱化）
- [x] 底部分析区
  - [x] 情绪趋势图（时间 vs 情绪占比）
  - [x] 评论价值分布（直方图）
  - [x] 观点聚类与总结（3-5 种主要观点）

## 实时功能
- [x] 自动轮询刷新（30秒-60分钟可配置）
- [x] 新评论提示（不强制跳动）
- [x] 新增评论数标记

## 后台配置
- [x] X/Twitter API 配置界面
- [x] AI 服务配置界面
- [x] 刷新频率配置

## 响应式设计
- [x] 移动端适配
- [x] 平板端适配

## 新需求 - 用户账号监控 (Apify 集成)
- [x] 集成 Apify Twitter Scraper Unlimited API
- [x] 支持输入用户名自动获取推文
- [x] 自动获取每条推文的评论 (conversation_id)
- [x] 后台配置 Apify API Token
- [x] 多账号舆情对比功能（已支持添加多个账号监控）
- [ ] 定时自动采集任务

## Playwright 自爬功能
- [x] 安装 Playwright 依赖
- [x] 实现 X/Twitter 自爬服务
- [x] 支持 Cookie 登录配置
- [x] 优先使用自爬，Apify 作为备选
- [x] 前端选择爬取方式
