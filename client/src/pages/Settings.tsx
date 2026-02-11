import { useState, useEffect } from "react";
import { useAuth } from "@/_core/hooks/useAuth";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { ArrowLeft, Save, Upload, Key, Bot, RefreshCw, ExternalLink, CheckCircle, AlertCircle, Globe, Cookie, Plus, Trash2, Users } from "lucide-react";
import { Link } from "wouter";
import { getLoginUrl } from "@/const";

export default function Settings() {
  const { user, isAuthenticated } = useAuth();
  const [importData, setImportData] = useState("");
  const [tweetId, setTweetId] = useState("");
  const [isImporting, setIsImporting] = useState(false);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [apifyToken, setApifyToken] = useState("");
  const [apifyTokenSaved, setApifyTokenSaved] = useState(false);
  const [proxyUrl, setProxyUrl] = useState("");

  // 多账号 Cookie 管理
  const [xCookiesList, setXCookiesList] = useState<string[]>([""]);
  const [xCookiesSaved, setXCookiesSaved] = useState(false);

  // Fetch existing configs
  const { data: existingApifyToken } = trpc.config.get.useQuery(
    { key: "APIFY_API_TOKEN" },
    { enabled: isAuthenticated }
  );

  const { data: existingXCookies } = trpc.config.get.useQuery(
    { key: "X_COOKIES" },
    { enabled: isAuthenticated }
  );

  const { data: existingXCookiesList } = trpc.config.get.useQuery(
    { key: "X_COOKIES_LIST" },
    { enabled: isAuthenticated }
  );

  const { data: existingProxyUrl } = trpc.config.get.useQuery(
    { key: "PLAYWRIGHT_PROXY" },
    { enabled: isAuthenticated }
  );

  useEffect(() => {
    if (existingApifyToken) {
      setApifyTokenSaved(true);
    }
  }, [existingApifyToken]);

  useEffect(() => {
    if (existingXCookies) {
      setXCookiesSaved(true);
    }
  }, [existingXCookies]);

  useEffect(() => {
    if (existingXCookiesList) {
      try {
        const list = JSON.parse(existingXCookiesList);
        if (Array.isArray(list) && list.length > 0) {
          setXCookiesList(list);
        }
      } catch (e) {
        // Ignore parse errors
      }
    }
  }, [existingXCookiesList]);

  useEffect(() => {
    if (existingProxyUrl !== undefined) setProxyUrl(existingProxyUrl || "");
  }, [existingProxyUrl]);

  // Config mutations
  const setConfigMutation = trpc.config.set.useMutation({
    onSuccess: () => {
      toast.success("配置已保存");
    },
    onError: (err) => {
      const msg = err.message || "";
      if (msg.includes("login") || msg.includes("10001") || msg.includes("UNAUTHORIZED")) {
        toast.error("保存失败：请先登录后再保存配置");
      } else {
        toast.error(`保存失败: ${msg}`);
      }
    },
  });

  // Delete config mutation
  const deleteConfigMutation = trpc.config.delete.useMutation({
    onSuccess: () => {
      toast.success("配置已清空");
    },
    onError: (err) => toast.error(`清空失败: ${err.message}`),
  });

  // Import comments mutation
  const importMutation = trpc.twitter.importComments.useMutation({
    onSuccess: (data) => {
      toast.success(`成功导入 ${data.imported} 条评论`);
      setImportData("");
      setTweetId("");
    },
    onError: (err) => toast.error(`导入失败: ${err.message}`),
  });

  // Analyze mutation
  const analyzeMutation = trpc.analysis.analyzeUnanalyzed.useMutation({
    onSuccess: (data: { analyzed: number }) => {
      toast.success(`成功分析 ${data.analyzed} 条评论`);
    },
    onError: (err: any) => toast.error(`分析失败: ${err.message}`),
  });

  const handleImport = async () => {
    if (!tweetId.trim()) {
      toast.error("请输入 Tweet ID");
      return;
    }
    if (!importData.trim()) {
      toast.error("请输入评论数据");
      return;
    }

    setIsImporting(true);
    try {
      const comments = JSON.parse(importData);
      if (!Array.isArray(comments)) {
        throw new Error("数据格式错误，需要是数组");
      }
      await importMutation.mutateAsync({ tweetId, comments });
    } catch (err: any) {
      toast.error(`解析失败: ${err.message}`);
    } finally {
      setIsImporting(false);
    }
  };

  const handleAnalyze = async () => {
    setIsAnalyzing(true);
    try {
      await analyzeMutation.mutateAsync({ limit: 10 });
    } finally {
      setIsAnalyzing(false);
    }
  };

  // 添加新账号
  const handleAddAccount = () => {
    setXCookiesList([...xCookiesList, ""]);
  };

  // 删除账号
  const handleRemoveAccount = (index: number) => {
    if (xCookiesList.length <= 1) {
      toast.error("至少需要保留一个账号");
      return;
    }
    const newList = xCookiesList.filter((_, i) => i !== index);
    setXCookiesList(newList);
  };

  // 更新账号 Cookie
  const handleUpdateAccountCookie = (index: number, value: string) => {
    const newList = [...xCookiesList];
    newList[index] = value;
    setXCookiesList(newList);
  };

  // 保存所有账号 Cookie
  const handleSaveAllCookies = async () => {
    const validCookies = xCookiesList.filter(c => c.trim());
    if (validCookies.length === 0) {
      toast.error("请至少配置一个有效的 Cookie");
      return;
    }

    // 保存第一个作为主 Cookie
    await setConfigMutation.mutateAsync({
      key: "X_COOKIES",
      value: validCookies[0],
      description: "Primary X/Twitter Cookie for Playwright scraping",
    });

    // 保存完整列表
    await setConfigMutation.mutateAsync({
      key: "X_COOKIES_LIST",
      value: JSON.stringify(validCookies),
      description: "List of X/Twitter Cookies for rotation",
    });

    setXCookiesSaved(true);
    toast.success(`已保存 ${validCookies.length} 个账号的 Cookie`);
  };

  const handleSaveApifyToken = () => {
    if (!apifyToken.trim()) {
      toast.error("请输入 Apify API Token");
      return;
    }
    setConfigMutation.mutate({
      key: "APIFY_API_TOKEN",
      value: apifyToken.trim(),
      description: "Apify API Token for Twitter data collection",
    });
    setApifyTokenSaved(true);
  };

  const handleClearApifyToken = async () => {
    await deleteConfigMutation.mutateAsync({ key: "APIFY_API_TOKEN" });
    setApifyToken("");
    setApifyTokenSaved(false);
  };

  if (!isAuthenticated) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <Card className="w-96">
          <CardHeader>
            <CardTitle>需要登录</CardTitle>
            <CardDescription>请先登录以访问设置页面</CardDescription>
          </CardHeader>
          <CardContent>
            <Button asChild className="w-full">
              <a href={getLoginUrl()}>登录</a>
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="border-b bg-card/50 backdrop-blur-sm sticky top-0 z-50">
        <div className="container flex items-center h-14 gap-4">
          <Link href="/">
            <Button variant="ghost" size="sm">
              <ArrowLeft className="w-4 h-4 mr-2" />
              返回
            </Button>
          </Link>
          <h1 className="font-semibold">系统设置</h1>
        </div>
      </header>

      <main className="container py-6">
        <Tabs defaultValue="api" className="space-y-6">
          <TabsList>
            <TabsTrigger value="api">
              <Key className="w-4 h-4 mr-2" />
              采集配置
            </TabsTrigger>
            <TabsTrigger value="import">
              <Upload className="w-4 h-4 mr-2" />
              数据导入
            </TabsTrigger>
            <TabsTrigger value="analysis">
              <Bot className="w-4 h-4 mr-2" />
              AI 分析
            </TabsTrigger>
          </TabsList>

          {/* API Config Tab */}
          <TabsContent value="api">
            <div className="space-y-6">
              {/* Priority Notice */}
              <div className="p-4 bg-gradient-to-r from-green-50 to-blue-50 dark:from-green-900/20 dark:to-blue-900/20 rounded-lg border border-green-200 dark:border-green-800">
                <h3 className="font-medium text-green-800 dark:text-green-200 mb-2">
                  采集优先级说明
                </h3>
                <p className="text-sm text-green-700 dark:text-green-300">
                  系统会<strong>优先使用 Playwright 自爬</strong>（免费），如果失败则自动切换到 Apify API（付费）。
                  支持配置多个 X 账号 Cookie，系统会自动轮换使用以降低单账号被封风险。
                </p>
              </div>

              {/* 采集代理（可选） */}
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Globe className="w-5 h-5" />
                    采集代理（可选）
                  </CardTitle>
                  <CardDescription>
                    访问 X 需代理时填写，例如 <code className="text-xs bg-muted px-1 rounded">http://127.0.0.1:7897</code>。留空则使用环境变量 HTTPS_PROXY 或直连。保存后下次采集会自动使用新代理。
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="flex gap-2">
                    <Input
                      placeholder="http://127.0.0.1:7897"
                      value={proxyUrl}
                      onChange={(e) => setProxyUrl(e.target.value)}
                      className="font-mono"
                    />
                    <Button
                      onClick={() => setConfigMutation.mutate({ key: "PLAYWRIGHT_PROXY", value: proxyUrl.trim() })}
                      disabled={setConfigMutation.isPending}
                    >
                      {setConfigMutation.isPending ? (
                        <RefreshCw className="w-4 h-4 mr-2 animate-spin" />
                      ) : (
                        <Save className="w-4 h-4 mr-2" />
                      )}
                      保存
                    </Button>
                  </div>
                </CardContent>
              </Card>

              {/* X Cookies Config - Multiple Accounts */}
              <Card className="border-green-500/50">
                <CardHeader>
                  <div className="flex items-center justify-between">
                    <div>
                      <CardTitle className="flex items-center gap-2">
                        <Users className="w-5 h-5" />
                        多账号 Cookie 配置（免费自爬）
                        {xCookiesSaved && (
                          <Badge variant="secondary" className="text-green-600">
                            <CheckCircle className="w-3 h-3 mr-1" />
                            已配置 {xCookiesList.filter(c => c.trim()).length} 个账号
                          </Badge>
                        )}
                      </CardTitle>
                      <CardDescription>
                        配置多个 X/Twitter 账号 Cookie，系统会自动轮换使用
                      </CardDescription>
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="p-4 bg-green-50 dark:bg-green-900/20 rounded-lg border border-green-200 dark:border-green-800">
                    <h3 className="font-medium text-green-800 dark:text-green-200 mb-2">
                      多账号轮换说明
                    </h3>
                    <ul className="text-sm text-green-700 dark:text-green-300 space-y-1">
                      <li>• 配置多个账号可以分散采集压力，降低单账号被封风险</li>
                      <li>• 系统会自动轮换使用不同账号进行采集</li>
                      <li>• 建议使用小号，避免主账号被封</li>
                      <li>• 每个账号的 Cookie 格式相同</li>
                    </ul>
                    <Link href="/cookie-guide">
                      <Button variant="link" className="p-0 h-auto text-green-700 dark:text-green-300 mt-2">
                        📖 查看 Cookie 获取教程
                      </Button>
                    </Link>
                  </div>

                  {/* 账号列表 */}
                  <div className="space-y-4">
                    {xCookiesList.map((cookie, index) => (
                      <div key={index} className="space-y-2 p-4 border rounded-lg bg-card">
                        <div className="flex items-center justify-between">
                          <Label className="flex items-center gap-2">
                            <Cookie className="w-4 h-4" />
                            账号 {index + 1}
                            {index === 0 && (
                              <Badge variant="outline" className="text-xs">主账号</Badge>
                            )}
                          </Label>
                          {xCookiesList.length > 1 && (
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => handleRemoveAccount(index)}
                              className="text-red-500 hover:text-red-700"
                            >
                              <Trash2 className="w-4 h-4" />
                            </Button>
                          )}
                        </div>
                        <Textarea
                          placeholder={`[{"name":"auth_token","value":"xxx"},{"name":"ct0","value":"xxx"}]`}
                          value={cookie}
                          onChange={(e) => handleUpdateAccountCookie(index, e.target.value)}
                          className="min-h-[80px] font-mono text-sm"
                        />
                      </div>
                    ))}
                  </div>

                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      onClick={handleAddAccount}
                      className="flex-1"
                    >
                      <Plus className="w-4 h-4 mr-2" />
                      添加账号
                    </Button>
                    <Button
                      onClick={handleSaveAllCookies}
                      disabled={setConfigMutation.isPending}
                      className="flex-1"
                    >
                      {setConfigMutation.isPending ? (
                        <RefreshCw className="w-4 h-4 mr-2 animate-spin" />
                      ) : (
                        <Save className="w-4 h-4 mr-2" />
                      )}
                      保存所有账号
                    </Button>
                  </div>

                  {!xCookiesSaved && (
                    <div className="flex items-center gap-2 p-3 bg-yellow-50 dark:bg-yellow-900/20 rounded-lg border border-yellow-200 dark:border-yellow-800">
                      <AlertCircle className="w-4 h-4 text-yellow-600" />
                      <p className="text-sm text-yellow-700 dark:text-yellow-300">
                        未配置 X Cookie，Playwright 自爬可能无法获取完整数据
                      </p>
                    </div>
                  )}
                </CardContent>
              </Card>

              {/* Apify Config Card - Backup (Paid) */}
              <Card>
                <CardHeader>
                  <div className="flex items-center justify-between">
                    <div>
                      <CardTitle className="flex items-center gap-2">
                        <Globe className="w-5 h-5" />
                        Apify API 配置（备选付费）
                        {apifyTokenSaved && (
                          <Badge variant="secondary" className="text-blue-600">
                            <CheckCircle className="w-3 h-3 mr-1" />
                            已配置
                          </Badge>
                        )}
                      </CardTitle>
                      <CardDescription>
                        配置 Apify API Token 作为备选采集方案
                      </CardDescription>
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="p-4 bg-blue-50 dark:bg-blue-900/20 rounded-lg border border-blue-200 dark:border-blue-800">
                    <h3 className="font-medium text-blue-800 dark:text-blue-200 mb-2">
                      如何获取 Apify API Token
                    </h3>
                    <ol className="text-sm text-blue-700 dark:text-blue-300 space-y-2 list-decimal list-inside">
                      <li>
                        访问{" "}
                        <a
                          href="https://apify.com"
                          target="_blank"
                          rel="noopener noreferrer"
                          className="underline inline-flex items-center gap-1"
                        >
                          Apify.com
                          <ExternalLink className="w-3 h-3" />
                        </a>{" "}
                        并注册账号
                      </li>
                      <li>进入 Settings → Integrations → API Tokens</li>
                      <li>创建新的 API Token 并复制</li>
                    </ol>
                    <p className="text-xs mt-3 text-blue-600 dark:text-blue-400">
                      定价：约 $0.016/次查询 + $0.0004-0.002/条数据
                    </p>
                  </div>

                  <div className="space-y-2">
                    <Label>Apify API Token</Label>
                    <div className="flex gap-2">
                      <Input
                        type="password"
                        placeholder={apifyTokenSaved ? "••••••••••••••••" : "输入 Apify API Token"}
                        value={apifyToken}
                        onChange={(e) => setApifyToken(e.target.value)}
                        className="flex-1"
                      />
                      <Button onClick={handleSaveApifyToken} disabled={setConfigMutation.isPending}>
                        {setConfigMutation.isPending ? (
                          <RefreshCw className="w-4 h-4 animate-spin" />
                        ) : (
                          <Save className="w-4 h-4" />
                        )}
                      </Button>
                      {apifyTokenSaved && (
                        <Button 
                          variant="destructive" 
                          onClick={handleClearApifyToken} 
                          disabled={deleteConfigMutation.isPending}
                        >
                          {deleteConfigMutation.isPending ? (
                            <RefreshCw className="w-4 h-4 animate-spin" />
                          ) : (
                            <Trash2 className="w-4 h-4" />
                          )}
                        </Button>
                      )}
                    </div>
                    {apifyTokenSaved && (
                      <p className="text-xs text-muted-foreground">
                        点击红色垃圾桶按钮可以清空 Apify 配置
                      </p>
                    )}
                  </div>
                </CardContent>
              </Card>
            </div>
          </TabsContent>

          {/* Data Import Tab */}
          <TabsContent value="import">
            <Card>
              <CardHeader>
                <CardTitle>手动导入评论数据</CardTitle>
                <CardDescription>
                  如果自动采集不可用，可以手动导入 X/Twitter 评论数据（JSON 格式）
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <Label>Tweet ID</Label>
                  <Input
                    placeholder="输入要关联的 Tweet ID"
                    value={tweetId}
                    onChange={(e) => setTweetId(e.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <Label>评论数据 (JSON)</Label>
                  <Textarea
                    placeholder={`[
  {
    "replyId": "123456789",
    "authorId": "user123",
    "authorName": "用户名",
    "authorHandle": "username",
    "text": "评论内容",
    "createdAt": "2024-01-01T12:00:00Z",
    "likeCount": 10
  }
]`}
                    value={importData}
                    onChange={(e) => setImportData(e.target.value)}
                    className="min-h-[200px] font-mono text-sm"
                  />
                </div>
                <Button onClick={handleImport} disabled={isImporting}>
                  {isImporting ? (
                    <RefreshCw className="w-4 h-4 mr-2 animate-spin" />
                  ) : (
                    <Upload className="w-4 h-4 mr-2" />
                  )}
                  导入数据
                </Button>
              </CardContent>
            </Card>
          </TabsContent>

          {/* AI Analysis Tab */}
          <TabsContent value="analysis">
            <Card>
              <CardHeader>
                <CardTitle>AI 分析设置</CardTitle>
                <CardDescription>
                  配置 AI 分析参数并手动触发分析
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="p-4 bg-secondary/50 rounded-lg">
                  <h3 className="font-medium mb-2">分析说明</h3>
                  <ul className="text-sm text-muted-foreground space-y-1">
                    <li>• 系统使用内置 LLM 对评论进行情绪分析</li>
                    <li>• 情绪类型：支持、中立、批评、愤怒、讽刺</li>
                    <li>• 价值评分：0-1 分，评估评论的信息价值</li>
                    <li>• AI 会为每条评论生成一句话摘要</li>
                  </ul>
                </div>
                <Button onClick={handleAnalyze} disabled={isAnalyzing}>
                  {isAnalyzing ? (
                    <RefreshCw className="w-4 h-4 mr-2 animate-spin" />
                  ) : (
                    <Bot className="w-4 h-4 mr-2" />
                  )}
                  分析未处理评论 (最多 10 条)
                </Button>
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </main>
    </div>
  );
}
