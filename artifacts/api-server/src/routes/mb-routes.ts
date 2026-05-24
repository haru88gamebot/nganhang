import { Router, type Request, type Response } from "express";
import { CoreBankService } from "../services/core-bank.js";
import { warmup, encrypt } from "../services/wasm-engine.js";
import { warmupOCR } from "../services/captcha-ocr.js";
import { getSettings, saveSettings, regenerateCredential } from "../services/settings.js";
import { triggerTestNotification, buildHaru88Payload, notifyCustomWebhook } from "../services/notifier.js";
import { TransactionMonitor } from "../services/monitor.js";
import { requireApiKey } from "../middleware/auth.js";
import { logger } from "../lib/logger.js";
import {
  createPaymentRequest,
  getPaymentRequest,
  getPaymentRequestById,
  listPaymentRequests,
  cancelPaymentRequest,
} from "../services/payment-requests.js";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const router = Router();
export const coreBankService = new CoreBankService();
const txMonitor = new TransactionMonitor(coreBankService);

// ── Public / internal routes (no auth needed) ────────────────────────────────

router.get("/status", (_req: Request, res: Response) => {
  const session = coreBankService.getSession();
  res.json({
    status: "ok",
    loggedIn: !!session?.sessionId,
    username: session?.username || null,
    sessionAge: session ? Math.floor((Date.now() - session.createdAt) / 1000) : null,
  });
});

