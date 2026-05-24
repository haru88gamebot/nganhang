import { useGetAdminStats } from "@workspace/api-client-react";
import { Users, ArrowDownToLine, ArrowUpFromLine, Dices, UserCheck } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

export default function Dashboard() {
  const { data: stats, isLoading } = useGetAdminStats();

  const metrics = [
    { title: "Tổng người dùng", value: stats?.totalUsers, icon: Users, format: (v: number) => v.toLocaleString() },
    { title: "Active hôm nay", value: stats?.activeToday, icon: UserCheck, format: (v: number) => v.toLocaleString() },
    { title: "Tổng tiền nạp", value: stats?.totalDeposits, icon: ArrowDownToLine, format: (v: number) => `${v.toLocaleString()}đ`, color: "text-primary" },
    { title: "Tổng tiền rút", value: stats?.totalWithdrawals, icon: ArrowUpFromLine, format: (v: number) => `${v.toLocaleString()}đ`, color: "text-destructive" },
    { title: "Tổng cược", value: stats?.totalBets, icon: Dices, format: (v: number) => `${v.toLocaleString()}đ`, color: "text-blue-500" },
  ];

  return (
    <div className="p-8 space-y-8 max-w-7xl mx-auto">
      <div>
        <h1 className="text-3xl font-bold tracking-tight text-foreground mb-2">Dashboard</h1>
        <p className="text-muted-foreground">Tổng quan hoạt động hệ thống</p>
      </div>

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {metrics.map((metric, i) => (
          <Card key={i} className="bg-card border-border">
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                {metric.title}
              </CardTitle>
              <metric.icon className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              {isLoading ? (
                <Skeleton className="h-8 w-24 bg-accent" />
              ) : (
                <div className={`text-2xl font-bold font-mono ${metric.color || 'text-foreground'}`}>
                  {metric.value !== undefined ? metric.format(metric.value) : "0"}
                </div>
              )}
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
