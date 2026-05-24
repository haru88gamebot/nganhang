import { useEffect, useState } from "react";
import { useGetAdminSettings, useSaveAdminSettings } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Save, CheckCircle2, XCircle, Loader2, Copy, Check, Link } from "lucide-react";

type SectionField = { key: string; label: string; type?: string };
type Section = { title: string; fields: SectionField[] };

const SECTIONS: Section[] = [
  {
    title: "Bot Telegram",
    fields: [
      { key: "bot_token", label: "Bot Token (BOT_TOKEN)" },
      { key: "bot2_token", label: "Bot2 Token (BOT2_TOKEN)" },
      { key: "bot_username", label: "Username của Bot" },
      { key: "admin_chat_ids", label: "Chat IDs Admin (phân cách bằng dấu phẩy)" }
    ]
  },
  {
    title: "Bot Hỗ Trợ (Bot3)",
    fields: [
      { key: "support_bot_token", label: "Support Bot Token (BOT3_TOKEN)" },
      { key: "support_admin_id", label: "Admin ID nhận yêu cầu hỗ trợ (VD: 123456,789012)" },
      { key: "support_ai_enabled", label: "Bật AI trả lời tự động (1 = bật, 0 = tắt)" }
    ]
  },
  {
    title: "Thanh toán - Nạp thẻ (ShopCard68)",
    fields: [
      { key: "shopcard68_account", label: "Tài khoản ShopCard68" },
      { key: "card_fee_viettel", label: "Chiết khấu thẻ Viettel (%)" },
      { key: "card_fee_mobi",    label: "Chiết khấu thẻ Mobifone (%)" },
      { key: "card_fee_vina",    label: "Chiết khấu thẻ Vinaphone (%)" },
      { key: "card_fee_zing",    label: "Chiết khấu thẻ Zing (%)" },
    ]
  },
  {
    title: "Ngân hàng - Kết nối HARU88 Panel API",
    fields: [
      { key: "bank_username", label: "Tên đăng nhập MB Bank (số điện thoại / username)" },
      { key: "bank_password", label: "Mật khẩu MB Bank", type: "password" },
      { key: "corebank_api_url", label: "HARU88 Panel URL (để trống = mặc định http://localhost:80)" },
      { key: "corebank_client_id", label: "X-Client-ID — lấy từ HARU88 Panel → Cài đặt" },
      { key: "corebank_api_key", label: "X-API-Key — lấy từ HARU88 Panel → Cài đặt", type: "password" },
    ]
  },
  {
    title: "Ngân hàng - Thông tin hiển thị cho người nạp",
    fields: [
      { key: "bank_account_number", label: "Số tài khoản" },
      { key: "bank_name", label: "Tên ngân hàng (VD: MB Bank)" },
      { key: "bank_account_holder", label: "Tên chủ tài khoản" },
      { key: "bank_webhook_secret", label: "Webhook Secret (tùy chọn — để trống nếu không cần bảo mật)", type: "password" }
    ]
  },
  {
    title: "PayOS",
    fields: [
      { key: "payos_client_id", label: "PayOS Client ID" },
      { key: "payos_api_key", label: "PayOS API Key", type: "password" },
      { key: "payos_checksum_key", label: "PayOS Checksum Key", type: "password" }
    ]
  },
  {
    title: "Cài đặt game",
    fields: [
      { key: "min_bet", label: "Cược tối thiểu (đồng)" },
      { key: "max_bet", label: "Cược tối đa (đồng)" },
      { key: "house_edge", label: "Tỉ lệ nhà cái (%) — ảnh hưởng tỉ lệ thắng tất cả game" },
      { key: "referral_bonus", label: "Thưởng giới thiệu khi đăng ký (đồng)" },
      { key: "commission_deposit_rate", label: "Hoa hồng nạp tiền (%)" },
      { key: "commission_game_rate", label: "Hoa hồng từ game (%)" }
    ]
  },
  {
    title: "Rút tiền & Chuyển tiền",
    fields: [
      { key: "min_withdraw", label: "Rút ngân hàng tối thiểu (đồng)" },
      { key: "max_withdraw", label: "Rút / Chuyển tối đa (đồng)" },
      { key: "min_transfer", label: "Chuyển tiền giữa user tối thiểu (đồng)" }
    ]
  },
  {
    title: "Bot2 — Cài đặt phiên Tài Xỉu",
    fields: [
      { key: "bot2_session_duration", label: "Thời gian đặt cược mỗi phiên (giây) — tối thiểu 15, tối đa 300. Mặc định: 90" },
      { key: "bot2_lock_seconds", label: "Khoá cửa cược trước khi tung xúc xắc (giây) — tối thiểu 3, tối đa 30. Mặc định: 5" },
    ]
  },
  {
    title: "Bot2 Gift Code Broadcast",
    fields: [
      { key: "bot2_gift_channel_id", label: "Chat ID nhóm Bot2 nhận code (để trống = dùng nhóm mặc định)" },
    ]
  },
];

