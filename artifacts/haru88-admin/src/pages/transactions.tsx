import { useState } from "react";
import { useGetAdminTransactions } from "@workspace/api-client-react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { format } from "date-fns";

export default function Transactions() {
  const [filterType, setFilterType] = useState<string>("all");
  
  const { data: transactions, isLoading } = useGetAdminTransactions({
    type: filterType !== "all" ? filterType : undefined,
    limit: 100
  });

  const getStatusBadge = (status: string) => {
    switch (status) {
      case "completed": return <Badge className="bg-primary/20 text-primary border-primary/50">Thành công</Badge>;
      case "pending": return <Badge variant="outline" className="text-yellow-500 border-yellow-500/50">Chờ duyệt</Badge>;
      case "failed": case "cancelled": return <Badge variant="destructive">Thất bại</Badge>;
      default: return <Badge variant="outline">{status}</Badge>;
    }
  };

  const getTypeLabel = (type: string) => {
    switch (type) {
      case "deposit": return "Nạp tiền";
      case "withdraw": return "Rút tiền";
      case "bet": return "Cược";
      case "reward": return "Trả thưởng";
      default: return type;
    }
  };

  return (
    <div className="p-8 space-y-6 max-w-7xl mx-auto">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-foreground mb-2">Giao dịch</h1>
          <p className="text-muted-foreground">Lịch sử dòng tiền hệ thống (100 giao dịch gần nhất)</p>
        </div>
        <div className="w-48">
          <Select value={filterType} onValueChange={setFilterType}>
            <SelectTrigger className="bg-background border-border">
              <SelectValue placeholder="Lọc theo loại" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Tất cả</SelectItem>
              <SelectItem value="deposit">Nạp tiền</SelectItem>
              <SelectItem value="withdraw">Rút tiền</SelectItem>
              <SelectItem value="bet">Cược</SelectItem>
              <SelectItem value="reward">Trả thưởng</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="border border-border rounded-md bg-card overflow-hidden">
        <Table>
          <TableHeader className="bg-muted">
            <TableRow>
              <TableHead>ID</TableHead>
              <TableHead>Thời gian</TableHead>
              <TableHead>User ID</TableHead>
              <TableHead>Loại</TableHead>
              <TableHead className="text-right">Số tiền</TableHead>
              <TableHead>Phương thức</TableHead>
              <TableHead>Trạng thái</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow><TableCell colSpan={7} className="text-center py-8 text-muted-foreground">Đang tải...</TableCell></TableRow>
            ) : transactions?.length === 0 ? (
              <TableRow><TableCell colSpan={7} className="text-center py-8 text-muted-foreground">Không có dữ liệu</TableCell></TableRow>
            ) : (
              transactions?.map(tx => (
                <TableRow key={tx.id} className="border-border">
                  <TableCell className="font-mono text-xs text-muted-foreground">#{tx.id}</TableCell>
                  <TableCell className="whitespace-nowrap font-mono text-xs">
                    {format(new Date(tx.createdAt), "dd/MM/yyyy HH:mm:ss")}
                  </TableCell>
                  <TableCell className="font-mono text-xs">{tx.userId}</TableCell>
                  <TableCell className="font-medium">{getTypeLabel(tx.type)}</TableCell>
                  <TableCell className="text-right font-mono font-bold">
                    <span className={tx.type === 'deposit' || tx.type === 'reward' ? 'text-primary' : tx.type === 'withdraw' || tx.type === 'bet' ? 'text-destructive' : 'text-foreground'}>
                      {tx.type === 'deposit' || tx.type === 'reward' ? '+' : '-'}{Number(tx.amount).toLocaleString()}đ
                    </span>
                  </TableCell>
                  <TableCell className="text-muted-foreground text-sm">{tx.method || "-"}</TableCell>
                  <TableCell>{getStatusBadge(tx.status)}</TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
