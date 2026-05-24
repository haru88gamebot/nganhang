import { useState } from "react";
import { useGetGiftCodes, useCreateGiftCode, getGetGiftCodesQueryKey } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { format } from "date-fns";
import { Plus } from "lucide-react";

export default function GiftCodes() {
  const { data: codes, isLoading } = useGetGiftCodes();
  const createMutation = useCreateGiftCode();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [isOpen, setIsOpen] = useState(false);
  const [formData, setFormData] = useState({ code: "", amount: "", maxUses: "1" });

  const handleSubmit = () => {
    if (!formData.code || !formData.amount || !formData.maxUses) {
      toast({ variant: "destructive", title: "Lỗi", description: "Vui lòng nhập đủ thông tin" });
      return;
    }

    createMutation.mutate({
      data: {
        code: formData.code,
        amount: formData.amount,
        maxUses: Number(formData.maxUses)
      }
    }, {
      onSuccess: () => {
        toast({ title: "Thành công", description: "Đã tạo Gift Code", className: "bg-primary text-primary-foreground" });
        queryClient.invalidateQueries({ queryKey: getGetGiftCodesQueryKey() });
        setIsOpen(false);
        setFormData({ code: "", amount: "", maxUses: "1" });
      },
      onError: () => {
        toast({ variant: "destructive", title: "Lỗi", description: "Không thể tạo Gift Code (có thể mã đã tồn tại)" });
      }
    });
  };

  const generateRandomCode = () => {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let result = 'GIFT-';
    for (let i = 0; i < 8; i++) {
      result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    setFormData(prev => ({ ...prev, code: result }));
  };

  return (
    <div className="p-8 space-y-6 max-w-7xl mx-auto">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-foreground mb-2">Gift Codes</h1>
          <p className="text-muted-foreground">Quản lý mã nạp tiền thưởng</p>
        </div>
        <Button onClick={() => setIsOpen(true)} className="font-bold">
          <Plus className="mr-2 h-4 w-4" /> Tạo mã mới
        </Button>
      </div>

      <div className="border border-border rounded-md bg-card overflow-hidden">
        <Table>
          <TableHeader className="bg-muted">
            <TableRow>
              <TableHead>Mã (Code)</TableHead>
              <TableHead className="text-right">Mệnh giá</TableHead>
              <TableHead className="text-center">Đã dùng / Tối đa</TableHead>
              <TableHead>Trạng thái</TableHead>
              <TableHead>Ngày tạo</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow><TableCell colSpan={5} className="text-center py-8 text-muted-foreground">Đang tải...</TableCell></TableRow>
            ) : codes?.length === 0 ? (
              <TableRow><TableCell colSpan={5} className="text-center py-8 text-muted-foreground">Không có dữ liệu</TableCell></TableRow>
            ) : (
              codes?.map(code => {
                const isExpired = !code.isActive || code.usedCount >= code.maxUses;
                return (
                  <TableRow key={code.id} className="border-border">
                    <TableCell className="font-mono font-bold text-primary">{code.code}</TableCell>
                    <TableCell className="text-right font-mono font-bold">
                      {Number(code.amount).toLocaleString()}đ
                    </TableCell>
                    <TableCell className="text-center font-mono">
                      {code.usedCount} / {code.maxUses}
                    </TableCell>
                    <TableCell>
                      {isExpired ? (
                        <Badge variant="outline" className="text-muted-foreground border-muted-foreground/30">Hết hạn</Badge>
                      ) : (
                        <Badge className="bg-primary/20 text-primary border-primary/50">Hoạt động</Badge>
                      )}
                    </TableCell>
                    <TableCell className="whitespace-nowrap font-mono text-xs text-muted-foreground">
                      {format(new Date(code.createdAt), "dd/MM/yyyy HH:mm")}
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>

      <Dialog open={isOpen} onOpenChange={setIsOpen}>
        <DialogContent className="bg-card border-border">
          <DialogHeader>
            <DialogTitle>Tạo Gift Code mới</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label>Mã Gift Code</Label>
              <div className="flex gap-2">
                <Input 
                  value={formData.code} 
                  onChange={(e) => setFormData(p => ({...p, code: e.target.value.toUpperCase()}))}
                  placeholder="GIFT-XXXXX"
                  className="font-mono uppercase"
                />
                <Button variant="outline" onClick={generateRandomCode}>Ngẫu nhiên</Button>
              </div>
            </div>
            <div className="space-y-2">
              <Label>Mệnh giá (VNĐ)</Label>
              <Input 
                type="number" 
                value={formData.amount} 
                onChange={(e) => setFormData(p => ({...p, amount: e.target.value}))}
                placeholder="100000"
                className="font-mono"
              />
            </div>
            <div className="space-y-2">
              <Label>Số lượt sử dụng tối đa</Label>
              <Input 
                type="number" 
                min="1"
                value={formData.maxUses} 
                onChange={(e) => setFormData(p => ({...p, maxUses: e.target.value}))}
                className="font-mono"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsOpen(false)}>Hủy</Button>
            <Button onClick={handleSubmit} disabled={createMutation.isPending}>
              {createMutation.isPending ? "Đang xử lý..." : "Tạo mã"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
