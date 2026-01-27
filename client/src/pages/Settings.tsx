import { useState } from "react";
import { useAuth } from "@/_core/hooks/useAuth";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { toast } from "sonner";
import { ArrowLeft, Save, Upload, Key, Database, Bot, RefreshCw } from "lucide-react";
import { Link } from "wouter";
import { getLoginUrl } from "@/const";

export default function Settings() {
  const { user, isAuthenticated } = useAuth();
  const [importData, setImportData] = useState("");
  const [tweetId, setTweetId] = useState("");
  const [isImporting, setIsImporting] = useState(false);
  const [isAnalyzing, setIsAnalyzing] = useState(false);

  // Config mutations
  const setConfigMutation = trpc.config.set.useMutation({
    onSuccess: () => toast.success("配置已保存"),
    onError: (err) => toast.error(`保存失败: ${err.message}`),
  });

  // Import comments mutation
  const importMutation = trpc.twitter.importComments.useMutation({
    onSuccess: (data) => {
      toast.success(`成功导入 ${data.imported} 条评论`);
      setImportData("");
    },
    onError: (err) => toast.error(`导入失败: ${err.message}`),
  });

  // Analyze mutation
  const analyzeMutation = trpc.analysis.analyzeUnanalyzed.useMutation({
    onSuccess: (data) => {
      toast.success(`成功分析 ${data.analyzed} 条评论`);
    },
    onError: (err) => toast.error(`分析失败: ${err.message}`),
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
        <Tabs defaultValue="import" className="space-y-6">
          <TabsList>
            <TabsTrigger value="import">
              <Upload className="w-4 h-4 mr-2" />
              数据导入
            </TabsTrigger>
            <TabsTrigger value="analysis">
              <Bot className="w-4 h-4 mr-2" />
              AI 分析
            </TabsTrigger>
            <TabsTrigger value="api">
              <Key className="w-4 h-4 mr-2" />
              API 配置
            </TabsTrigger>
          </TabsList>

          {/* Data Import Tab */}
          <TabsContent value="import">
            <Card>
              <CardHeader>
                <CardTitle>导入评论数据</CardTitle>
                <CardDescription>
                  手动导入 X/Twitter 评论数据（JSON 格式）
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

          {/* API Config Tab */}
          <TabsContent value="api">
            <Card>
              <CardHeader>
                <CardTitle>API 配置</CardTitle>
                <CardDescription>
                  配置外部 API 密钥（可选，用于扩展数据采集能力）
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-6">
                <div className="p-4 bg-yellow-50 dark:bg-yellow-900/20 rounded-lg border border-yellow-200 dark:border-yellow-800">
                  <h3 className="font-medium text-yellow-800 dark:text-yellow-200 mb-2">
                    关于 API 配置
                  </h3>
                  <p className="text-sm text-yellow-700 dark:text-yellow-300">
                    系统已内置 Twitter 用户资料和推文获取 API。如需获取推文回复/评论，
                    可以配置第三方 API 或使用手动导入功能。
                  </p>
                </div>

                <div className="space-y-4">
                  <div className="space-y-2">
                    <Label>Twitter Bearer Token (可选)</Label>
                    <Input
                      type="password"
                      placeholder="输入 Twitter API Bearer Token"
                      onChange={(e) => {
                        if (e.target.value) {
                          setConfigMutation.mutate({
                            key: "TWITTER_BEARER_TOKEN",
                            value: e.target.value,
                            description: "Twitter API Bearer Token",
                          });
                        }
                      }}
                    />
                    <p className="text-xs text-muted-foreground">
                      可从 Twitter Developer Portal 获取
                    </p>
                  </div>

                  <div className="space-y-2">
                    <Label>RapidAPI Key (可选)</Label>
                    <Input
                      type="password"
                      placeholder="输入 RapidAPI Key"
                      onChange={(e) => {
                        if (e.target.value) {
                          setConfigMutation.mutate({
                            key: "RAPIDAPI_KEY",
                            value: e.target.value,
                            description: "RapidAPI Key for Twitter data",
                          });
                        }
                      }}
                    />
                    <p className="text-xs text-muted-foreground">
                      用于访问第三方 Twitter 数据 API
                    </p>
                  </div>
                </div>
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </main>
    </div>
  );
}
