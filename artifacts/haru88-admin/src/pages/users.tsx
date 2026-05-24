import { useState } from "react";
import { useGetAdminUsers, useAdjustUserBalance, getGetAdminUsersQueryKey } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { Coins } from "lucide-react";

export default function Users() {
  const { data: users, isLoading } = useGetAdminUsers();
  const adjustMutation = useAdjustUserBalance();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [adjustModal, setAdjustModal] = useState<{ isOpen: boolean; userId: string; username: string }>({
    isOpen: false, userId: "", username: ""
  });
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");

  const handleAdjustSubmit = () => {
    const numAmount = Number(amount);
    if (!numAmount || isNaN(numAmount)) {
      toast({ variant: "destructive", title: "Lỗi", description: "Số tiền không hợp lệ" });
      return;
    }
    
    adjustMutation.mutate({
      userId: adjustModal.userId,
      data: { amount: numAmount, reason: reason || "Admin điều chỉnh" }
    }, {
      onSuccess: () => {
        toast({ title: "Thành công", description: "Đã cập nhật số dư", className: "bg-primary text-primary-foreground" });
        queryClient.invalidateQueries({ queryKey: getGetAdminUsersQueryKey() });
        setAdjustModal({ isOpen: false, userId: "", username: "" });
        setAmount("");
        setReason("");
      },
      onError: () => {
        toast({ variant: "destructive", title: "Lỗi", description: "Không thể cập nhật số dư" });
      }
    });
  };

  return (
    <div className="p-8 space-y-6 max-w-7xl mx-auto">
      <div>
        <h1 className="text-3xl font-bold tracking-tight text-foreground mb-2">Người dùng</h1>
        <p className="text-muted-foreground">Quản lý người chơi trong hệ thống</p>
      </div>

      <div className="border border-border rounded-md bg-card overflow-hidden">
        <Table>
          <TableHeader className="bg-muted">
            <TableRow>
              <TableHead>Telegram ID</TableHead>
              <TableHead>Username / Name</TableHead>
              <TableHead className="text-right">Số dư</TableHead>
              <TableHead className="text-right">Tổng cược</TableHead>
              <TableHead className="text-center">Giới thiệu</TableHead>
              <TableHead>Trạng thái</TableHead>
              <TableHead className="text-right">Thao tác</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow><TableCell colSpan={7} className="text-center py-8 text-muted-foreground">Đang tải...</TableCell></TableRow>
            ) : users?.length === 0 ? (
              <TableRow><TableCell colSpan={7} className="text-center py-8 text-muted-foreground">Không có dữ liệu</TableCell></TableRow>
            ) : (
              users?.map(user => (
                <TableRow key={user.id} className="border-border">
                  <TableCell className="font-mono text-xs">{user.id}</TableCell>
                  <TableCell>
                    <div className="font-medium">{user.username ? `@${user.username}` : "Không có"}</div>
                    <div className="text-xs text-muted-foreground">{user.firstName} {user.lastName}</div>
                  </TableCell>
                  <TableCell className="text-right font-mono font-bold text-primary">
                    {Number(user.balance).toLocaleString()}đ
                  </TableCell>
                  <TableCell className="text-right font-mono">
                    {Number(user.totalWagered).toLocaleString()}đ
                  </TableCell>
                  <TableCell className="text-center font-mono">{user.referralCount || 0}</TableCell>
                  <TableCell>
                    {user.isBanned ? (
                      <Badge variant="destructive">Banned</Badge>
                    ) : user.isAdmin ? (
                      <Badge className="bg-blue-500">Admin</Badge>
                    ) : (
                      <Badge variant="outline" className="text-muted-foreground">Active</Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    <Button 
                      variant="outline" 
                      size="sm"
                      className="h-8 border-border hover:bg-accent hover:text-foreground"
                      onClick={() => setAdjustModal({ isOpen: true, userId: user.id, username: user.username || user.firstName || user.id })}
                    >
                      <Coins className="h-4 w-4 mr-2" />
                      Cộng/Trừ tiền
                    </Button>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      <Dialog open={adjustModal.isOpen} onOpenChange={(o) => !o && setAdjustModal(p => ({...p, isOpen: false}))}>
        <DialogContent className="bg-card border-border">
          <DialogHeader>
            <DialogTitle>Điều chỉnh số dư: {adjustModal.username}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label>Số tiền (Dùng số âm để trừ, ví dụ: -50000)</Label>
              <Input 
                type="number" 
                value={amount} 
                onChange={(e) => setAmount(e.target.value)}
                placeholder="100000"
                className="font-mono"
              />
            </div>
            <div className="space-y-2">
              <Label>Lý do</Label>
              <Input 
                value={reason} 
                onChange={(e) => setReason(e.target.value)}
                placeholder="Admin cộng tiền event"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAdjustModal(p => ({...p, isOpen: false}))}>Hủy</Button>
            <Button onClick={handleAdjustSubmit} disabled={adjustMutation.isPending}>
              {adjustMutation.isPending ? "Đang xử lý..." : "Xác nhận"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
