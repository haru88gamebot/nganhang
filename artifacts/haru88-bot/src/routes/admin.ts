import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import { eq, desc, sql } from "drizzle-orm";
import { db, botUsersTable, transactionsTable, giftCodesTable, botSettingsTable, gameSessionsTable } from "@workspace/db";
import {
  AdminLoginBody,
  AdminLoginResponse,
  GetAdminStatsResponse,
  GetAdminSettingsResponse,
  SaveAdminSettingsBody,
  SaveAdminSettingsResponse,
  GetAdminUsersResponse,
  AdjustUserBalanceParams,
  AdjustUserBalanceBody,
  AdjustUserBalanceResponse,
  GetAdminTransactionsQueryParams,
  GetAdminTransactionsResponse,
  GetGiftCodesResponse,
  CreateGiftCodeBody,
} from "@workspace/api-zod";
import { logger } from "../lib/logger";
import { telegramBotService } from "../telegram/telegramBot";
import { telegramBot2Service } from "../telegram/telegramBot2";
import { supportBotService } from "../telegram/supportBot";
import { bankService } from "../telegram/bankService";
import { getSetting } from "../lib/settings";

const router: IRouter = Router();

// Admin token: set ADMIN_TOKEN env var to a secret value in production
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "open-access";

export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  const token =
    authHeader?.startsWith("Bearer ") ? authHeader.slice(7) :
    (req.headers["x-admin-token"] as string | undefined);
  if (!token || token !== ADMIN_TOKEN) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
}

router.post("/login", async (req: Request, res: Response): Promise<void> => {
  const parsed = AdminLoginBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, error: "Thiếu thông tin đăng nhập" });
    return;
  }

  const { username, password } = parsed.data;

  // Default credentials — overridable via Admin Panel → Cài đặt → Bảo mật
  const DEFAULT_USERNAME = "0988770961";
  const DEFAULT_PASSWORD = "19112007vV@";

  const configuredUsername = (await getSetting("admin_username")) || DEFAULT_USERNAME;
  const configuredPassword = (await getSetting("admin_password")) || DEFAULT_PASSWORD;

  if (username !== configuredUsername || password !== configuredPassword) {
    res.status(401).json({ success: false, error: "Sai tài khoản hoặc mật khẩu" });
    return;
  }

  const result = AdminLoginResponse.parse({ success: true, token: ADMIN_TOKEN });
  res.json(result);
});

router.get("/stats", requireAdmin, async (_req: Request, res: Response): Promise<void> => {
  const [usersCount] = await db.select({ count: sql<number>`count(*)::int` }).from(botUsersTable);
  const [depositSum] = await db
    .select({ total: sql<number>`coalesce(sum(amount::numeric), 0)::float` })
    .from(transactionsTable)
    .where(eq(transactionsTable.type, "deposit"));
  const [withdrawSum] = await db
    .select({ total: sql<number>`coalesce(sum(amount::numeric), 0)::float` })
    .from(transactionsTable)
    .where(eq(transactionsTable.type, "withdraw"));
  const [betSum] = await db
    .select({ total: sql<number>`coalesce(sum(bet_amount::numeric), 0)::float` })
    .from(gameSessionsTable);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const [activeToday] = await db
    .select({ count: sql<number>`count(distinct user_id)::int` })
    .from(gameSessionsTable)
    .where(sql`created_at >= ${today.toISOString()}`);

  const stats = GetAdminStatsResponse.parse({
    totalUsers: usersCount?.count ?? 0,
    totalDeposits: depositSum?.total ?? 0,
    totalWithdrawals: withdrawSum?.total ?? 0,
    totalBets: betSum?.total ?? 0,
    activeToday: activeToday?.count ?? 0,
  });
  res.json(stats);
});

router.get("/settings", requireAdmin, async (_req: Request, res: Response): Promise<void> => {
  const rows = await db.select().from(botSettingsTable).orderBy(botSettingsTable.key);
  const result = GetAdminSettingsResponse.parse(rows.map((r) => ({ key: r.key, value: r.value })));
  res.json(result);
});

