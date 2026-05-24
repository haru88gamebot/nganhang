import { useState, useEffect, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";

interface SupportRequest {
  userId: string;
  username: string;
  firstName: string;
  content: string;
  status: "pending" | "connected" | "rejected";
  requestedAt: number;
  isConnected: boolean;
}

async function apiFetch(path: string, method = "GET") {
  const token = localStorage.getItem("admin_token");
  const res = await fetch(path, {
    method,
    headers: token ? { Authorization: `Bearer ${token}` } : {}
  });
  return res.json();
}

export default function Support() {
  const [requests, setRequests] = useState<SupportRequest[]>([]);
  const [loading, setLoading] = useState(false);
  const { toast } = useToast();

  const fetchRequests = useCallback(async () => {
    try {
      const data = await apiFetch("/api/admin/support/requests");
      if (Array.isArray(data)) setRequests(data);
    } catch {}
  }, []);

  useEffect(() => {
    fetchRequests();
    const interval = setInterval(fetchRequests, 5000);
    return () => clearInterval(interval);
  }, [fetchRequests]);

  const handleConnect = async (userId: string) => {
    setLoading(true);
    try {
      const res = await apiFetch(`/api/admin/support/connect/${userId}`, "POST");
      if (res.ok) {
        toast({ title: "Đã kết nối", description: "Bot đang kết nối bạn với người chơi." });
        fetchRequests();
      } else {
        toast({ variant: "destructive", title: "Lỗi", description: res.message });
      }
    } catch {
      toast({ variant: "destructive", title: "Lỗi", description: "Không thể kết nối." });
    } finally {
      setLoading(false);
    }
  };

  const handleDisconnect = async (userId: string) => {
    setLoading(true);
    try {
      await apiFetch(`/api/admin/support/disconnect/${userId}`, "POST");
      toast({ title: "Đã ngắt kết nối" });
      fetchRequests();
    } catch {
      toast({ variant: "destructive", title: "Lỗi", description: "Không thể ngắt kết nối." });
    } finally {
      setLoading(false);
    }
  };

  const handleReject = async (userId: string) => {
    setLoading(true);
    try {
      await apiFetch(`/api/admin/support/reject/${userId}`, "POST");
      toast({ title: "Đã từ chối yêu cầu" });
      fetchRequests();
    } catch {
      toast({ variant: "destructive", title: "Lỗi", description: "Không thể từ chối." });
    } finally {
      setLoading(false);
    }
  };

  const pending = requests.filter(r => r.status === "pending" && !r.isConnected);
  const connected = requests.filter(r => r.isConnected);

  function timeAgo(ts: number) {
    const diff = Math.floor((Date.now() - ts) / 1000);
    if (diff < 60) return `${diff}s trước`;
    if (diff < 3600) return `${Math.floor(diff / 60)}p trước`;
    return `${Math.floor(diff / 3600)}h trước`;
  }

  return (
    <div className="p-8 space-y-6 max-w-4xl mx-auto">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-foreground mb-2">Bot Hỗ Trợ</h1>
          <p className="text-muted-foreground">Quản lý yêu cầu hỗ trợ từ người chơi qua Bot3</p>
        </div>
        <Button variant="outline" onClick={fetchRequests} size="sm">
          Làm mới
        </Button>
      </div>

      <Card className="bg-blue-950/30 border-blue-800/50">
        <CardContent className="pt-4 pb-3">
          <p className="text-blue-300 text-sm">
            <b>Cách thiết lập Bot Hỗ Trợ:</b> Vào <b>Cài đặt → Bot Hỗ Trợ (Bot3)</b>, điền token Bot3 và ID Telegram của admin. Bot sẽ tự động trả lời bằng AI và chuyển tiếp yêu cầu hỗ trợ vào đây.
          </p>
        </CardContent>
      </Card>

      {connected.length > 0 && (
        <Card className="bg-green-950/30 border-green-800/50">
          <CardHeader className="pb-2">
            <CardTitle className="text-green-400 text-base">Đang kết nối ({connected.length})</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {connected.map(r => (
              <div key={r.userId} className="flex items-center justify-between gap-4 p-3 rounded-lg bg-green-950/40 border border-green-800/30">
                <div className="min-w-0">
                  <div className="font-semibold text-sm text-foreground">
                    {r.firstName} <span className="text-muted-foreground font-normal">@{r.username}</span>
                  </div>
                  <div className="text-xs text-muted-foreground mt-0.5">ID: {r.userId}</div>
                  <div className="text-sm text-green-300 mt-1 italic">"{r.content}"</div>
                </div>
                <Button
                  variant="destructive"
                  size="sm"
                  disabled={loading}
                  onClick={() => handleDisconnect(r.userId)}
                >
                  Ngắt kết nối
                </Button>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      <Card className="bg-card border-border">
        <CardHeader className="pb-2">
          <CardTitle className="text-lg text-primary flex items-center gap-2">
            Yêu cầu chờ xử lý
            {pending.length > 0 && (
              <span className="bg-destructive text-destructive-foreground text-xs px-2 py-0.5 rounded-full font-bold">
                {pending.length}
              </span>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {pending.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground">
              <div className="text-4xl mb-3">🤖</div>
              <p>Chưa có yêu cầu hỗ trợ nào</p>
              <p className="text-xs mt-1">AI đang tự động trả lời người chơi</p>
            </div>
          ) : (
            <div className="space-y-3">
              {pending.map(r => (
                <div key={r.userId} className="flex items-start justify-between gap-4 p-4 rounded-lg bg-background border border-border hover:border-primary/50 transition-colors">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-semibold text-sm text-foreground">{r.firstName}</span>
                      <span className="text-muted-foreground text-sm">@{r.username}</span>
                      <span className="text-xs text-muted-foreground bg-muted px-2 py-0.5 rounded">ID: {r.userId}</span>
                    </div>
                    <div className="text-sm text-yellow-300 mt-2 p-2 bg-yellow-950/30 rounded border-l-2 border-yellow-600">
                      {r.content}
                    </div>
                    <div className="text-xs text-muted-foreground mt-1.5">{timeAgo(r.requestedAt)}</div>
                  </div>
                  <div className="flex flex-col gap-2 shrink-0">
                    <Button
                      size="sm"
                      disabled={loading}
                      onClick={() => handleConnect(r.userId)}
                      className="bg-green-700 hover:bg-green-600 text-white"
                    >
                      Kết nối
                    </Button>
                    <Button
                      size="sm"
                      variant="destructive"
                      disabled={loading}
                      onClick={() => handleReject(r.userId)}
                    >
                      Từ chối
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="bg-card border-border">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm text-muted-foreground">Lệnh trong Support Bot (Bot3)</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground space-y-1">
          <p><b className="text-foreground">/toicanhotro [nội dung]</b> — Người chơi gửi yêu cầu hỗ trợ</p>
          <p><b className="text-foreground">/rs</b> — Admin xoá tất cả cuộc trò chuyện đã xong</p>
          <p><b className="text-foreground">/dung</b> — Admin ngắt kết nối với người chơi hiện tại</p>
          <p><b className="text-foreground">/start, /help</b> — Người chơi xem hướng dẫn</p>
        </CardContent>
      </Card>
    </div>
  );
}
