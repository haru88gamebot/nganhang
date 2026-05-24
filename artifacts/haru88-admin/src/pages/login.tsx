import { useState, useEffect } from "react";
import { useLocation } from "wouter";
import { useAdminLogin } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export default function Login() {
  const [, setLocation] = useLocation();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");

  useEffect(() => {
    const existing = localStorage.getItem("admin_token");
    if (existing) setLocation("/dashboard");
  }, [setLocation]);

  const [error, setError] = useState("");

  const loginMutation = useAdminLogin({
    mutation: {
      onSuccess: (data) => {
        if (data.token) {
          localStorage.setItem("admin_token", data.token);
        }
        setLocation("/dashboard");
      },
      onError: () => {
        setError("Sai tài khoản hoặc mật khẩu");
      },
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    loginMutation.mutate({ data: { username, password } });
  };

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-4">
      <Card className="w-full max-w-sm bg-card border-border shadow-xl">
        <CardHeader className="text-center pb-2">
          <div className="text-4xl mb-2">🎰</div>
          <CardTitle className="text-2xl font-bold text-primary">Haru88 Admin</CardTitle>
          <p className="text-sm text-muted-foreground">Đăng nhập để quản lý hệ thống</p>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="username" className="text-sm font-medium">Tài khoản</Label>
              <Input
                id="username"
                type="text"
                placeholder="Nhập tài khoản..."
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                className="bg-background border-border"
                autoComplete="username"
                autoFocus
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="password" className="text-sm font-medium">Mật khẩu</Label>
              <Input
                id="password"
                type="password"
                placeholder="Nhập mật khẩu..."
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="bg-background border-border"
                autoComplete="current-password"
              />
            </div>
            {error && (
              <p className="text-sm text-destructive font-medium text-center">{error}</p>
            )}
            <Button
              type="submit"
              className="w-full font-bold"
              disabled={loginMutation.isPending || !username || !password}
            >
              {loginMutation.isPending ? "Đang đăng nhập..." : "Đăng nhập"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