router.post("/warmup", async (_req: Request, res: Response) => {
  try {
    await warmup();
    await warmupOCR();
    res.json({ success: true, message: "WASM & OCR engine ready" });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post("/captcha", async (_req: Request, res: Response) => {
  try {
    const captcha = await coreBankService.getCaptcha();
    res.json({ success: true, ...captcha });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.get("/settings", (_req: Request, res: Response) => {
  const s = getSettings();
  const { apiCredentials: _omit, ...safe } = s;
  res.json({ success: true, data: safe });
});

router.post("/settings", (req: Request, res: Response) => {
  try {
    saveSettings(req.body);
    const newSettings = getSettings();
    if (newSettings.monitor.running) txMonitor.start();
    else txMonitor.stop();
    const { apiCredentials: _omit, ...safe } = newSettings;
    res.json({ success: true, data: safe });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post("/monitor/test", async (_req: Request, res: Response) => {
  try {
    const result = await triggerTestNotification();
    res.json({ success: true, message: "Test notification sent", ...result });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.get("/credentials", (_req: Request, res: Response) => {
  const settings = getSettings();
  res.json({ success: true, data: settings.apiCredentials });
});

router.post("/credentials/regenerate", (req: Request, res: Response) => {
  try {
    const { field } = req.body;
    if (!["clientId", "apiKey", "checksumKey"].includes(field)) {
      res.status(400).json({ success: false, message: "Invalid field. Must be clientId, apiKey, or checksumKey." });
      return;
    }
    const newValue = regenerateCredential(field as "clientId" | "apiKey" | "checksumKey");
    res.json({ success: true, field, value: newValue });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── /confirm-webhook — Xác nhận và lưu webhook URL ──────────────────────────
router.post("/confirm-webhook", async (req: Request, res: Response) => {
  const { webhookUrl } = req.body;
  if (!webhookUrl || typeof webhookUrl !== "string") {
    res.status(400).json({ code: "01", desc: "webhookUrl là bắt buộc" });
    return;
  }

  const settings = getSettings();
  const testTx = {
    refNo: "HARU88TEST" + Date.now(),
    creditAmount: 1000,
    debitAmount: 0,
    description: "WEBHOOK TEST HARU88",
    transactionDate: new Date().toLocaleString("vi-VN"),
    accountNo: "0987654321",
    beneficiaryName: "HARU88 SYSTEM",
  };

  const payload = buildHaru88Payload(testTx, settings.apiCredentials.checksumKey, true);
  const body = JSON.stringify(payload);

  try {
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Client-ID": settings.apiCredentials.clientId },
      body,
      signal: AbortSignal.timeout(10000),
    });

    if (response.status >= 200 && response.status < 300) {
      saveSettings({ customWebhook: { enabled: true, url: webhookUrl, secret: settings.customWebhook?.secret || "" } });
      logger.info({ webhookUrl }, "Webhook URL confirmed and saved");
      res.json({
        code: "00", desc: "success",
        data: { webhookUrl, accountNumber: testTx.accountNo, accountName: "HARU88 PANEL PRO", name: "HARU88 Payment Monitor", shortName: "HARU88" },
      });
    } else {
      res.status(400).json({ code: "02", desc: `Webhook URL returned HTTP ${response.status}. Expected 2xx.` });
    }
  } catch (err: any) {
    res.status(500).json({ code: "03", desc: `Failed to reach webhook URL: ${err.message}` });
  }
});

// ── SDK Distribution ──────────────────────────────────────────────────────────

// GET /api/sdk/node — download HARU88 Node.js SDK (TypeScript)
router.get("/sdk/node", (_req: Request, res: Response) => {
  // In production bundle: dist/index.mjs → dist/sdk/haru88-node.ts
  const sdkPath = join(dirname(fileURLToPath(import.meta.url)), "sdk", "haru88-node.ts");
  if (!existsSync(sdkPath)) {
    res.status(404).json({ error: "SDK file not found" });
    return;
  }
  const src = readFileSync(sdkPath, "utf-8");
  res.setHeader("Content-Type", "application/typescript");
  res.setHeader("Content-Disposition", 'attachment; filename="haru88-node.ts"');
  res.send(src);
});

// GET /api/sdk/web — serve HARU88 Web Checkout Script
router.get("/sdk/web", (_req: Request, res: Response) => {
  // In production bundle: dist/index.mjs → dist/sdk/haru88-web.js
  const sdkPath = join(dirname(fileURLToPath(import.meta.url)), "sdk", "haru88-web.js");
  if (!existsSync(sdkPath)) {
    res.status(404).json({ error: "SDK file not found" });
    return;
  }
  const src = readFileSync(sdkPath, "utf-8");
  res.setHeader("Content-Type", "application/javascript");
  res.setHeader("Cache-Control", "public, max-age=3600");
  res.send(src);
});

// ── Payment Requests (protected) ─────────────────────────────────────────────

// GET /api/payment-requests — list recent
router.get("/payment-requests", requireApiKey, (_req: Request, res: Response) => {
  try {
    const list = listPaymentRequests(100);
    res.json({ code: "00", desc: "success", data: list });
  } catch (err: any) {
    res.status(500).json({ code: "500", desc: err.message });
  }
});

// POST /api/payment-requests — create new
router.post("/payment-requests", requireApiKey, async (req: Request, res: Response) => {
  try {
    const { orderCode, amount, description, returnUrl, cancelUrl, expireInMinutes, buyerName } = req.body;

    if (!orderCode || typeof orderCode !== "number") {
      res.status(400).json({ code: "01", desc: "orderCode (number) là bắt buộc" });
      return;
    }
    if (!amount || typeof amount !== "number" || amount < 1000) {
      res.status(400).json({ code: "01", desc: "amount (number, tối thiểu 1000) là bắt buộc" });
      return;
    }
    if (!description || typeof description !== "string") {
      res.status(400).json({ code: "01", desc: "description (string) là bắt buộc" });
      return;
    }
    if (!returnUrl || !cancelUrl) {
      res.status(400).json({ code: "01", desc: "returnUrl và cancelUrl là bắt buộc" });
      return;
    }

    const pr = createPaymentRequest({ orderCode, amount, description, returnUrl, cancelUrl, expireInMinutes, buyerName });

    logger.info({ orderCode, amount, description }, "Payment request created");
    res.json({
      code: "00",
      desc: "success",
      data: {
        id: pr.id,
        orderCode: pr.orderCode,
        status: pr.status,
        amount: pr.amount,
        description: pr.description,
        checkoutUrl: `${req.protocol}://${req.get("host")}/checkout/${pr.id}`,
        returnUrl: pr.returnUrl,
        cancelUrl: pr.cancelUrl,
        expiredAt: pr.expiredAt,
        createdAt: pr.createdAt,
      },
    });
  } catch (err: any) {
    res.status(400).json({ code: "01", desc: err.message });
  }
});

// GET /api/payment-requests/:orderCode — get by orderCode
router.get("/payment-requests/:orderCode", requireApiKey, (req: Request, res: Response) => {
  try {
    const orderCode = Number(req.params.orderCode);
    if (isNaN(orderCode)) {
      res.status(400).json({ code: "01", desc: "orderCode không hợp lệ" });
      return;
    }
    const pr = getPaymentRequest(orderCode);
    if (!pr) {
      res.status(404).json({ code: "404", desc: "Không tìm thấy payment request" });
      return;
    }
    res.json({ code: "00", desc: "success", data: pr });
  } catch (err: any) {
    res.status(500).json({ code: "500", desc: err.message });
  }
});

// PUT /api/payment-requests/:orderCode/cancel — cancel
router.put("/payment-requests/:orderCode/cancel", requireApiKey, (req: Request, res: Response) => {
  try {
    const orderCode = Number(req.params.orderCode);
    const pr = cancelPaymentRequest(orderCode);
    if (!pr) {
      res.status(404).json({ code: "404", desc: "Không tìm thấy payment request" });
      return;
    }
    res.json({ code: "00", desc: "success", data: pr });
  } catch (err: any) {
    res.status(500).json({ code: "500", desc: err.message });
  }
});

// ── Checkout redirect page ────────────────────────────────────────────────────
// GET /checkout/:id — human-readable status page (for returnUrl redirect)
router.get("/checkout/:id/status", (req: Request, res: Response) => {
  const pr = getPaymentRequestById(req.params.id);
  if (!pr) {
    res.status(404).json({ code: "404", desc: "Payment link không tồn tại hoặc đã hết hạn" });
    return;
  }
  res.json({ code: "00", desc: "success", data: { status: pr.status, orderCode: pr.orderCode, amount: pr.amount, paidAt: pr.paidAt } });
});

// ── Protected routes ──────────────────────────────────────────────────────────

router.post("/login", requireApiKey, async (req: Request, res: Response) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      res.status(400).json({ success: false, message: "Missing username or password" });
      return;
    }
    const result = await coreBankService.autoLogin(username, password);
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post("/balance", requireApiKey, async (_req: Request, res: Response) => {
  try {
    const balance = await coreBankService.getBalance();
    res.json({ success: true, data: balance });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post("/transactions", requireApiKey, async (req: Request, res: Response) => {
  try {
    const { accountNumber, fromDate, toDate } = req.body;
    if (!accountNumber || !fromDate || !toDate) {
      res.status(400).json({ success: false, message: "Missing required fields" });
      return;
    }
    const transactions = await coreBankService.getTransactions(accountNumber, fromDate, toDate);
    res.json({ success: true, data: transactions });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post("/encrypt", requireApiKey, async (req: Request, res: Response) => {
  try {
    const { payload, sessionId = "0" } = req.body;
    if (!payload) {
      res.status(400).json({ success: false, message: "Missing payload" });
      return;
    }
    const dataEnc = await encrypt(payload, sessionId);
    res.json({ success: true, dataEnc });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
});

export default router;
