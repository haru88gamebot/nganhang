import { createHmac } from "node:crypto";
import { getSettings } from "./settings.js";
import { logger } from "../lib/logger.js";

export const formatMoney = (amount: number) =>
  new Intl.NumberFormat("vi-VN", { style: "currency", currency: "VND" }).format(amount);

// ── HARU88 Webhook Signature ─────────────────────────────────────────────────
// Sort all keys of `data` alphabetically, build "k=v&k=v" string, HMAC-SHA256
export function buildHaru88Signature(data: Record<string, unknown>, checksumKey: string): string {
  const sorted = Object.keys(data)
    .sort()
    .map((k) => `${k}=${data[k] ?? ""}`)
    .join("&");
  return createHmac("sha256", checksumKey).update(sorted).digest("hex");
}

// ── Map MB Bank transaction → HARU88 webhook data payload ───────────────────
export function mbTxToHaru88Data(tx: any): Record<string, unknown> {
  const amount = tx.creditAmount > 0 ? tx.creditAmount : tx.debitAmount;
  const refNo: string = tx.refNo || String(Date.now());
  let orderCode = 0;
  for (let i = 0; i < Math.min(refNo.length, 9); i++) {
    orderCode = (orderCode * 31 + refNo.charCodeAt(i)) % 1_000_000_000;
  }

  return {
    orderCode,
    amount,
    description: (tx.description || "").slice(0, 25),
    accountNumber: tx.accountNo || tx.accountNumber || "",
    reference: refNo,
    transactionDateTime: tx.transactionDate || new Date().toLocaleString("vi-VN"),
    currency: "VND",
    paymentLinkId: refNo,
    code: "00",
    desc: "Thành công",
    counterAccountBankId: tx.counterAccountBankId || "",
    counterAccountBankName: tx.counterAccountBankName || "",
    counterAccountName: tx.beneficiaryName || tx.counterAccountName || "",
    counterAccountNumber: tx.beneficiaryAccount || tx.counterAccountNumber || "",
    virtualAccountName: "",
    virtualAccountNumber: "",
  };
}

// ── Build full HARU88 webhook envelope ───────────────────────────────────────
export function buildHaru88Payload(tx: any, checksumKey: string, isTest = false) {
  const data = mbTxToHaru88Data(tx);
  const signature = buildHaru88Signature(data, checksumKey);
  return {
    code: "00",
    desc: isTest ? "TEST — HARU88 Webhook" : "success",
    success: true,
    data,
    signature,
  };
}

// ── Telegram ─────────────────────────────────────────────────────────────────
export const notifyTelegram = async (message: string): Promise<void> => {
  const settings = getSettings();
  if (!settings.telegram.enabled || !settings.telegram.botToken || !settings.telegram.chatId) return;
  try {
    const url = `https://api.telegram.org/bot${settings.telegram.botToken}/sendMessage`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: settings.telegram.chatId, text: message, parse_mode: "HTML" }),
    });
    if (!res.ok) logger.warn({ status: res.status }, "Telegram notification failed");
  } catch (err: any) {
    logger.error({ err }, "Telegram notification error");
  }
};

// ── Discord ──────────────────────────────────────────────────────────────────
export const notifyDiscord = async (content: string, embed?: any): Promise<void> => {
  const settings = getSettings();
  if (!settings.discord.enabled || !settings.discord.webhookUrl) return;
  try {
    const payload: any = { content };
    if (embed) payload.embeds = [embed];
    const res = await fetch(settings.discord.webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) logger.warn({ status: res.status }, "Discord notification failed");
  } catch (err: any) {
    logger.error({ err }, "Discord notification error");
  }
};

// ── Custom Webhook (HARU88 format) ───────────────────────────────────────────
export const notifyCustomWebhook = async (tx: any, isTest = false): Promise<{ ok: boolean; status?: number; error?: string }> => {
  const settings = getSettings();
  if (!settings.customWebhook.enabled || !settings.customWebhook.url) return { ok: false, error: "Webhook not configured" };

  const payload = buildHaru88Payload(tx, settings.apiCredentials.checksumKey, isTest);
  const body = JSON.stringify(payload);

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Client-ID": settings.apiCredentials.clientId,
  };

  try {
    const res = await fetch(settings.customWebhook.url, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(8000),
    });
    const ok = res.status >= 200 && res.status < 300;
    if (!ok) logger.warn({ status: res.status, url: settings.customWebhook.url }, "Custom webhook returned non-2xx");
    return { ok, status: res.status };
  } catch (err: any) {
    logger.error({ err, url: settings.customWebhook.url }, "Custom webhook error");
    return { ok: false, error: err.message };
  }
};

