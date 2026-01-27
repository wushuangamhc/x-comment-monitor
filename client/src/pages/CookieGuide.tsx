import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";
import { ArrowLeft, Copy, Cookie, ExternalLink, CheckCircle } from "lucide-react";
import { Link } from "wouter";

export default function CookieGuide() {
  const [copied, setCopied] = useState(false);

  // 这是一个可以在浏览器控制台运行的脚本，用于导出 X Cookie
  const exportScript = `// 在 X.com 页面的控制台运行此脚本
// 复制输出结果到监控系统的设置页面

(function() {
  const cookies = document.cookie.split(';').map(c => {
    const [name, ...rest] = c.trim().split('=');
    return { name, value: rest.join('='), domain: '.x.com' };
  });
  
  // 只保留关键 Cookie
  const important = ['auth_token', 'ct0', 'twid', 'guest_id'];
  const filtered = cookies.filter(c => important.includes(c.name));
  
  const result = JSON.stringify(filtered, null, 2);
  console.log('复制以下内容到监控系统设置页面：');
  console.log(result);
  
  // 尝试复制到剪贴板
  navigator.clipboard.writeText(result).then(() => {
    console.log('✅ 已自动复制到剪贴板！');
  }).catch(() => {
    console.log('⚠️ 请手动复制上面的内容');
  });
  
  return result;
})();`;

  const copyScript = async () => {
    try {
      await navigator.clipboard.writeText(exportScript);
      setCopied(true);
      toast.success("脚本已复制到剪贴板");
      setTimeout(() => setCopied(false), 3000);
    } catch (err) {
      toast.error("复制失败，请手动复制");
    }
  };

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="border-b bg-card/50 backdrop-blur-sm sticky top-0 z-50">
        <div className="container flex items-center h-14 gap-4">
          <Link href="/settings">
            <Button variant="ghost" size="sm">
              <ArrowLeft className="w-4 h-4 mr-2" />
              返回设置
            </Button>
          </Link>
          <h1 className="font-semibold flex items-center gap-2">
            <Cookie className="w-5 h-5" />
            Cookie 获取指南
          </h1>
        </div>
      </header>

      <main className="container py-6 max-w-3xl">
        <div className="space-y-6">
          {/* 方法一：使用脚本 */}
          <Card className="border-green-500/50">
            <CardHeader>
              <CardTitle className="text-green-700 dark:text-green-300">
                方法一：一键导出脚本（推荐）
              </CardTitle>
              <CardDescription>
                在 X.com 页面的浏览器控制台运行脚本，自动导出所需 Cookie
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-3">
                <h4 className="font-medium">操作步骤：</h4>
                <ol className="space-y-2 text-sm text-muted-foreground list-decimal list-inside">
                  <li>
                    打开{" "}
                    <a 
                      href="https://x.com" 
                      target="_blank" 
                      rel="noopener noreferrer"
                      className="text-primary underline inline-flex items-center gap-1"
                    >
                      X.com
                      <ExternalLink className="w-3 h-3" />
                    </a>
                    {" "}并确保已登录
                  </li>
                  <li>按 <kbd className="px-1.5 py-0.5 bg-muted rounded text-xs font-mono">F12</kbd> 打开开发者工具</li>
                  <li>切换到 <strong>Console（控制台）</strong> 标签</li>
                  <li>复制下方脚本并粘贴到控制台，按回车运行</li>
                  <li>脚本会自动复制 Cookie 到剪贴板</li>
                  <li>回到本系统的设置页面，粘贴到 Cookie 输入框</li>
                </ol>
              </div>

              <div className="relative">
                <Textarea
                  value={exportScript}
                  readOnly
                  className="font-mono text-xs min-h-[200px] bg-slate-900 text-green-400 border-slate-700"
                />
                <Button
                  size="sm"
                  className="absolute top-2 right-2"
                  onClick={copyScript}
                >
                  {copied ? (
                    <>
                      <CheckCircle className="w-4 h-4 mr-1" />
                      已复制
                    </>
                  ) : (
                    <>
                      <Copy className="w-4 h-4 mr-1" />
                      复制脚本
                    </>
                  )}
                </Button>
              </div>
            </CardContent>
          </Card>

          {/* 方法二：手动获取 */}
          <Card>
            <CardHeader>
              <CardTitle>方法二：手动获取</CardTitle>
              <CardDescription>
                如果脚本方法不可用，可以手动从浏览器获取 Cookie
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <ol className="space-y-3 text-sm list-decimal list-inside">
                <li>
                  打开{" "}
                  <a 
                    href="https://x.com" 
                    target="_blank" 
                    rel="noopener noreferrer"
                    className="text-primary underline"
                  >
                    X.com
                  </a>
                  {" "}并登录
                </li>
                <li>按 <kbd className="px-1.5 py-0.5 bg-muted rounded text-xs font-mono">F12</kbd> 打开开发者工具</li>
                <li>切换到 <strong>Application</strong> 标签（Chrome）或 <strong>Storage</strong> 标签（Firefox）</li>
                <li>在左侧找到 <strong>Cookies → https://x.com</strong></li>
                <li>
                  找到以下关键 Cookie 并记录它们的值：
                  <ul className="mt-2 ml-4 space-y-1 list-disc">
                    <li><code className="bg-muted px-1 rounded">auth_token</code> - 必需</li>
                    <li><code className="bg-muted px-1 rounded">ct0</code> - 必需</li>
                    <li><code className="bg-muted px-1 rounded">twid</code> - 可选</li>
                  </ul>
                </li>
                <li>
                  按以下格式整理：
                  <pre className="mt-2 p-3 bg-muted rounded text-xs overflow-x-auto">
{`[
  {"name": "auth_token", "value": "你的auth_token值", "domain": ".x.com"},
  {"name": "ct0", "value": "你的ct0值", "domain": ".x.com"}
]`}
                  </pre>
                </li>
              </ol>
            </CardContent>
          </Card>

          {/* 注意事项 */}
          <Card className="border-yellow-500/50">
            <CardHeader>
              <CardTitle className="text-yellow-700 dark:text-yellow-300">
                注意事项
              </CardTitle>
            </CardHeader>
            <CardContent>
              <ul className="space-y-2 text-sm text-muted-foreground">
                <li>• <strong>Cookie 会过期</strong>：通常有效期为几天到几周，过期后需要重新获取</li>
                <li>• <strong>安全提醒</strong>：Cookie 相当于登录凭证，请勿分享给他人</li>
                <li>• <strong>采集频率</strong>：建议每次采集间隔至少 30 秒，避免触发 X 的反爬机制</li>
                <li>• <strong>备选方案</strong>：如果 Cookie 方式不稳定，可以配置 Apify API Token 作为备选</li>
              </ul>
            </CardContent>
          </Card>

          <div className="flex justify-center">
            <Link href="/settings">
              <Button>
                <ArrowLeft className="w-4 h-4 mr-2" />
                返回设置页面配置 Cookie
              </Button>
            </Link>
          </div>
        </div>
      </main>
    </div>
  );
}