// Validate a Telegram bot token by calling getMe — returns bot username or throws with message
async function validateBotToken(token: string): Promise<string> {
  const resp = await fetch(`https://api.telegram.org/bot${token}/getMe`);
  const body = await resp.json() as { ok: boolean; result?: { username?: string }; description?: string };
  if (!resp.ok || !body.ok) {
    throw new Error(body.description ?? `HTTP ${resp.status}`);
  }
  return body.result?.username ?? "unknown";
}

router.post("/settings", requireAdmin, async (req: Request, res: Response): Promise<void> => {
  const parsed = SaveAdminSettingsBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const savedKeys = parsed.data.settings.map((s) => s.key);
  const getValue = (k: string) => parsed.data.settings.find((s) => s.key === k)?.value ?? "";

  // --- Save to DB immediately (no pre-validation — bot will report errors on startup) ---
  for (const { key, value } of parsed.data.settings) {
    await db
      .insert(botSettingsTable)
      .values({ key, value })
      .onConflictDoUpdate({ target: botSettingsTable.key, set: { value, updatedAt: new Date() } });
  }
  logger.info({ count: parsed.data.settings.length }, "Admin settings saved");

  // Respond immediately — bot restarts run in background so the UI doesn't hang
  res.json(SaveAdminSettingsResponse.parse({ ok: true }));

  // Auto-restart bots / services with new values (fire-and-forget, non-blocking)
  setImmediate(async () => {
    if (savedKeys.includes("bot_token")) {
      const token = getValue("bot_token");
      if (token) {
        try {
          await telegramBotService.stop();
          await new Promise(resolve => setTimeout(resolve, 2000));
          await telegramBotService.initialize(token);
          logger.info("✅ Telegram bot restarted with new token");
        } catch (err) {
          logger.error({ err }, "❌ Failed to restart Telegram bot");
        }
      }
    }
    if (savedKeys.includes("bot2_token")) {
      const token = getValue("bot2_token");
      if (token) {
        try {
          await telegramBot2Service.initialize(token);
          logger.info("✅ Bot2 restarted with new token");
        } catch (err) {
          logger.error({ err }, "❌ Failed to restart Bot2");
        }
      }
    }
    if (savedKeys.includes("support_bot_token")) {
      const token = getValue("support_bot_token");
      if (token) {
        try {
          await supportBotService.stop();
          await new Promise(resolve => setTimeout(resolve, 2000));
          await supportBotService.initialize(token);
          logger.info("✅ Support bot (Bot3) restarted with new token");
        } catch (err) {
          logger.error({ err }, "❌ Failed to restart Support bot");
        }
      }
    }
    if (savedKeys.includes("bank_account_number") || savedKeys.includes("bank_name") || savedKeys.includes("bank_account_holder")) {
      try {
        await bankService.loadAccountInfoFromSettings();
        logger.info("✅ Bank account info reloaded");
      } catch (err) {
        logger.warn({ err }, "⚠️ Failed to reload bank account info");
      }
    }
  });
});

router.get("/users", requireAdmin, async (_req: Request, res: Response): Promise<void> => {
  const users = await db
    .select()
    .from(botUsersTable)
    .orderBy(desc(botUsersTable.createdAt))
    .limit(500);
  const result = GetAdminUsersResponse.parse(
    users.map((u) => ({
      id: u.id,
      username: u.username ?? null,
      firstName: u.firstName ?? null,
      lastName: u.lastName ?? null,
      balance: u.balance,
      totalWagered: u.totalWagered,
      referralCount: u.referralCount,
      isAdmin: u.isAdmin,
      isBanned: u.isBanned,
      createdAt: u.createdAt.toISOString(),
    }))
  );
  res.json(result);
});

