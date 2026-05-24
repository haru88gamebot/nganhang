import { db } from "@workspace/db";
import { bankTransactionsTable, botUsersTable, transactionsTable } from "@workspace/db";
import { eq, and, sql } from "drizzle-orm";
import { storage } from "../lib/storage.js";
import { logger } from "../lib/logger.js";
import { getSetting } from "../lib/settings.js";

const POLL_INTERVAL_MS = 20_000;

interface BankTransaction {
  transactionDate: string;
  creditAmount: number;
  debitAmount: number;
  description: string;
  beneficiaryName?: string;
  beneficiaryBank?: string;
  refNo: string;
}

interface BankStatusResponse {
  status: string;
  loggedIn: boolean;
  username?: string;
  sessionAge?: number;
}

interface PendingCode {
  userId: string;
  amount: number;
  createdAt: Date;
}

class BankService {
  private pollingTimer: NodeJS.Timeout | null = null;
  private isLoggedIn = false;
  private accountNumber: string = "";
  private customerName: string = "";
  private allAccounts: Array<{ number: string; name: string; currency: string; balance: number }> = [];
  private lastPollDate: string = "";
  private pendingCodes: Map<string, PendingCode> = new Map();

  // ========== SETTINGS-BASED ACCOUNT INFO ==========

  async loadAccountInfoFromSettings(): Promise<void> {
    const accNum = await getSetting("bank_account_number");
    const accHolder = await getSetting("bank_account_holder");
    if (accNum) this.accountNumber = accNum;
    if (accHolder) this.customerName = accHolder;
  }

  // ========== COREBANK REGISTRATION ==========

  /**
   * Register a pending deposit with CoreBank so it can watch for the
   * matching bank transaction and fire a callback when found or expired.
   */
  async registerPendingWithCoreBank(
    code: string,
    amount: number,
    callbackUrl: string,
    secret?: string
  ): Promise<void> {
    const bankApiUrl = await this.getBankApiUrl();

    try {
      const authHeaders = await this.getAuthHeaders();
      const res = await fetch(`${bankApiUrl}/pending-deposit`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({ code, amount, callbackUrl, secret: secret || undefined }),
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) {
        const body = await res.json() as { message?: string };
        logger.info({ code, amount, msg: body.message }, "📋 Registered pending deposit with CoreBank");
      } else {
        logger.warn({ code, status: res.status }, "⚠️ CoreBank pending-deposit registration failed");
      }
    } catch (err) {
      logger.warn({ err, code }, "⚠️ Could not reach CoreBank to register pending deposit");
    }
  }

  /**
   * Look up a pending code (for expired callback handling) and remove it.
   */
  getAndRemovePendingCode(code: string): PendingCode | null {
    const pending = this.pendingCodes.get(code);
    if (pending) {
      this.pendingCodes.delete(code);
      return pending;
    }
    return null;
  }

  /**
   * DB fallback: find a pending deposit transaction by HARU88 code.
   * Used when the in-memory Map is lost (e.g. server restart).
   */
  async findPendingCodeInDB(code: string): Promise<{ userId: string; amount: number } | null> {
    try {
      const [row] = await db
        .select({ userId: transactionsTable.userId, amount: transactionsTable.amount })
        .from(transactionsTable)
        .where(
          and(
            eq(transactionsTable.status, "pending"),
            eq(transactionsTable.method, "bank"),
            sql`${transactionsTable.metadata}->>'paymentCode' = ${code}`
          )
        )
        .limit(1);
      if (!row) return null;
      return { userId: row.userId, amount: Number(row.amount) };
    } catch (err) {
      logger.warn({ err, code }, "DB fallback lookup for pending code failed");
      return null;
    }
  }

  /**
   * Mark a pending deposit transaction as cancelled in DB (on expiry).
   */
  async cancelPendingDepositInDB(code: string): Promise<void> {
    try {
      await db
        .update(transactionsTable)
        .set({ status: "cancelled" } as any)
        .where(
          and(
            eq(transactionsTable.status, "pending"),
            eq(transactionsTable.method, "bank"),
            sql`${transactionsTable.metadata}->>'paymentCode' = ${code}`
          )
        );
    } catch (err) {
      logger.warn({ err, code }, "Failed to cancel pending deposit in DB");
    }
  }

