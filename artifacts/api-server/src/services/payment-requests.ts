import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";

export type PaymentStatus = "PENDING" | "PAID" | "CANCELLED";

export interface PaymentRequest {
  id: string;
  orderCode: number;
  amount: number;
  description: string;
  returnUrl: string;
  cancelUrl: string;
  status: PaymentStatus;
  createdAt: string;
  expiredAt: string;
  paidAt?: string;
  cancelledAt?: string;
  txRef?: string;
  accountNumber?: string;
  buyerName?: string;
}

function getStorePath(): string {
  const dir = dirname(fileURLToPath(import.meta.url));
  return path.join(dir, "..", "data", "payment_requests.json");
}

function load(): PaymentRequest[] {
  const p = getStorePath();
  if (!fs.existsSync(p)) return [];
  try { return JSON.parse(fs.readFileSync(p, "utf-8")); } catch { return []; }
}

function save(list: PaymentRequest[]): void {
  const p = getStorePath();
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  // Keep max 500 entries
  const trimmed = list.slice(-500);
  fs.writeFileSync(p, JSON.stringify(trimmed, null, 2), "utf-8");
}

// ── Auto-expire PENDING requests past their expiredAt ────────────────────────
function applyExpiry(list: PaymentRequest[]): PaymentRequest[] {
  const now = new Date().toISOString();
  let changed = false;
  const updated = list.map((r) => {
    if (r.status === "PENDING" && r.expiredAt < now) {
      changed = true;
      return { ...r, status: "CANCELLED" as PaymentStatus, cancelledAt: now };
    }
    return r;
  });
  if (changed) save(updated);
  return updated;
}

export function createPaymentRequest(opts: {
  orderCode: number;
  amount: number;
  description: string;
  returnUrl: string;
  cancelUrl: string;
  expireInMinutes?: number;
  buyerName?: string;
}): PaymentRequest {
  const list = load();

  if (list.some((r) => r.orderCode === opts.orderCode && r.status === "PENDING")) {
    throw new Error(`orderCode ${opts.orderCode} đã tồn tại và đang PENDING`);
  }

  const now = new Date();
  const expireMs = (opts.expireInMinutes ?? 15) * 60 * 1000;
  const req: PaymentRequest = {
    id: randomBytes(16).toString("hex"),
    orderCode: opts.orderCode,
    amount: opts.amount,
    description: opts.description.slice(0, 25),
    returnUrl: opts.returnUrl,
    cancelUrl: opts.cancelUrl,
    status: "PENDING",
    createdAt: now.toISOString(),
    expiredAt: new Date(now.getTime() + expireMs).toISOString(),
    buyerName: opts.buyerName,
  };

  list.push(req);
  save(list);
  return req;
}

export function getPaymentRequest(orderCode: number): PaymentRequest | null {
  const list = applyExpiry(load());
  return list.find((r) => r.orderCode === orderCode) ?? null;
}

export function getPaymentRequestById(id: string): PaymentRequest | null {
  const list = applyExpiry(load());
  return list.find((r) => r.id === id) ?? null;
}

export function listPaymentRequests(limit = 50): PaymentRequest[] {
  const list = applyExpiry(load());
  return list.slice(-limit).reverse();
}

export function cancelPaymentRequest(orderCode: number): PaymentRequest | null {
  const list = load();
  const idx = list.findIndex((r) => r.orderCode === orderCode);
  if (idx === -1) return null;
  if (list[idx].status !== "PENDING") return list[idx];
  list[idx] = { ...list[idx], status: "CANCELLED", cancelledAt: new Date().toISOString() };
  save(list);
  return list[idx];
}

// Called by monitor when a new credit TX is detected
export function matchTransaction(tx: {
  creditAmount: number;
  description: string;
  refNo: string;
  accountNo?: string;
  transactionDate?: string;
  beneficiaryName?: string;
}): PaymentRequest | null {
  const list = applyExpiry(load());
  const pending = list.filter((r) => r.status === "PENDING");

  for (const req of pending) {
    const amountMatch = req.amount === tx.creditAmount;
    const descMatch = tx.description
      .toUpperCase()
      .replace(/\s+/g, "")
      .includes(req.description.toUpperCase().replace(/\s+/g, ""));

    if (amountMatch && descMatch) {
      // Mark as PAID
      const idx = list.findIndex((r) => r.id === req.id);
      list[idx] = {
        ...req,
        status: "PAID",
        paidAt: new Date().toISOString(),
        txRef: tx.refNo,
        accountNumber: tx.accountNo,
      };
      save(list);
      return list[idx];
    }
  }
  return null;
}
