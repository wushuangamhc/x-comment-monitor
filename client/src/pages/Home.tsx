import { useAuth } from "@/_core/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { redirectToLogin } from "@/const";
import { MonitorDashboard } from "@/components/MonitorDashboard";
import { Settings, LogIn, LogOut } from "lucide-react";
import { Link } from "wouter";
import { toast } from "sonner";

export default function Home() {
  const { user, loading, isAuthenticated, logout } = useAuth();

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="animate-pulse text-muted-foreground">加载中...</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col bg-background">
      <header className="border-b bg-card/50 backdrop-blur-sm sticky top-0 z-50">
        <div className="container flex items-center justify-between h-14">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-primary flex items-center justify-center">
              <span className="text-primary-foreground font-bold text-sm">X</span>
            </div>
            <h1 className="font-semibold text-lg">评论监控与分析</h1>
          </div>

          <div className="flex items-center gap-2">
            {isAuthenticated ? (
              <>
                <Link href="/settings">
                  <Button variant="ghost" size="sm">
                    <Settings className="w-4 h-4 mr-2" />
                    设置
                  </Button>
                </Link>
                <span className="text-sm text-muted-foreground">{user?.name}</span>
                <Button variant="ghost" size="sm" onClick={() => logout()}>
                  <LogOut className="w-4 h-4" />
                </Button>
              </>
            ) : (
              <Button
                size="sm"
                onClick={() =>
                  redirectToLogin((msg) => toast.error(`登录失败：${msg}`))
                }
              >
                <LogIn className="w-4 h-4 mr-2" />
                登录
              </Button>
            )}
          </div>
        </div>
      </header>

      <main className="flex-1">
        <MonitorDashboard />
      </main>
    </div>
  );
}