  // ========== PUBLIC CODE MATCHING (for webhook handler) ==========

  /**
   * Match an incoming webhook transaction by description + amount.
   * Returns match result including whether the amount is correct.
   * Consumes the pending code on a full match only.
   */
  matchAndConsumeCode(description: string, incomingAmount: number): {
    userId: string;
    expectedAmount: number;
    amountMatches: boolean;
    code: string;
  } | null {
    if (!description) return null;

    const haruMatch = description.match(/HARU88([A-Z0-9]{6})/i);
    if (!haruMatch) return null;

    const code = `HARU88${haruMatch[1]!.toUpperCase()}`;
    const pending = this.pendingCodes.get(code);
    if (!pending) return null;

    // Allow ±1 VND tolerance for rounding differences
    const amountMatches = Math.abs(incomingAmount - pending.amount) <= 1;

    if (amountMatches) {
      this.pendingCodes.delete(code);
      logger.info({ code, userId: pending.userId, amount: incomingAmount }, "✅ Code + amount matched");
    } else {
      logger.warn({ code, userId: pending.userId, expected: pending.amount, got: incomingAmount }, "❌ Amount mismatch — not consuming code");
    }

    return {
      userId: pending.userId,
      expectedAmount: pending.amount,
      amountMatches,
      code,
    };
  }

  // ========== API HELPERS ==========

  private async getBankApiUrl(): Promise<string> {
    const corebankUrl = await getSetting("corebank_api_url");
    return (corebankUrl || "http://localhost:8080").replace(/\/$/, "") + "/api";
  }

  private async getAuthHeaders(): Promise<Record<string, string>> {
    const clientId = await getSetting("corebank_client_id");
    const apiKey = await getSetting("corebank_api_key");
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (clientId) headers["X-Client-ID"] = clientId;
    if (apiKey) headers["X-API-Key"] = apiKey;
    return headers;
  }

