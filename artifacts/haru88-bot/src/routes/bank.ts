import { Router, type Request, type Response } from "express";
import { db, bankTransactionsTable, transactionsTable } from "@workspace/db";
import { eq, and, sql } from "drizzle-orm";
import { storage } from "../lib/storage.js";
import { logger } from "../lib/logger.js";
import { getSetting } from "../lib/settings.js";
import { bankService } from "../telegram/bankService.js";

const router = Router();

interface WebhookPayload {
  status?: string;          // "success" | "expired" (from CoreBank)
  code?: string;            // HARU88XXXXXX (present on expired / matched)
  creditAmount?: number | string;
  amount?: number | string; // also used for "expired" amount
  description?: string;
  refNo?: string;
  transactionDate?: string;
  beneficiaryName?: string;
  beneficiaryBank?: string;
}

router.post("/bank/webhook", async (req: Request, res: Response): Promise<void> => {
  // ── Auth ──────────────────────────────────────────────────────────────────
  const secret = await getSetting("bank_webhook_secret");
  if (secret) {
    const provided =
      (req.headers["x-webhook-secret"] as string) ??
      (req.query["secret"] as string) ??
      "";
    if (provided !== secret) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
  }

  const data = req.body as WebhookPayload;
  if (!data || typeof data !== "object") {
    res.status(400).json({ error: "Invalid payload" });
    return;
  }

  // ── Handle expired notification ───────────────────────────────────────────
  if (data.status === "expired" && data.code) {
    const code = data.code;
    req.log.info({ code }, "⏰ Deposit code expired — notifying user");

    // Try in-memory first, fall back to DB (handles server-restart scenarios)
    let pending = bankService.getAndRemovePendingCode(code);
    if (!pending) {
      const dbPending = await bankService.findPendingCodeInDB(code);
      if (dbPending) pending = { userId: dbPending.userId, amount: dbPending.amount, createdAt: new Date() };
    }

    // Mark the pending transaction as cancelled in DB regardless
    await bankService.cancelPendingDepositInDB(code);

    if (pending) {
      try {
        const { telegramBotService } = await import("../telegram/telegramBot.js");
        await telegramBotService.sendNotification(
          pending.userId,
          `⏰ <b>Yêu cầu nạp tiền đã hết hạn!</b>\n\n` +
          `Mã: <code>${code}</code>\n` +
          `Số tiền: <b>${pending.amount.toLocaleString("vi-VN")}đ</b>\n\n` +
          `❌ Đã hết 5 phút mà chưa nhận được giao dịch.\n` +
          `Vui lòng tạo yêu cầu nạp tiền mới nếu bạn muốn nạp.`
        );
      } catch (err) {
        logger.error({ err }, "Failed to notify user of expired deposit");
      }
    } else {
      req.log.warn({ code }, "Expired code not found in memory or DB — cannot notify user");
    }

    res.json({ ok: true, handled: "expired" });
    return;
  }

  // ── Handle success / incoming transaction ────────────────────────────────
  const creditAmount = Number(data.creditAmount ?? data.amount ?? 0);
  if (creditAmount <= 0) {
    res.json({ ok: true, skipped: "no credit amount" });
    return;
  }

  const description = data.description ?? "";
  const refNo =
    data.refNo ||
    `${data.transactionDate ?? "nodate"}_${creditAmount}_${description.slice(0, 20)}`;

  req.log.info({ refNo, creditAmount, description, status: data.status }, "📥 Bank webhook received");

  // ── Dedup ─────────────────────────────────────────────────────────────────
  const [existing] = await db
    .select()
    .from(bankTransactionsTable)
    .where(eq(bankTransactionsTable.refNo, refNo))
    .limit(1);

  if (existing?.processed) {
    req.log.info({ refNo }, "⏭ Already processed — skipping");
    res.json({ ok: true, skipped: "already processed" });
    return;
  }

  // ── Resolve user from code or legacy pattern ──────────────────────────────
  let resolvedUserId: string | null = null;
  let amountVerified = true;

  if (data.status === "success" && data.code) {
    // CoreBank confirmed match — code AND amount already verified by CoreBank
    // Try in-memory Map first, fall back to DB if bot was restarted
    const memPending = bankService.getAndRemovePendingCode(data.code);
    if (memPending) {
      resolvedUserId = memPending.userId;
    } else {
      // In-memory lost (restart) — look up from DB
      const dbPending = await bankService.findPendingCodeInDB(data.code);
      if (dbPending) {
        resolvedUserId = dbPending.userId;
        req.log.info({ code: data.code, userId: resolvedUserId }, "🔄 Recovered userId from DB after restart");
      } else {
        req.log.warn({ code: data.code }, "Code not in memory or DB — may be duplicate callback");
      }
    }
  }

  if (!resolvedUserId) {
    // Try matchAndConsumeCode (for direct CoreBank generic webhook without status field)
    const match = bankService.matchAndConsumeCode(description, creditAmount);
    if (match) {
      if (!match.amountMatches) {
        req.log.warn({ code: match.code, expected: match.expectedAmount, got: creditAmount }, "❌ Amount mismatch");
        if (!existing) {
          await db.insert(bankTransactionsTable).values({
            refNo, userId: match.userId, amount: String(creditAmount),
            description, transactionDate: data.transactionDate ?? "", processed: false,
          }).onConflictDoNothing();
        }
        try {
          const { telegramBotService } = await import("../telegram/telegramBot.js");
          await telegramBotService.sendNotification(
            match.userId,
            `⚠️ <b>Nạp tiền không khớp số tiền!</b>\n\n` +
            `Mã: <code>${match.code}</code>\n` +
            `Số tiền yêu cầu: <b>${match.expectedAmount.toLocaleString("vi-VN")}đ</b>\n` +
            `Số tiền nhận được: <b>${creditAmount.toLocaleString("vi-VN")}đ</b>\n\n` +
            `❌ Chưa được cộng do sai số tiền. Vui lòng liên hệ admin.`
          );
        } catch { /* non-critical */ }
        res.json({ ok: true, skipped: "amount_mismatch" });
        return;
      }
      resolvedUserId = match.userId;
    }
  }

  if (!resolvedUserId) {
    // Legacy fallback: "NAP {userId}" pattern
    const napMatch = description.toUpperCase().match(/NAP\s*(\d{5,12})/);
    if (napMatch) { resolvedUserId = napMatch[1]!; amountVerified = false; }
  }

  // ── Insert raw record ─────────────────────────────────────────────────────
  if (!existing) {
    await db.insert(bankTransactionsTable).values({
      refNo, userId: resolvedUserId, amount: String(creditAmount),
      description, transactionDate: data.transactionDate ?? "", processed: false,
    }).onConflictDoNothing();
  }

  if (!resolvedUserId) {
    req.log.warn({ refNo, description }, "⚠️ No matching user — manual review needed");
    res.json({ ok: true, skipped: "no_user_id" });
    return;
  }

  // ── Credit user ───────────────────────────────────────────────────────────
  const user = await storage.getBotUser(resolvedUserId);
  if (!user) {
    req.log.warn({ refNo, resolvedUserId }, "⚠️ User not found in DB");
    res.json({ ok: true, skipped: "user_not_found" });
    return;
  }

  const currentBalance = parseFloat(user.balance || "0");
  const newBalance = (currentBalance + creditAmount).toFixed(2);
  await storage.updateBotUser(resolvedUserId, { balance: newBalance });

  await storage.createTransaction({
    userId: resolvedUserId, type: "deposit", amount: String(creditAmount),
    status: "completed", method: "bank",
    metadata: { refNo, description, transactionDate: data.transactionDate, beneficiaryName: data.beneficiaryName, source: "webhook", amountVerified },
  });

  await db
    .update(bankTransactionsTable)
    .set({ processed: true, processedAt: new Date(), userId: resolvedUserId })
    .where(eq(bankTransactionsTable.refNo, refNo));

  // Đóng transaction pending gốc (được tạo khi user yêu cầu nạp) → tránh record treo
  if (data.code) {
    try {
      await db
        .update(transactionsTable)
        .set({ status: "completed" } as any)
        .where(
          and(
            eq(transactionsTable.status, "pending"),
            eq(transactionsTable.method, "bank"),
            sql`${transactionsTable.metadata}->>'paymentCode' = ${data.code}`
          )
        );
    } catch (cleanupErr) {
      logger.warn({ cleanupErr, code: data.code }, "Could not close original pending transaction");
    }
  }

  req.log.info({ refNo, userId: resolvedUserId, creditAmount }, "✅ Webhook deposit credited");

  try {
    const { telegramBotService } = await import("../telegram/telegramBot.js");
    await telegramBotService.notifyPaymentSuccess(resolvedUserId, creditAmount, refNo);
  } catch (err) {
    logger.error({ err }, "Failed to notify user of deposit");
  }

  res.json({ ok: true, credited: creditAmount, userId: resolvedUserId });
});

export default router;
