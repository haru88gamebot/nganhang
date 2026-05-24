import { Link, useLocation } from "wouter";
import { 
  LayoutDashboard, 
  Settings, 
  Users, 
  ListOrdered, 
  Gift, 
  HeadphonesIcon
} from "lucide-react";
import { cn } from "@/lib/utils";

const NAV_ITEMS = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/settings", label: "Cài đặt", icon: Settings },
  { href: "/users", label: "Người dùng", icon: Users },
  { href: "/transactions", label: "Giao dịch", icon: ListOrdered },
  { href: "/gift-codes", label: "Gift Codes", icon: Gift },
  { href: "/support", label: "Bot Hỗ Trợ", icon: HeadphonesIcon },
];

export function Layout({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();

  return (
    <div className="min-h-screen bg-background text-foreground flex">
      {/* Sidebar */}
      <aside className="w-64 border-r border-border bg-card flex flex-col">
        <div className="h-16 flex items-center px-6 border-b border-border">
          <div className="flex items-center gap-2 text-primary">
            <LayoutDashboard className="h-6 w-6" />
            <span className="font-bold text-lg tracking-tight uppercase">Bot Admin</span>
          </div>
        </div>

        <nav className="flex-1 p-4 space-y-1">
          {NAV_ITEMS.map((item) => {
            const isActive = location === item.href;
            return (
              <Link key={item.href} href={item.href}>
                <div
                  className={cn(
                    "flex items-center gap-3 px-3 py-2.5 rounded-md cursor-pointer transition-colors text-sm font-medium",
                    isActive 
                      ? "bg-primary text-primary-foreground" 
                      : "text-muted-foreground hover:text-foreground hover:bg-accent"
                  )}
                >
                  <item.icon className="h-4 w-4" />
                  {item.label}
                </div>
              </Link>
            );
          })}
        </nav>
      </aside>

      {/* Main Content */}
      <main className="flex-1 overflow-auto">
        {children}
      </main>
    </div>
  );
}
