import { useState, useEffect, useMemo, useRef } from "react";
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Calendar } from "@/components/ui/calendar";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { format } from "date-fns";
import { zhCN } from "date-fns/locale";
import { 
  RefreshCw, Clock, Filter, TrendingUp, BarChart3, 
  MessageSquare, Heart, User, ChevronDown, ChevronUp,
  AlertCircle, Sparkles, Search, Plus, Trash2, Play,
  Settings, Users, AtSign, CalendarIcon, Download
} from "lucide-react";
import { CommentCard } from "./CommentCard";
import { AnalyticsPanel } from "./AnalyticsPanel";

type SortOption = 'time_desc' | 'time_asc' | 'value_desc' | 'likes_desc';
type TimeRange = '10m' | '1h' | '24h' | '7d' | 'custom';
type Sentiment = 'positive' | 'neutral' | 'negative' | 'anger' | 'sarcasm';
type MonitorMode = 'username' | 'tweet';

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

interface MonitoredAccount {
  username: string;
  displayName?: string;
  isActive: boolean;
  lastFetched?: Date;
}

export function MonitorDashboard() {
  // Monitor mode and targets
  const [monitorMode, setMonitorMode] = useState<MonitorMode>('username');
  const [usernameInput, setUsernameInput] = useState("");
  // const [monitoredAccounts, setMonitoredAccounts] = useState<MonitoredAccount[]>([]); // Removed local state
  const { data: monitoredAccounts = [], refetch: refetchMonitors } = trpc.monitors.list.useQuery();
  const activeAccountState = useState<string | null>(null);
  const [activeAccount, setActiveAccount] = activeAccountState;

  // Sync active account with fetched monitors
  useEffect(() => {
    if (!activeAccount && monitoredAccounts.length > 0) {
      setActiveAccount(monitoredAccounts[0].targetId);
    }
  }, [monitoredAccounts, activeAccount]);

  const addMonitorMutation = trpc.monitors.add.useMutation({
    onSuccess: () => {
      toast.success("添加成功");
      refetchMonitors();
      setUsernameInput("");
    },
    onError: (error) => toast.error(`添加失败: ${error.message}`)
  });

  const deleteMonitorMutation = trpc.monitors.delete.useMutation({
    onSuccess: () => {
      toast.success("移除成功");
      refetchMonitors();
    },
    onError: (error) => toast.error(`移除失败: ${error.message}`)
  });

  const [tweetId, setTweetId] = useState<string>("");
  
  // Filter states
  const [searchHandle, setSearchHandle] = useState("");
  const [selectedSentiments, setSelectedSentiments] = useState<Sentiment[]>([]);
  const [valueRange, setValueRange] = useState<[number, number]>([0, 1]);
  const [timeRange, setTimeRange] = useState<TimeRange>('24h');
  const [sortBy, setSortBy] = useState<SortOption>('time_desc');
  const [showFilters, setShowFilters] = useState(true);
  const [showAnalytics, setShowAnalytics] = useState(true);
  const [showUnanalyzedOnly, setShowUnanalyzedOnly] = useState(false);
  const [refreshInterval, setRefreshInterval] = useState(30000);
  const [newCommentsCount, setNewCommentsCount] = useState(0);
  const [lastCommentCount, setLastCommentCount] = useState(0);
  const [isFetching, setIsFetching] = useState(false);
  const [fetchingTweetId, setFetchingTweetId] = useState<string | null>(null); // Tweet ID 模式下正在采集的 ID，用于进度轮询
  const [maxTweetsToFetch, setMaxTweetsToFetch] = useState(30); // 单次采集推文数，可 10/30/50/100，长期跑可多次点采集
  const [fetchProgress, setFetchProgress] = useState<{
    stage: string;
    message: string;
    tweetsFound: number;
    repliesFound: number;
    currentTweet: number;
    totalTweets: number;
    currentAccount?: number;
    totalAccounts?: number;
  } | null>(null);
  const prevCommentCountRef = useRef(0);

  const progressQueryKey = monitorMode === 'username' ? (activeAccount || '') : (fetchingTweetId ? `tweet:${fetchingTweetId}` : '');
  const { data: scrapeProgressData } = trpc.twitter.getScrapeProgress.useQuery(
    { username: progressQueryKey },
    {
      enabled: (isFetching && !!activeAccount) || !!fetchingTweetId,
      refetchInterval: 1000,
    }
  );

  useEffect(() => {
    const p = scrapeProgressData?.progress as any;
    if (p) setFetchProgress(p);
    if (p?.stage === "error") {
      toast.error(p?.message || "采集失败");
      setIsFetching(false);
      setFetchingTweetId(null);
    }
    if (p?.stage === "complete") {
      setIsFetching(false);
      setFetchingTweetId(null);
    }
  }, [scrapeProgressData, isFetching, fetchingTweetId]);
  
  // Custom time range states
  const [customStartDate, setCustomStartDate] = useState<Date | undefined>(undefined);
  const [customEndDate, setCustomEndDate] = useState<Date | undefined>(undefined);
  const [customStartTime, setCustomStartTime] = useState("00:00");
  const [customEndTime, setCustomEndTime] = useState("23:59");

  // Calculate time filter
  const timeFilter = useMemo(() => {
    const now = new Date();
    switch (timeRange) {
      case '10m': return new Date(now.getTime() - 10 * 60 * 1000);
      case '1h': return new Date(now.getTime() - 60 * 60 * 1000);
      case '24h': return new Date(now.getTime() - 24 * 60 * 60 * 1000);
      case '7d': return new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      case 'custom': {
        if (customStartDate) {
          const [hours, minutes] = customStartTime.split(':').map(Number);
          const startDate = new Date(customStartDate);
          startDate.setHours(hours, minutes, 0, 0);
          return startDate;
        }
        return undefined;
      }
      default: return undefined;
    }
  }, [timeRange, customStartDate, customStartTime]);

  // Calculate end time filter for custom range
  const timeFilterEnd = useMemo(() => {
    if (timeRange === 'custom' && customEndDate) {
      const [hours, minutes] = customEndTime.split(':').map(Number);
      const endDate = new Date(customEndDate);
      endDate.setHours(hours, minutes, 59, 999);
      return endDate;
    }
    return undefined;
  }, [timeRange, customEndDate, customEndTime]);

  const utils = trpc.useUtils();
  // Smart fetch mutation - 定义在 list 查询前，便于用 isPending 驱动采集期间短间隔轮询
  const smartFetch = trpc.twitter.smartFetch.useMutation({
    onSuccess: (data) => {
      if (data.success) {
        const method = data.method === 'playwright' ? 'Playwright 自爬' : 'Apify API';
        toast.success(data.message || `使用 ${method} 成功获取 ${data.commentsCount} 条评论`);
        void utils.comments.list.invalidate();
        void utils.comments.stats.invalidate();
      } else {
        toast.error(data.error || "获取失败");
      }
      setIsFetching(false);
      setFetchProgress(null);
    },
    onError: (error) => {
      toast.error(`获取失败: ${error.message}`);
      setIsFetching(false);
      setFetchProgress(null);
    },
  });

  const scrapeByTweetId = trpc.twitter.scrapeByTweetId.useMutation({
    onSuccess: (data) => {
      if (data.success) {
        toast.success(data.message || `已采集 ${data.commentsCount} 条评论，可查看与导出`);
        void utils.comments.list.invalidate();
        void utils.comments.stats.invalidate();
      } else {
        toast.error(data.error || "采集失败");
      }
      setFetchingTweetId(null);
      setFetchProgress(null);
    },
    onError: (error) => {
      toast.error(`采集失败: ${error.message}`);
      setFetchingTweetId(null);
      setFetchProgress(null);
    },
  });

  const scraping = isFetching || smartFetch.isPending || scrapeByTweetId.isPending; // 采集中：短间隔轮询

  // Fetch comments（采集中 250ms 轮询，每采到一条就刷新列表，新评论出现在顶部）
  const { data: comments, isLoading, refetch, dataUpdatedAt } = trpc.comments.list.useQuery({
    tweetId: tweetId || undefined,
    rootTweetAuthor: monitorMode === 'username' && activeAccount ? activeAccount : undefined,
    sentiments: selectedSentiments.length > 0 ? selectedSentiments : undefined,
    minValueScore: valueRange[0],
    maxValueScore: valueRange[1],
    startTime: timeFilter,
    sortBy,
    limit: 100,
    analyzed: showUnanalyzedOnly ? false : undefined,
  }, {
    refetchInterval: scraping ? 250 : refreshInterval,
    refetchIntervalInBackground: scraping,
  });

  // Fetch stats（与 list 同口径，采集中与列表同频刷新）
  const { data: stats } = trpc.comments.stats.useQuery({
    tweetId: tweetId || undefined,
    rootTweetAuthor: monitorMode === 'username' && activeAccount ? activeAccount : undefined,
  }, {
    refetchInterval: scraping ? 250 : refreshInterval,
    refetchIntervalInBackground: scraping,
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
  useEffect(() => {
    if (comments && comments.length > lastCommentCount && lastCommentCount > 0) {
      setNewCommentsCount(comments.length - lastCommentCount);
    }
    if (comments) {
      setLastCommentCount(comments.length);
    }
  }, [comments?.length, lastCommentCount]);

  // 采集中每刷新出更多评论时，将列表滚动到顶部，方便看到刚采集到的新评论（新评论在顶部）
  useEffect(() => {
    const count = comments?.length ?? 0;
    if (scraping && count > prevCommentCountRef.current && prevCommentCountRef.current >= 0) {
      const viewport = document.querySelector('[data-slot="scroll-area-viewport"]');
      if (viewport) viewport.scrollTo({ top: 0, behavior: 'smooth' });
    }
    prevCommentCountRef.current = count;
  }, [scraping, comments?.length]);

  // Add account to monitor
  const addAccount = () => {
    const username = usernameInput.trim().replace('@', '');
    if (!username) {
      toast.error("请输入用户名");
      return;
    }
    if (monitoredAccounts.some(a => a.targetId.toLowerCase() === username.toLowerCase())) {
      toast.error("该账号已在监控列表中");
      return;
    }
    
    addMonitorMutation.mutate({
      type: "account",
      targetId: username,
      targetHandle: username,
      targetName: username
    });
  };

  // Remove account from monitor
  const removeAccount = (id: number, username: string) => {
    deleteMonitorMutation.mutate({ id });
    if (activeAccount === username) {
      setActiveAccount(null);
    }
  };

  // Start fetching comments for account
  const startFetching = async (username: string) => {
    setIsFetching(true);
    setActiveAccount(username);
    setFetchProgress({
      stage: 'init',
      message: '正在初始化...',
      tweetsFound: 0,
      repliesFound: 0,
      currentTweet: 0,
      totalTweets: maxTweetsToFetch,
    });
    // 使用智能采集，优先 Playwright，备选 Apify；可多次运行拉取更多历史（单次最多 100 条推文）
    smartFetch.mutate({ 
      username, 
      maxTweets: maxTweetsToFetch, 
      maxRepliesPerTweet: 0, // 0 = 不限制，每条推文评论最多 300 条
      preferredMethod: 'playwright' 
    });
  };

  // Export comments to Excel（调用 exportData 接口，无条数限制，与当前筛选条件一致）
  const handleExportExcel = async () => {
    try {
      const list = await utils.comments.exportData.fetch({
        tweetId: tweetId || undefined,
        rootTweetAuthor: monitorMode === 'username' && activeAccount ? activeAccount : undefined,
        startTime: timeFilter,
        endTime: timeFilterEnd,
        sentiments: selectedSentiments.length > 0 ? selectedSentiments : undefined,
        minValueScore: valueRange[0],
        maxValueScore: valueRange[1],
        analyzed: showUnanalyzedOnly ? false : undefined,
      });
      if (!list || list.length === 0) {
        toast.error("没有可导出的评论数据");
        return;
      }

      const XLSX = await import('xlsx');
      const exportData = list.map((comment: any) => ({
        '评论 ID': comment.replyId,
        '推文 ID': comment.tweetId,
        '作者名称': comment.authorName,
        '作者用户名': `@${comment.authorHandle}`,
        '评论内容': comment.text,
        '发布时间': comment.createdAt ? new Date(comment.createdAt).toLocaleString('zh-CN') : '',
        '点赞数': comment.likeCount || 0,
        '情绪类型': comment.sentiment || '未分析',
        '价值评分': comment.valueScore || '',
        'AI 摘要': comment.summary || '',
        '分析时间': comment.analyzedAt ? new Date(comment.analyzedAt).toLocaleString('zh-CN') : '',
      }));

      const ws = XLSX.utils.json_to_sheet(exportData);
      ws['!cols'] = [
        { wch: 20 }, { wch: 20 }, { wch: 15 }, { wch: 15 }, { wch: 50 },
        { wch: 20 }, { wch: 8 }, { wch: 10 }, { wch: 10 }, { wch: 30 }, { wch: 20 },
      ];
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, '评论数据');
      const timestamp = new Date().toISOString().slice(0, 10);
      const filename = `X评论导出_${activeAccount || 'all'}_${timestamp}.xlsx`;
      XLSX.writeFile(wb, filename);
      toast.success(`已导出 ${exportData.length} 条评论`);
    } catch (error) {
      console.error('Export error:', error);
      toast.error('导出失败，请重试');
    }
  };

  return (
    <div className="flex flex-col lg:flex-row min-h-[calc(100vh-3.5rem)]">
      {/* Left Sidebar - Filters */}
      <aside className={`lg:w-80 border-r bg-card/30 transition-all ${showFilters ? '' : 'lg:w-0 lg:overflow-hidden'}`}>
        <div className="p-4 space-y-4">
          {/* Monitor Mode Tabs */}
          <Tabs value={monitorMode} onValueChange={(v) => setMonitorMode(v as MonitorMode)}>
            <TabsList className="w-full">
              <TabsTrigger value="username" className="flex-1">
                <AtSign className="w-4 h-4 mr-1" />
                用户名
              </TabsTrigger>
              <TabsTrigger value="tweet" className="flex-1">
                <MessageSquare className="w-4 h-4 mr-1" />
                Tweet ID
              </TabsTrigger>
            </TabsList>

            <TabsContent value="username" className="space-y-3 mt-3">
              <div className="flex gap-2">
                <Input
                  placeholder="输入 X 用户名"
                  value={usernameInput}
                  onChange={(e) => setUsernameInput(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && addAccount()}
                  className="h-9"
                />
                <Button size="sm" onClick={addAccount} className="h-9 px-3">
                  <Plus className="w-4 h-4" />
                </Button>
              </div>

              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-xs text-muted-foreground">单次采集</span>
                <Select value={String(maxTweetsToFetch)} onValueChange={(v) => setMaxTweetsToFetch(Number(v))}>
                  <SelectTrigger className="h-8 w-[88px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="10">10 条推文</SelectItem>
                    <SelectItem value="30">30 条推文</SelectItem>
                    <SelectItem value="50">50 条推文</SelectItem>
                    <SelectItem value="100">100 条推文</SelectItem>
                  </SelectContent>
                </Select>
                <span className="text-xs text-muted-foreground">可多次运行拉取更多历史</span>
              </div>

              {/* Monitored Accounts List */}
              {monitoredAccounts.length > 0 && (
                <div className="space-y-2">
                  <p className="text-xs text-muted-foreground font-medium">监控账号列表</p>
                  <div className="space-y-1">
                    {monitoredAccounts.map((account) => (
                      <div 
                        key={account.id}
                        className={`flex items-center justify-between p-2 rounded-md cursor-pointer transition-colors ${
                          activeAccount === account.targetId 
                            ? 'bg-primary/10 border border-primary/30' 
                            : 'bg-muted/50 hover:bg-muted'
                        }`}
                        onClick={() => setActiveAccount(account.targetId)}
                      >
                        <div className="flex items-center gap-2">
                          <User className="w-4 h-4 text-muted-foreground" />
                          <span className="text-sm font-medium">@{account.targetId}</span>
                        </div>
                        <div className="flex items-center gap-1">
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 w-7 p-0"
                            onClick={(e) => {
                              e.stopPropagation();
                              startFetching(account.targetId);
                            }}
                            disabled={isFetching}
                          >
                            <Play className={`w-3 h-3 ${isFetching && activeAccount === account.targetId ? 'animate-pulse' : ''}`} />
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 w-7 p-0 text-destructive hover:text-destructive"
                            onClick={(e) => {
                              e.stopPropagation();
                              removeAccount(account.id, account.targetId);
                            }}
                          >
                            <Trash2 className="w-3 h-3" />
                          </Button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {monitoredAccounts.length === 0 && (
                <div className="text-center py-6 text-muted-foreground">
                  <Users className="w-8 h-8 mx-auto mb-2 opacity-50" />
                  <p className="text-sm">添加 X 用户名开始监控</p>
                  <p className="text-xs mt-1"></p>
                </div>
              )}
            </TabsContent>

            <TabsContent value="tweet" className="space-y-3 mt-3">
              <Input
                placeholder="输入 Tweet ID"
                value={tweetId}
                onChange={(e) => setTweetId(e.target.value)}
                className="h-9"
              />
              <p className="text-xs text-muted-foreground">
                Tweet ID 是推文链接中的数字，例如: x.com/user/status/<strong>1234567890</strong>
              </p>
              <Button
                size="sm"
                className="w-full"
                onClick={() => {
                  const id = tweetId.trim();
                  if (!id) {
                    toast.error("请输入 Tweet ID");
                    return;
                  }
                  setFetchingTweetId(id);
                  setFetchProgress({ stage: 'init', message: '正在初始化...', tweetsFound: 0, repliesFound: 0, currentTweet: 1, totalTweets: 1 });
                  scrapeByTweetId.mutate({ tweetId: id });
                }}
                disabled={scrapeByTweetId.isPending || !tweetId.trim()}
              >
                {scrapeByTweetId.isPending && fetchingTweetId === tweetId.trim() ? (
                  <>采集中...</>
                ) : (
                  <>采集该推文下全部评论</>
                )}
              </Button>
            </TabsContent>
          </Tabs>

          <Separator />

          {/* Status Filter */}
          <div className="space-y-3">
            <label className="text-sm font-medium flex items-center gap-2">
              <Filter className="w-4 h-4" />
              状态筛选
            </label>
            <p className="text-xs text-muted-foreground">默认显示全部评论</p>
            <div className="flex items-center space-x-2">
              <Checkbox 
                id="unanalyzed" 
                checked={showUnanalyzedOnly}
                onCheckedChange={(checked) => setShowUnanalyzedOnly(!!checked)}
              />
              <label
                htmlFor="unanalyzed"
                className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70 cursor-pointer"
              >
                只显示未分析评论
              </label>
            </div>
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
            
            {/* Custom Time Range Picker */}
            {timeRange === 'custom' && (
              <div className="space-y-3 p-3 bg-muted/50 rounded-lg mt-2">
                {/* Start Date */}
                <div className="space-y-1">
                  <Label className="text-xs">开始时间</Label>
                  <div className="flex gap-2">
                    <Popover>
                      <PopoverTrigger asChild>
                        <Button variant="outline" size="sm" className="flex-1 justify-start text-left font-normal h-8">
                          <CalendarIcon className="mr-2 h-3 w-3" />
                          {customStartDate ? format(customStartDate, "yyyy-MM-dd", { locale: zhCN }) : "选择日期"}
                        </Button>
                      </PopoverTrigger>
                      <PopoverContent className="w-auto p-0" align="start">
                        <Calendar
                          mode="single"
                          selected={customStartDate}
                          onSelect={setCustomStartDate}
                          initialFocus
                        />
                      </PopoverContent>
                    </Popover>
                    <Input
                      type="time"
                      value={customStartTime}
                      onChange={(e) => setCustomStartTime(e.target.value)}
                      className="w-24 h-8 text-xs"
                    />
                  </div>
                </div>
                
                {/* End Date */}
                <div className="space-y-1">
                  <Label className="text-xs">结束时间</Label>
                  <div className="flex gap-2">
                    <Popover>
                      <PopoverTrigger asChild>
                        <Button variant="outline" size="sm" className="flex-1 justify-start text-left font-normal h-8">
                          <CalendarIcon className="mr-2 h-3 w-3" />
                          {customEndDate ? format(customEndDate, "yyyy-MM-dd", { locale: zhCN }) : "选择日期"}
                        </Button>
                      </PopoverTrigger>
                      <PopoverContent className="w-auto p-0" align="start">
                        <Calendar
                          mode="single"
                          selected={customEndDate}
                          onSelect={setCustomEndDate}
                          initialFocus
                        />
                      </PopoverContent>
                    </Popover>
                    <Input
                      type="time"
                      value={customEndTime}
                      onChange={(e) => setCustomEndTime(e.target.value)}
                      className="w-24 h-8 text-xs"
                    />
                  </div>
                </div>
              </div>
            )}
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

            {activeAccount && (
              <Badge variant="outline" className="font-normal">
                <AtSign className="w-3 h-3 mr-1" />
                {activeAccount}
              </Badge>
            )}

            {newCommentsCount > 0 && (
              <Badge variant="default" className="animate-pulse">
                +{newCommentsCount} 新评论
              </Badge>
            )}

            {(isFetching || (scrapeByTweetId.isPending && !!fetchingTweetId)) && (
              <div className="flex items-center gap-2">
                <Badge variant="secondary" className="animate-pulse">
                  <RefreshCw className="w-3 h-3 mr-1 animate-spin" />
                  {fetchProgress?.message || '正在获取...'}
                </Badge>
                {fetchProgress && (fetchProgress.tweetsFound > 0 || fetchProgress.repliesFound > 0) && (
                  <span className="text-xs text-muted-foreground">
                    {fetchProgress.totalTweets > 1
                      ? `推文: ${fetchProgress.currentTweet}/${fetchProgress.totalTweets} | 评论: ${fetchProgress.repliesFound}`
                      : `评论: ${fetchProgress.repliesFound}`}
                  </span>
                )}
              </div>
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

            <Button
              variant="outline"
              size="sm"
              onClick={handleExportExcel}
              disabled={!(stats?.totalComments && stats.totalComments > 0)}
            >
              <Download className="w-4 h-4 mr-1" />
              导出
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
                <p className="text-sm mt-2">
                  {monitorMode === 'username' 
                    ? '请添加用户名并点击播放按钮开始获取评论' 
                    : '请输入 Tweet ID 查看评论'}
                </p>
                <p className="text-xs mt-4 text-muted-foreground/70">
                  提示：在设置页面配置 X Cookie（免费）或 Apify Token（付费）即可自动采集
                </p>
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
