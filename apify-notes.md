# Apify Twitter Scraper 使用说明

## 获取推文评论的正确方式

使用 `conversation_id` 查询可以获取某条推文的所有回复：

```json
{
  "searchTerms": ["conversation_id:1728108619189874825"],
  "sort": "Latest"
}
```

## 获取用户推文

```json
{
  "searchTerms": ["from:NASA"],
  "sort": "Latest"
}
```

## 数据格式

返回的数据包含：
- id: 推文 ID
- text/fullText: 推文内容
- createdAt: 创建时间
- author: 作者信息
- likeCount/favoriteCount: 点赞数
- inReplyToStatusId: 回复的推文 ID（如果是回复）