router.post("/users/:userId/balance", requireAdmin, async (req: Request, res: Response): Promise<void> => {
  const rawUserId = Array.isArray(req.params.userId) ? req.params.userId[0] : req.params.userId;
  const params = AdjustUserBalanceParams.safeParse({ userId: rawUserId });
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const body = AdjustUserBalanceBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  const [user] = await db.select().from(botUsersTable).where(eq(botUsersTable.id, params.data.userId));
  if (!user) {
    res.status(404).json({ error: "Người dùng không tồn tại" });
    return;
  }
  const currentBalance = parseFloat(user.balance) || 0;
  const newBalance = (currentBalance + body.data.amount).toFixed(0);
  const [updated] = await db
    .update(botUsersTable)
    .set({ balance: newBalance, updatedAt: new Date() })
    .where(eq(botUsersTable.id, params.data.userId))
    .returning();
  if (!updated) {
    res.status(500).json({ error: "Cập nhật thất bại" });
    return;
  }
  await db.insert(transactionsTable).values({
    userId: params.data.userId,
    type: body.data.amount > 0 ? "admin_add" : "admin_deduct",
    amount: Math.abs(body.data.amount).toString(),
    status: "completed",
    method: "admin",
    metadata: { reason: body.data.reason, by: "admin" },
  });
  logger.info({ userId: params.data.userId, amount: body.data.amount }, "Admin balance adjustment");
  res.json(AdjustUserBalanceResponse.parse({ ok: true, message: `Số dư mới: ${updated.balance}` }));
});

router.get("/transactions", requireAdmin, async (req: Request, res: Response): Promise<void> => {
  const qp = GetAdminTransactionsQueryParams.safeParse(req.query);
  const limit = qp.success ? (qp.data.limit ?? 50) : 50;
  const typeFilter = qp.success ? qp.data.type : undefined;

  let query = db.select().from(transactionsTable).orderBy(desc(transactionsTable.createdAt)).$dynamic();
  if (typeFilter) {
    query = query.where(eq(transactionsTable.type, typeFilter));
  }
  const rows = await query.limit(limit);
  const result = GetAdminTransactionsResponse.parse(
    rows.map((t) => ({
      id: t.id,
      userId: t.userId,
      type: t.type,
      amount: t.amount,
      status: t.status,
      method: t.method ?? null,
      createdAt: t.createdAt.toISOString(),
    }))
  );
  res.json(result);
});

router.get("/gift-codes", requireAdmin, async (_req: Request, res: Response): Promise<void> => {
  const codes = await db.select().from(giftCodesTable).orderBy(desc(giftCodesTable.createdAt));
  const result = GetGiftCodesResponse.parse(
    codes.map((c) => ({
      id: c.id,
      code: c.code,
      amount: c.amount,
      maxUses: c.maxUses,
      usedCount: c.usedCount,
      isActive: c.isActive,
      createdAt: c.createdAt.toISOString(),
    }))
  );
  res.json(result);
});

// ── Bot2 Gift Broadcast: restart scheduler (apply toggle immediately) ────────
router.post("/gift-broadcast/restart", requireAdmin, async (_req: Request, res: Response): Promise<void> => {
  try {
    if (telegramBot2Service.isActive()) {
      await telegramBot2Service.restartGiftBroadcastScheduler();
      res.json({ ok: true, message: "Đã cập nhật lịch phát code tặng" });
    } else {
      res.json({ ok: true, message: "Bot2 chưa khởi động — lịch sẽ tự áp dụng khi bot start" });
    }
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? "Lỗi khi restart scheduler" });
  }
});

router.post("/gift-codes", requireAdmin, async (req: Request, res: Response): Promise<void> => {
  const parsed = CreateGiftCodeBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [code] = await db
    .insert(giftCodesTable)
    .values({
      code: parsed.data.code,
      amount: parsed.data.amount,
      maxUses: parsed.data.maxUses,
    })
    .returning();
  if (!code) {
    res.status(500).json({ error: "Tạo mã thất bại" });
    return;
  }
  res.status(201).json({ ok: true, message: `Đã tạo mã: ${code.code}` });
});

export default router;