const TOGGLE_KEYS: { key: string; label: string; description: string }[] = [
  {
    key: "bank_deposit_notify",
    label: "Thông báo nhóm khi nạp Bank",
    description: "Khi có người nạp tiền qua ngân hàng thành công, bot sẽ thông báo vào nhóm chính"
  },
  {
    key: "bank_withdraw_notify",
    label: "Thông báo nhóm khi rút Bank",
    description: "Khi có người rút tiền qua ngân hàng thành công, bot sẽ thông báo vào nhóm chính"
  },
  {
    key: "bot2_gift_broadcast_enabled",
    label: "Bot2 Phát Code Quà Tặng Tự Động",
    description: "Mỗi ngày Bot2 sẽ tự động gửi 5 mã quà (3k–9k) vào nhóm 2 lần tại thời điểm ngẫu nhiên. Code chỉ dùng 1 lần — cần gõ tay, không thể sao chép"
  }
];

type SectionStatus = { type: "success"; msg: string } | { type: "error"; msg: string } | null;

function WebhookUrlCard() {
  const [copied, setCopied] = useState(false);
  const webhookUrl = `${window.location.origin}/bot-api/bank/webhook`;

  const copy = () => {
    navigator.clipboard.writeText(webhookUrl).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <Card className="bg-card border-border border-primary/40">
      <CardHeader className="pb-3">
        <div className="flex items-center gap-2">
          <Link className="h-5 w-5 text-primary" />
          <CardTitle className="text-lg text-primary">Webhook URL nhận giao dịch ngân hàng</CardTitle>
        </div>
        <p className="text-sm text-muted-foreground mt-1">
          Dán URL này vào trường <span className="font-semibold text-foreground">Custom Webhook URL</span> trong CoreBank Panel để nhận thông báo giao dịch tự động.
        </p>
      </CardHeader>
      <CardContent>
        <div className="flex items-center gap-2">
          <div className="flex-1 font-mono text-sm bg-background border border-border rounded-md px-3 py-2 select-all text-foreground break-all">
            {webhookUrl}
          </div>
          <Button size="sm" variant="outline" onClick={copy} className="shrink-0 gap-1.5">
            {copied ? <Check className="h-4 w-4 text-green-500" /> : <Copy className="h-4 w-4" />}
            {copied ? "Đã sao chép" : "Sao chép"}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground mt-2">
          Mô tả chuyển khoản phải chứa <span className="font-mono font-semibold">NAP &lt;userId&gt;</span> — ví dụ: <span className="font-mono">NAP 123456</span>
        </p>
      </CardContent>
    </Card>
  );
}

