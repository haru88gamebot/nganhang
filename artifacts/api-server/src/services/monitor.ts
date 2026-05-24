import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { getSettings } from "./settings.js";
import { broadcastTransaction, notifyPaymentMatched } from "./notifier.js";
import { matchTransaction } from "./payment-requests.js";
import { logger } from "../lib/logger.js";
import type { CoreBankService } from "./core-bank.js";

function getSeenIdsPath(): string {
  const __dirname_local = dirname(fileURLToPath(import.meta.url));
  return path.join(__dirname_local, "..", "data", "seen_tx.json");
}

function loadSeenIds(): Set<string> {
  try {
    const p = getSeenIdsPath();
    if (!fs.existsSync(p)) return new Set();
    const raw = fs.readFileSync(p, "utf-8");
    const arr = JSON.parse(raw) as string[];
    return new Set(arr);
  } catch {
    return new Set();
  }
}

function persistSeenIds(ids: Set<string>): void {
  try {
    const p = getSeenIdsPath();
    const dir = path.dirname(p);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const arr = Array.from(ids).slice(-2000);
    fs.writeFileSync(p, JSON.stringify(arr), "utf-8");
  } catch { /**/ }
}

export class TransactionMonitor {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private seenTxIds: Set<string>;
  private coreBankService: CoreBankService;

  constructor(coreBankService: CoreBankService) {
    this.coreBankService = coreBankService;
    this.seenTxIds = loadSeenIds();
    const settings = getSettings();
    if (settings.monitor.running) this.start();
  }

  public start(): void {
    if (this.timer) return;
    logger.info("Transaction monitor started");
    this.tick();
  }

  public stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    logger.info("Transaction monitor stopped");
  }

  private async tick(): Promise<void> {
    try {
      const settings = getSettings();
      if (!settings.monitor.running) { this.stop(); return; }
      await this.checkTransactions();
    } catch (err: any) {
      logger.error({ err }, "Monitor tick failed");
    } finally {
      const settings = getSettings();
      if (settings.monitor.running) {
        const interval = Math.max(10, settings.monitor.intervalSeconds) * 1000;
        this.timer = setTimeout(() => this.tick(), interval);
      }
    }
  }

  private async checkTransactions(): Promise<void> {
    const session = this.coreBankService.getSession();
    if (!session?.sessionId) return;

    const balanceResp = await this.coreBankService.getBalance();
    if (!balanceResp?.accounts?.length) return;

    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const todayStr = `${pad(now.getDate())}/${pad(now.getMonth() + 1)}/${now.getFullYear()}`;

    let newTxFound = false;

    for (const account of balanceResp.accounts) {
      const accountNumber = account.number;
      try {
        const txList = await this.coreBankService.getTransactions(accountNumber, todayStr, todayStr);
        const chronologicalTx = [...txList].reverse();

        for (const tx of chronologicalTx) {
          const txId = tx.refNo || `${accountNumber}-${tx.transactionDate}-${tx.creditAmount}-${tx.debitAmount}`;
          if (!this.seenTxIds.has(txId)) {
            this.seenTxIds.add(txId);
            newTxFound = true;
            logger.info({ txId, accountNumber }, "New transaction detected");

            const txWithAccount = { ...tx, accountNo: accountNumber };

            // 1. Broadcast to Telegram / Discord / Webhook (general notification)
            await broadcastTransaction(txWithAccount);

            // 2. Try to match against pending payment requests (credit only)
            if (tx.creditAmount > 0) {
              const matched = matchTransaction({
                creditAmount: tx.creditAmount,
                description: tx.description || "",
                refNo: txId,
                accountNo: accountNumber,
                transactionDate: tx.transactionDate,
                beneficiaryName: tx.beneficiaryName,
              });

              if (matched) {
                logger.info({ orderCode: matched.orderCode, txId }, "Payment request matched!");
                await notifyPaymentMatched(matched, txWithAccount);
              }
            }
          }
        }
      } catch (err: any) {
        logger.warn({ err, accountNumber }, "Failed to fetch transactions for account");
      }
    }

    if (newTxFound) {
      persistSeenIds(this.seenTxIds);
    }
  }
}
