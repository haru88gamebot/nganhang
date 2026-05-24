import { Link } from "wouter";
import { Button } from "@/components/ui/button";

export default function NotFound() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-background">
      <div className="text-center space-y-4">
        <h1 className="text-6xl font-bold text-muted-foreground/30">404</h1>
        <p className="text-xl font-semibold text-foreground">Không tìm thấy trang</p>
        <p className="text-muted-foreground">Trang bạn tìm kiếm không tồn tại.</p>
        <Button asChild>
          <Link href="/dashboard">Về Dashboard</Link>
        </Button>
      </div>
    </div>
  );
}
