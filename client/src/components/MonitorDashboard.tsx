import { useState, useMemo } from "react";
import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Slider } from "@/components/ui/slider";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { 
  RefreshCw, Clock, Filter, TrendingUp, BarChart3, 
  MessageSquare, Heart, User, ChevronDown, ChevronUp,
  AlertCircle, Sparkles, Search
} from "lucide-react";
import { CommentCard } from "./CommentCard";
import { AnalyticsPanel } from "./AnalyticsPanel";

type SortOption = 'time_desc' | 'time_asc' | 'value_desc' | 'likes_desc';
type TimeRange = '10m' | '1h' | '24h' | '7d' | 'custom';
type Sentiment = 'positive' | 'neutral' | 'negative' | 'anger' | 'sarcasm';

const SENTIMENTS: { value: Sentiment; label: string; color: string }[] = [
  { value: 'positive', label: '支持', color: 'bg-green-500' },
  { value: 'neutral', label: '中立', color: 'bg-slate-500' },
  { value: 'negative', label: '批评', color: 'bg-orange-500' },
  { value: 'anger', label: '愤怒', color: 'bg-red-500' },
  { value: 'sarcasm', label: '讽刺', color: 'bg-purple-500' },
];

const TIME_RANGES: { value: TimeRange; label: string }[] = [
  { value: '10m', label: '最近 10 分钟' },
  { value: '1h', label: '最近 1 小时' },
  { value: '24h', label: '最近 24 小时' },
  { value: '7d', label: '最近 7 天' },
  { value: 'custom', label: '自定义' },
];

const SORT_OPTIONS: { value: SortOption; label: string }[] = [
  { value: 'time_desc', label: '最新优先' },
  { value: 'time_asc', label: '最早优先' },
  { value: 'value_desc', label: '价值最高' },
  { value: 'likes_desc', label: '点赞最多' },
];