// ── Broadcast to all channels ─────────────────────────────────────────────────
export const broadcastTransaction = async (tx: any, isTest = false): Promise<void> => {
  const isCredit = tx.creditAmount > 0;
  const amount = isCredit ? tx.creditAmount : tx.debitAmount;
  const typeStr = isCredit ? "Nhận tiền (+)" : "Trừ tiền (-)";
  const emoji = isCredit ? "🟢" : "🔴";
  const title = isTest ? "🔔 TEST NOTIFICATION" : "🔔 BIẾN ĐỘNG SỐ DƯ";

  const telegramMsg =
    `<b>${title}</b>\n\n` +
    `🏦 <b>Tài khoản:</b> ${tx.accountNo}\n` +
    `📅 <b>Thời gian:</b> ${tx.transactionDate}\n` +
    `💳 <b>Loại:</b> ${emoji} ${typeStr}\n` +
    `💰 <b>Số tiền:</b> ${formatMoney(amount)}\n` +
    `📝 <b>Nội dung:</b> <i>${tx.description}</i>\n` +
    `🔖 <b>Mã GD:</b> <code>${tx.refNo}</code>`;

  const discordEmbed = {
    title,
    color: isCredit ? 0x67c23a : 0xf56c6c,
    fields: [
      { name: "Tài khoản", value: tx.accountNo || "Unknown", inline: true },
      { name: "Loại", value: `${emoji} ${typeStr}`, inline: true },
      { name: "Số tiền", value: formatMoney(amount), inline: true },
      { name: "Nội dung", value: tx.description || "N/A" },
      { name: "Mã GD", value: tx.refNo || "N/A", inline: true },
    ],
    footer: { text: "HARU88 Panel PRO" },
    timestamp: new Date().toISOString(),
  };

  await Promise.allSettled([
    notifyTelegram(telegramMsg),
    notifyDiscord("", discordEmbed),
    notifyCustomWebhook(tx, isTest),
  ]);
};

// ── Payment Request Matched notification ─────────────────────────────────────
export const notifyPaymentMatched = async (pr: any, tx: any): Promise<void> => {
  const settings = getSettings();
  const fmt = (n: number) => new Intl.NumberFormat("vi-VN", { style: "currency", currency: "VND" }).format(n);

  // Build HARU88 webhook envelope with payment-request specific data
  const data: Record<string, unknown> = {
    orderCode: pr.orderCode,
    amount: pr.amount,
    description: pr.description,
    accountNumber: tx.accountNo || tx.accountNumber || "",
    reference: tx.refNo || pr.txRef || "",
    transactionDateTime: tx.transactionDate || new Date().toLocaleString("vi-VN"),
    currency: "VND",
    paymentLinkId: pr.id,
    code: "00",
    desc: "Thành công",
    counterAccountBankId: tx.counterAccountBankId || "",
    counterAccountBankName: tx.counterAccountBankName || "",
    counterAccountName: tx.beneficiaryName || "",
    counterAccountNumber: tx.beneficiaryAccount || "",
    virtualAccountName: "",
    virtualAccountNumber: "",
    returnUrl: pr.returnUrl,
    cancelUrl: pr.cancelUrl,
    status: "PAID",
  };
  const signature = buildHaru88Signature(data, settings.apiCredentials.checksumKey);
  const envelope = { code: "00", desc: "success", success: true, data, signature };

  // Send to custom webhook if configured
  if (settings.customWebhook.enabled && settings.customWebhook.url) {
    try {
      await fetch(settings.customWebhook.url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Client-ID": settings.apiCredentials.clientId },
        body: JSON.stringify(envelope),
        signal: AbortSignal.timeout(8000),
      });
    } catch (err: any) {
      logger.error({ err }, "Failed to send payment-matched webhook");
    }
  }

  // Telegram notification
  const tgMsg =
    `<b>✅ THANH TOÁN THÀNH CÔNG — HARU88</b>\n\n` +
    `🔖 <b>Đơn hàng:</b> <code>${pr.orderCode}</code>\n` +
    `💰 <b>Số tiền:</b> ${fmt(pr.amount)}\n` +
    `📝 <b>Nội dung:</b> <i>${pr.description}</i>\n` +
    `🏦 <b>Tài khoản:</b> ${tx.accountNo}\n` +
    `🔗 <b>Mã GD:</b> <code>${tx.refNo}</code>`;

  await notifyTelegram(tgMsg);

  // Discord embed
  await notifyDiscord("", {
    title: "✅ Thanh toán thành công",
    color: 0x67c23a,
    fields: [
      { name: "Đơn hàng", value: String(pr.orderCode), inline: true },
      { name: "Số tiền", value: fmt(pr.amount), inline: true },
      { name: "Nội dung", value: pr.description },
      { name: "Mã GD", value: tx.refNo || "N/A", inline: true },
    ],
    footer: { text: "HARU88 Payment Monitor" },
    timestamp: new Date().toISOString(),
  });
};

// ── Test notification ─────────────────────────────────────────────────────────
export const triggerTestNotification = async (): Promise<{ success: boolean; webhook?: { ok: boolean; status?: number; error?: string } }> => {
  const testTx = {
    refNo: "TEST" + Date.now(),
    creditAmount: 50000,
    debitAmount: 0,
    description: "TEST NOTIFICATION HARU88",
    transactionDate: new Date().toLocaleString("vi-VN"),
    accountNo: "0987654321",
    beneficiaryName: "NGUYEN VAN A",
  };
  await broadcastTransaction(testTx, true);
  const webhookResult = await notifyCustomWebhook(testTx, true);
  return { success: true, webhook: webhookResult };
};