  private async apiPost<T>(path: string, body: Record<string, unknown> = {}): Promise<T> {
    const bankApiUrl = await this.getBankApiUrl();
    const res = await fetch(`${bankApiUrl}${path}`, {
      method: "POST",
      headers: await this.getAuthHeaders(),
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Bank API ${path} returned ${res.status}`);
    return res.json() as Promise<T>;
  }

  private async apiGet<T>(path: string): Promise<T> {
    const bankApiUrl = await this.getBankApiUrl();
    const authHeaders = await this.getAuthHeaders();
    const { "Content-Type": _ct, ...getHeaders } = authHeaders;
    const res = await fetch(`${bankApiUrl}${path}`, { headers: getHeaders });
    if (!res.ok) throw new Error(`Bank API GET ${path} returned ${res.status}`);
    return res.json() as Promise<T>;
  }

  // ========== AUTH ==========

  async login(): Promise<boolean> {
    const username = await getSetting("bank_username");
    const password = await getSetting("bank_password");
    if (!username || !password) {
      logger.warn("bank_username or bank_password not set — bank integration disabled");
      return false;
    }

    try {
      const res = await this.apiPost<{
        success: boolean;
        message: string;
        attempts: number;
        data?: { sessionId: string; customerName: string };
      }>("/login", { username, password });

      if (res.success) {
        this.isLoggedIn = true;
        if (res.data?.customerName) this.customerName = res.data.customerName;
        logger.info({ customerName: res.data?.customerName, accountNumber: this.accountNumber }, "✅ Bank login successful");
        // Auto-fetch account info from balance
        await this.fetchAndStoreAccountInfo();
        return true;
      } else {
        logger.error({ message: res.message }, "❌ Bank login failed");
        this.isLoggedIn = false;
        return false;
      }
    } catch (err) {
      logger.error({ err }, "❌ Bank login error");
      this.isLoggedIn = false;
      return false;
    }
  }

  async ensureLoggedIn(): Promise<boolean> {
    try {
      const status = await this.apiGet<BankStatusResponse>("/status");
      if (status.loggedIn) {
        this.isLoggedIn = true;
        return true;
      }
    } catch {
      // ignore — fall through to login
    }
    return this.login();
  }

  // ========== BALANCE ==========

  async getBalance(): Promise<{ totalBalance: number; accounts: Array<{ number: string; name: string; balance: number; currency: string }> } | null> {
    try {
      if (!(await this.ensureLoggedIn())) return null;
      const res = await this.apiPost<{ success: boolean; data: { totalBalance: number; currencyEquivalent: string; accounts: Array<{ number: string; name: string; currency: string; balance: number }> } }>("/balance");
      return res.success ? res.data : null;
    } catch (err) {
      logger.error({ err }, "Failed to get bank balance");
      return null;
    }
  }

  private async fetchAndStoreAccountInfo(): Promise<void> {
    try {
      const res = await this.apiPost<{
        success: boolean;
        data: {
          totalBalance: number;
          currencyEquivalent: string;
          accounts: Array<{ number: string; name: string; currency: string; balance: number }>;
        };
      }>("/balance");

      if (res.success && res.data.accounts.length > 0) {
        this.allAccounts = res.data.accounts as any;
        const primary = res.data.accounts[0]!;
        // Use account number from API if not already set via env
        if (!this.accountNumber) this.accountNumber = primary.number;
        // Use account holder name from API
        if (primary.name) this.customerName = primary.name;
        logger.info(
          {
            accounts: res.data.accounts.map(a => `${a.number} (${a.name})`),
            totalBalance: res.data.totalBalance,
          },
          `🏦 Bank account info loaded — ${res.data.accounts.length} tài khoản`
        );
      }
    } catch (err) {
      logger.warn({ err }, "Could not fetch account info from balance API");
    }
  }

  // ========== TRANSACTION POLLING ==========

  private getDateRange(): { fromDate: string; toDate: string } {
    const now = new Date();
    const from = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000); // last 2 days
    const fmt = (d: Date) =>
      `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`;
    return { fromDate: fmt(from), toDate: fmt(now) };
  }

  private generateCode(): string {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    let suffix = "";
    for (let i = 0; i < 6; i++) {
      suffix += chars[Math.floor(Math.random() * chars.length)];
    }
    return `HARU88${suffix}`;
  }

  createPaymentCode(userId: string, amount: number): {
    code: string;
    qrUrl: string;
    accountNumber: string;
    accountHolder: string;
    bank: string;
  } {
    // Clean up expired codes (older than 24h)
    const expiry = Date.now() - 24 * 60 * 60 * 1000;
    for (const [code, data] of this.pendingCodes.entries()) {
      if (data.createdAt.getTime() < expiry) this.pendingCodes.delete(code);
    }

    // Generate unique code
    let code = this.generateCode();
    while (this.pendingCodes.has(code)) code = this.generateCode();

    this.pendingCodes.set(code, { userId, amount, createdAt: new Date() });

    // Use in-memory values (loaded from DB at startup or on first use)
    const accountNumber = this.accountNumber;
    const accountHolder = this.customerName || process.env["BANK_ACCOUNT_HOLDER"] || "CHU TAI KHOAN";
    const bank = process.env["BANK_NAME"] || "MB Bank";

    const qrUrl = `https://img.vietqr.io/image/${bank.replace(/\s/g,'')}-${accountNumber}-compact2.png` +
      `?amount=${amount}` +
      `&addInfo=${encodeURIComponent(code)}` +
      `&accountName=${encodeURIComponent(accountHolder)}`;

    logger.info({ code, userId, amount }, "💳 Payment code created");
    return { code, qrUrl, accountNumber, accountHolder, bank };
  }

  private extractUserId(description: string): string | null {
    if (!description) return null;

    // Pattern 1: HARU88XXXXXX — look up in pendingCodes map
    const haruMatch = description.match(/HARU88([A-Z0-9]{6})/i);
    if (haruMatch) {
      const code = `HARU88${haruMatch[1]!.toUpperCase()}`;
      const pending = this.pendingCodes.get(code);
      if (pending) {
        logger.info({ code, userId: pending.userId }, "✅ Matched HARU88 code to user");
        this.pendingCodes.delete(code); // remove after match
        return pending.userId;
      }
    }

    // Pattern 2: legacy "nap [digits]"
    const napMatch = description.match(/(?:nap|naptien|naphe|deposit)\s*(\d{5,12})/i);
    if (napMatch) return napMatch[1]!;

    // Pattern 3: standalone Telegram user ID (7-12 digits)
    const numMatch = description.match(/\b(\d{7,12})\b/);
    if (numMatch) return numMatch[1]!;

    return null;
  }

  private async isAlreadyProcessed(refNo: string): Promise<boolean> {
    const [existing] = await db
      .select()
      .from(bankTransactionsTable)
      .where(and(eq(bankTransactionsTable.refNo, refNo), eq(bankTransactionsTable.processed, true)))
      .limit(1);
    return !!existing;
  }

  private async getExistingUnprocessed(refNo: string): Promise<{ userId: string | null } | null> {
    const [existing] = await db
      .select()
      .from(bankTransactionsTable)
      .where(and(eq(bankTransactionsTable.refNo, refNo), eq(bankTransactionsTable.processed, false)))
      .limit(1);
    return existing ?? null;
  }

  async pollTransactions(): Promise<void> {
    try {
      if (!(await this.ensureLoggedIn())) {
        logger.warn("Bank poll skipped — not logged in");
        return;
      }

      // Build list of accounts to poll — all known accounts or fallback to env var
      const accountsToPoll: string[] = this.allAccounts.length > 0
        ? this.allAccounts.map(a => a.number)
        : this.accountNumber
          ? [this.accountNumber]
          : [];

      if (accountsToPoll.length === 0) {
        logger.warn("No account numbers available — skipping poll");
        return;
      }

      const { fromDate, toDate } = this.getDateRange();
      let totalCredits = 0;

      for (const accountNumber of accountsToPoll) {
        const res = await this.apiPost<{ success: boolean; data: BankTransaction[] }>("/transactions", {
          accountNumber,
          fromDate,
          toDate,
        });

        if (!res.success || !Array.isArray(res.data)) {
          logger.warn({ accountNumber }, "Bank transactions fetch returned non-success");
          continue;
        }

        const credits = res.data.filter((tx) => parseFloat(String(tx.creditAmount)) > 0);
        totalCredits += credits.length;

        for (const tx of credits) {
          await this.processDepositTransaction(tx);
        }
      }

      logger.info(
        { totalCredits, accounts: accountsToPoll.length, fromDate, toDate },
        "📊 Bank poll complete"
      );
    } catch (err) {
      logger.error({ err }, "❌ Bank poll error");
      this.isLoggedIn = false;
    }
  }

  private async processDepositTransaction(tx: BankTransaction): Promise<void> {
    const refNo = tx.refNo || `${tx.transactionDate}_${tx.creditAmount}_${tx.description?.slice(0, 20)}`;
    const creditAmount = parseFloat(String(tx.creditAmount));

    // Skip if already fully processed
    if (await this.isAlreadyProcessed(refNo)) return;

    // Check if a previous attempt started but crashed (processed=false in DB)
    const existingRecord = await this.getExistingUnprocessed(refNo);

    // Try to extract userId — from HARU88 code or legacy patterns
    // If the code was already consumed from pendingCodes in a previous crashed attempt,
    // fall back to the userId stored in the DB record
    let extractedUserId = this.extractUserId(tx.description || "");
    if (!extractedUserId && existingRecord?.userId) {
      extractedUserId = existingRecord.userId;
      logger.info({ refNo, userId: extractedUserId }, "🔄 Recovering failed deposit from DB record");
    }

    // Insert or update the DB record
    if (!existingRecord) {
      await db.insert(bankTransactionsTable).values({
        refNo,
        userId: extractedUserId,
        amount: String(creditAmount),
        description: tx.description,
        transactionDate: tx.transactionDate,
        processed: false,
      }).onConflictDoNothing();
    }

    if (!extractedUserId) {
      logger.warn({ refNo, description: tx.description }, "⚠️ Bank deposit with no matching user ID — manual review needed");
      return;
    }

    // Verify user exists
    const user = await storage.getBotUser(extractedUserId);
    if (!user) {
      logger.warn({ refNo, extractedUserId }, "⚠️ Bank deposit user ID not found in DB");
      return;
    }

    // Credit user balance — parse both values as numbers (API may return strings)
    const currentBalance = parseFloat(user.balance || "0");
    const newBalance = (currentBalance + creditAmount).toFixed(2);
    await storage.updateBotUser(extractedUserId, { balance: newBalance });

    // Record transaction
    await storage.createTransaction({
      userId: extractedUserId,
      type: "deposit",
      amount: String(creditAmount),
      status: "completed",
      method: "bank",
      metadata: {
        refNo,
        description: tx.description,
        transactionDate: tx.transactionDate,
        beneficiaryName: tx.beneficiaryName,
      },
    });

    // Mark as processed
    await db
      .update(bankTransactionsTable)
      .set({ processed: true, processedAt: new Date(), userId: extractedUserId })
      .where(eq(bankTransactionsTable.refNo, refNo));

    logger.info({ refNo, userId: extractedUserId, amount: creditAmount }, "✅ Deposit credited to user");

    // Notify user via Telegram bot
    try {
      const { telegramBotService } = await import("./telegramBot.js");
      await telegramBotService.notifyPaymentSuccess(extractedUserId, creditAmount, refNo);
    } catch (err) {
      logger.error({ err }, "Failed to notify user of deposit");
    }
  }

  // ========== PAYMENT INFO ==========

  getPaymentInfo(userId: string, amount: number): {
    accountNumber: string;
    accountHolder: string;
    bank: string;
    description: string;
    amount: number;
  } {
    return {
      accountNumber: this.accountNumber,
      accountHolder: this.customerName || process.env["BANK_ACCOUNT_HOLDER"] || "CHU TAI KHOAN",
      bank: process.env["BANK_NAME"] || "MB Bank",
      description: `NAP ${userId}`,
      amount,
    };
  }

  // ========== LIFECYCLE ==========

  async start(): Promise<void> {
    const username = await getSetting("bank_username");
    const password = await getSetting("bank_password");
    if (!username || !password) {
      logger.warn("bank_username/bank_password not set in DB or env — bank polling disabled");
      return;
    }
    // Prefill accountNumber from DB setting if available
    const dbAccNum = await getSetting("bank_account_number");
    if (dbAccNum) this.accountNumber = dbAccNum;

    logger.info("🏦 Starting bank integration service...");

    // Warmup WASM engine
    try {
      await this.apiPost("/warmup");
      logger.info("🔥 Bank WASM engine warmed up");
    } catch {
      // non-critical
    }

    const loggedIn = await this.login();
    if (!loggedIn) {
      logger.warn("Initial bank login failed — will retry on next poll cycle");
    }

    // Start polling
    this.pollingTimer = setInterval(() => {
      this.pollTransactions().catch((err) =>
        logger.error({ err }, "Unhandled error in bank poll")
      );
    }, POLL_INTERVAL_MS);

    // Run immediately
    this.pollTransactions().catch((err) =>
      logger.error({ err }, "Initial bank poll error")
    );

    logger.info({ intervalMs: POLL_INTERVAL_MS }, "✅ Bank polling started");
  }

  stop(): void {
    if (this.pollingTimer) {
      clearInterval(this.pollingTimer);
      this.pollingTimer = null;
    }
  }
}

export const bankService = new BankService();