export function MonitorDashboard() {
  // Filter states
  const [tweetId, setTweetId] = useState<string>("");
  const [searchHandle, setSearchHandle] = useState("");
  const [selectedSentiments, setSelectedSentiments] = useState<Sentiment[]>([]);
  const [valueRange, setValueRange] = useState<[number, number]>([0, 1]);
  const [timeRange, setTimeRange] = useState<TimeRange>('24h');
  const [sortBy, setSortBy] = useState<SortOption>('time_desc');
  const [showFilters, setShowFilters] = useState(true);
  const [showAnalytics, setShowAnalytics] = useState(true);
  const [refreshInterval, setRefreshInterval] = useState(30000);
  const [newCommentsCount, setNewCommentsCount] = useState(0);
  const [lastCommentCount, setLastCommentCount] = useState(0);

  // Calculate time filter
  const timeFilter = useMemo(() => {
    const now = new Date();
    switch (timeRange) {
      case '10m': return new Date(now.getTime() - 10 * 60 * 1000);
      case '1h': return new Date(now.getTime() - 60 * 60 * 1000);
      case '24h': return new Date(now.getTime() - 24 * 60 * 60 * 1000);
      case '7d': return new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      default: return undefined;
    }
  }, [timeRange]);

  // Fetch comments
  const { data: comments, isLoading, refetch, dataUpdatedAt } = trpc.comments.list.useQuery({
    tweetId: tweetId || undefined,
    sentiments: selectedSentiments.length > 0 ? selectedSentiments : undefined,
    minValueScore: valueRange[0],
    maxValueScore: valueRange[1],
    startTime: timeFilter,
    sortBy,
    limit: 100,
  }, {
    refetchInterval: refreshInterval,
  });

  // Fetch stats
  const { data: stats } = trpc.comments.stats.useQuery({
    tweetId: tweetId || undefined,
  }, {
    refetchInterval: refreshInterval,
  });

  // Fetch top commenters
  const { data: topCommenters } = trpc.comments.topCommenters.useQuery({
    tweetId: tweetId || undefined,
    limit: 10,
  });

  const toggleSentiment = (sentiment: Sentiment) => {
    setSelectedSentiments(prev => 
      prev.includes(sentiment) 
        ? prev.filter(s => s !== sentiment)
        : [...prev, sentiment]
    );
  };

  const lastUpdated = dataUpdatedAt ? new Date(dataUpdatedAt).toLocaleTimeString() : '--:--:--';

  // Track new comments
  useMemo(() => {
    if (comments && comments.length > lastCommentCount && lastCommentCount > 0) {
      setNewCommentsCount(comments.length - lastCommentCount);
    }
    if (comments) {
      setLastCommentCount(comments.length);
    }
  }, [comments?.length]);

  return (
    <div className="flex flex-col lg:flex-row min-h-[calc(100vh-3.5rem)]">
      {/* Left Sidebar - Filters */}
      <aside className={`lg:w-72 border-r bg-card/30 transition-all ${showFilters ? '' : 'lg:w-0 lg:overflow-hidden'}`}>
        <div className="p-4 space-y-6">
          {/* Monitor Target */}
          <div className="space-y-2">
            <label className="text-sm font-medium flex items-center gap-2">
              <Search className="w-4 h-4" />
              监控目标
            </label>
            <Input
              placeholder="输入 Tweet ID..."
              value={tweetId}
              onChange={(e) => setTweetId(e.target.value)}
              className="h-9"
            />
          </div>

          <Separator />

          {/* Time Range Filter */}
          <div className="space-y-2">
            <label className="text-sm font-medium flex items-center gap-2">
              <Clock className="w-4 h-4" />
              时间范围
            </label>
            <Select value={timeRange} onValueChange={(v) => setTimeRange(v as TimeRange)}>
              <SelectTrigger className="h-9">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TIME_RANGES.map(range => (
                  <SelectItem key={range.value} value={range.value}>
                    {range.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <Separator />

          {/* Sentiment Filter */}
          <div className="space-y-3">
            <label className="text-sm font-medium flex items-center gap-2">
              <Sparkles className="w-4 h-4" />
              情绪筛选
            </label>
            <div className="space-y-2">
              {SENTIMENTS.map(sentiment => (
                <div key={sentiment.value} className="flex items-center gap-2">
                  <Checkbox
                    id={sentiment.value}
                    checked={selectedSentiments.includes(sentiment.value)}
                    onCheckedChange={() => toggleSentiment(sentiment.value)}
                  />
                  <label htmlFor={sentiment.value} className="flex items-center gap-2 text-sm cursor-pointer">
                    <div className={`w-2 h-2 rounded-full ${sentiment.color}`} />
                    {sentiment.label}
                  </label>
                </div>
              ))}
            </div>
          </div>

          <Separator />

          {/* Value Score Filter */}
          <div className="space-y-3">
            <label className="text-sm font-medium flex items-center gap-2">
              <TrendingUp className="w-4 h-4" />
              价值评分
            </label>
            <Slider
              value={valueRange}
              onValueChange={(v) => setValueRange(v as [number, number])}
              min={0}
              max={1}
              step={0.1}
              className="py-2"
            />
            <div className="flex justify-between text-xs text-muted-foreground">
              <span>{valueRange[0].toFixed(1)}</span>
              <span>{valueRange[1].toFixed(1)}</span>
            </div>
            <div className="flex gap-2">
              <Button 
                variant="outline" 
                size="sm" 
                className="flex-1 h-7 text-xs"
                onClick={() => setValueRange([0.7, 1])}
              >
                高价值
              </Button>
              <Button 
                variant="outline" 
                size="sm" 
                className="flex-1 h-7 text-xs"
                onClick={() => setValueRange([0.4, 1])}
              >
                排除噪音
              </Button>
            </div>
          </div>

          <Separator />

          {/* Author Filter */}
          <div className="space-y-2">
            <label className="text-sm font-medium flex items-center gap-2">
              <User className="w-4 h-4" />
              评论人筛选
            </label>
            <Input
              placeholder="搜索 @handle..."
              value={searchHandle}
              onChange={(e) => setSearchHandle(e.target.value)}
              className="h-9"
            />
            {topCommenters && topCommenters.length > 0 && (
              <div className="space-y-1 mt-2">
                <p className="text-xs text-muted-foreground">高频评论者</p>
                <div className="flex flex-wrap gap-1">
                  {topCommenters.slice(0, 5).map((commenter: any) => (
                    <Badge 
                      key={commenter.authorHandle} 
                      variant="secondary" 
                      className="text-xs cursor-pointer hover:bg-secondary/80"
                      onClick={() => setSearchHandle(commenter.authorHandle)}
                    >
                      @{commenter.authorHandle}
                    </Badge>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 flex flex-col">
        {/* Status Bar */}
        <div className="border-b bg-card/50 px-4 py-2 flex items-center justify-between flex-wrap gap-2">
          <div className="flex items-center gap-4">
            <Button
              variant="ghost"
              size="sm"
              className="lg:hidden"
              onClick={() => setShowFilters(!showFilters)}
            >
              <Filter className="w-4 h-4 mr-1" />
              筛选
            </Button>
            
            <div className="flex items-center gap-2 text-sm">
              <MessageSquare className="w-4 h-4 text-muted-foreground" />
              <span className="font-medium">{stats?.totalComments || 0}</span>
              <span className="text-muted-foreground">条评论</span>
              {stats?.analyzedComments !== undefined && (
                <span className="text-muted-foreground">
                  ({stats.analyzedComments} 已分析)
                </span>
              )}
            </div>

            {newCommentsCount > 0 && (
              <Badge variant="default" className="animate-pulse">
                +{newCommentsCount} 新评论
              </Badge>
            )}
          </div>

          <div className="flex items-center gap-3">
            <div className="text-xs text-muted-foreground">
              更新于 {lastUpdated}
            </div>
            
            <Select value={sortBy} onValueChange={(v) => setSortBy(v as SortOption)}>
              <SelectTrigger className="h-8 w-32">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SORT_OPTIONS.map(option => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Button variant="outline" size="sm" onClick={() => refetch()}>
              <RefreshCw className={`w-4 h-4 ${isLoading ? 'animate-spin' : ''}`} />
            </Button>

            <Button
              variant="ghost"
              size="sm"
              onClick={() => setShowAnalytics(!showAnalytics)}
            >
              <BarChart3 className="w-4 h-4 mr-1" />
              分析
              {showAnalytics ? <ChevronUp className="w-3 h-3 ml-1" /> : <ChevronDown className="w-3 h-3 ml-1" />}
            </Button>
          </div>
        </div>

        {/* Comments List */}
        <ScrollArea className="flex-1">
          <div className="p-4 space-y-3">
            {isLoading ? (
              <div className="flex items-center justify-center py-12">
                <RefreshCw className="w-6 h-6 animate-spin text-muted-foreground" />
              </div>
            ) : comments && comments.length > 0 ? (
              comments.map((comment: any) => (
                <CommentCard key={comment.replyId} comment={comment} />
              ))
            ) : (
              <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
                <AlertCircle className="w-12 h-12 mb-4 opacity-50" />
                <p className="text-lg font-medium">暂无评论数据</p>
                <p className="text-sm">请输入 Tweet ID 或导入评论数据</p>
              </div>
            )}
          </div>
        </ScrollArea>

        {/* Analytics Panel */}
        {showAnalytics && stats && (
          <div className="border-t">
            <AnalyticsPanel stats={stats} />
          </div>
        )}
      </main>
    </div>
  );
}