export default function Settings() {
  const { data: settingsData, isLoading } = useGetAdminSettings();
  const saveMutation = useSaveAdminSettings();

  const [formData, setFormData] = useState<Record<string, string>>({});
  // per-section save status & loading
  const [sectionStatus, setSectionStatus] = useState<Record<number, SectionStatus>>({});
  const [sectionLoading, setSectionLoading] = useState<Record<number, boolean>>({});
  // toggle section status
  const [toggleStatus, setToggleStatus] = useState<SectionStatus>(null);
  const [toggleLoading, setToggleLoading] = useState(false);

  useEffect(() => {
    if (settingsData) {
      const initial: Record<string, string> = {};
      settingsData.forEach(s => { initial[s.key] = s.value; });
      setFormData(initial);
    }
  }, [settingsData]);

  const handleChange = (key: string, value: string) => {
    setFormData(prev => ({ ...prev, [key]: value }));
  };

  const handleToggle = (key: string) => {
    const current = formData[key] === "1";
    setFormData(prev => ({ ...prev, [key]: current ? "0" : "1" }));
  };

  const saveSection = (sectionIndex: number, keys: string[]) => {
    const settings = keys
      .filter(k => formData[k] !== undefined)
      .map(k => ({ key: k, value: formData[k] ?? "" }));

    setSectionLoading(prev => ({ ...prev, [sectionIndex]: true }));
    setSectionStatus(prev => ({ ...prev, [sectionIndex]: null }));

    saveMutation.mutate({ data: { settings } }, {
      onSuccess: () => {
        setSectionLoading(prev => ({ ...prev, [sectionIndex]: false }));
        setSectionStatus(prev => ({ ...prev, [sectionIndex]: { type: "success", msg: "Đã lưu thành công!" } }));
        setTimeout(() => setSectionStatus(prev => ({ ...prev, [sectionIndex]: null })), 4000);
      },
      onError: (err: any) => {
        setSectionLoading(prev => ({ ...prev, [sectionIndex]: false }));
        const msg: string =
          err?.response?.data?.error ??
          err?.message ??
          "Không thể lưu cài đặt.";
        setSectionStatus(prev => ({ ...prev, [sectionIndex]: { type: "error", msg } }));
      }
    });
  };

  const saveToggles = () => {
    const settings = TOGGLE_KEYS.map(t => ({ key: t.key, value: formData[t.key] ?? "0" }));
    setToggleLoading(true);
    setToggleStatus(null);
    saveMutation.mutate({ data: { settings } }, {
      onSuccess: () => {
        setToggleLoading(false);
        setToggleStatus({ type: "success", msg: "Đã lưu!" });
        setTimeout(() => setToggleStatus(null), 4000);
      },
      onError: (err: any) => {
        setToggleLoading(false);
        const msg: string = err?.response?.data?.error ?? err?.message ?? "Lỗi không thể lưu.";
        setToggleStatus({ type: "error", msg });
      }
    });
  };

  if (isLoading) {
    return <div className="p-8 text-muted-foreground">Đang tải cài đặt...</div>;
  }

  return (
    <div className="p-8 space-y-8 max-w-4xl mx-auto pb-24">
      <div>
        <h1 className="text-3xl font-bold tracking-tight text-foreground mb-2">Cài đặt hệ thống</h1>
        <p className="text-muted-foreground">Quản lý tham số bot và cổng thanh toán — mỗi nhóm lưu độc lập</p>
      </div>

      <WebhookUrlCard />

      {/* Bank Notification Toggles */}
      <Card className="bg-card border-border">
        <CardHeader className="flex flex-row items-center justify-between pb-3">
          <CardTitle className="text-lg text-primary">Thông báo nhóm Nạp/Rút Bank</CardTitle>
          <div className="flex items-center gap-3">
            {toggleStatus && (
              <span className={`flex items-center gap-1.5 text-sm font-medium ${toggleStatus.type === "success" ? "text-green-500" : "text-destructive"}`}>
                {toggleStatus.type === "success"
                  ? <CheckCircle2 className="h-4 w-4" />
                  : <XCircle className="h-4 w-4" />}
                {toggleStatus.msg}
              </span>
            )}
            <Button size="sm" onClick={saveToggles} disabled={toggleLoading} className="font-bold">
              {toggleLoading ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <Save className="h-4 w-4 mr-1" />}
              Lưu
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {TOGGLE_KEYS.map(({ key, label, description }) => {
            const isOn = formData[key] === "1";
            return (
              <div key={key} className="flex items-center justify-between gap-4 p-3 rounded-lg bg-background border border-border">
                <div>
                  <div className="font-medium text-sm text-foreground">{label}</div>
                  <div className="text-xs text-muted-foreground mt-0.5">{description}</div>
                </div>
                <button
                  type="button"
                  onClick={() => handleToggle(key)}
                  className={`relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 focus:outline-none ${isOn ? "bg-primary" : "bg-muted"}`}
                  role="switch"
                  aria-checked={isOn}
                >
                  <span className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ${isOn ? "translate-x-5" : "translate-x-0"}`} />
                </button>
              </div>
            );
          })}
          <p className="text-xs text-muted-foreground">
            Nạp/rút thẻ cào luôn tự động thông báo nhóm. Chỉ Bank mới có tùy chọn bật/tắt.
          </p>
        </CardContent>
      </Card>

      {/* Sections */}
      <div className="space-y-6">
        {SECTIONS.map((section, i) => {
          const status = sectionStatus[i];
          const loading = sectionLoading[i] ?? false;
          const sectionKeys = section.fields.map(f => f.key);
          return (
            <Card key={i} className="bg-card border-border">
              <CardHeader className="flex flex-row items-center justify-between pb-3">
                <CardTitle className="text-lg text-primary">{section.title}</CardTitle>
                <div className="flex items-center gap-3">
                  {status && (
                    <span className={`flex items-center gap-1.5 text-sm font-medium max-w-xs text-right ${status.type === "success" ? "text-green-500" : "text-destructive"}`}>
                      {status.type === "success"
                        ? <CheckCircle2 className="h-4 w-4 shrink-0" />
                        : <XCircle className="h-4 w-4 shrink-0" />}
                      {status.msg}
                    </span>
                  )}
                  <Button
                    size="sm"
                    onClick={() => saveSection(i, sectionKeys)}
                    disabled={loading}
                    className="font-bold shrink-0"
                  >
                    {loading
                      ? <Loader2 className="h-4 w-4 animate-spin mr-1" />
                      : <Save className="h-4 w-4 mr-1" />}
                    Lưu
                  </Button>
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                {section.fields.map(field => (
                  <div key={field.key} className="space-y-1.5">
                    <Label className="text-sm font-medium text-foreground">{field.label}</Label>
                    <Input
                      type={field.type || "text"}
                      value={formData[field.key] || ""}
                      onChange={(e) => handleChange(field.key, e.target.value)}
                      className="font-mono bg-background border-border text-sm"
                    />
                  </div>
                ))}
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
