import { logger } from "../lib/logger";
import { getSetting } from "../lib/settings";

const SHOPCARD68_ENDPOINT = "https://shopcard68.com/apidaily";
const SHOPCARD68_CHECK_ENDPOINT = "https://shopcard68.com/checkthe";
const FETCH_TIMEOUT_MS = 15_000;

export type SC68Telco = "viettel" | "vina" | "mobi" | "zing";

export const TELCO_LABELS: Record<SC68Telco, string> = {
  viettel: "Viettel",
  vina: "Vinaphone",
  mobi: "Mobifone",
  zing: "Zing",
};

export const CARD_AMOUNTS = [10000, 20000, 50000, 100000, 200000, 500000];

// API returns pipe-delimited plain text, NOT JSON
// Submit:  "200|Gửi thẻ thành công|10000|<transId>"  OR  "100|Error message"
// Check:   "100|0|Đang xử lý"  OR  "200|<price>|<message>"
export interface SC68SubmitResponse {
  status: number;
  message: string;
  price: number;
  transId: string;
}

export interface SC68CheckResponse {
  status: number;
  price: number;
  message: string;
}

export interface SC68SubmitParams {
  telco: SC68Telco;
  code: string;
  serial: string;
  amount: number;
}

function parseSubmitResponse(raw: string): SC68SubmitResponse {
  const parts = raw.trim().split("|");
  const status = parseInt(parts[0] ?? "0", 10);
  const message = parts[1] ?? "";
  const price = parseInt(parts[2] ?? "0", 10) || 0;
  const transId = parts[3] ?? "";
  return { status, message, price, transId };
}

function parseCheckResponse(raw: string): SC68CheckResponse {
  const parts = raw.trim().split("|");
  const status = parseInt(parts[0] ?? "0", 10);
  const price = parseInt(parts[1] ?? "0", 10) || 0;
  const message = parts[2] ?? parts[1] ?? "";
  return { status, price, message };
}

async function fetchWithTimeout(url: string, timeoutMs = FETCH_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export async function isShopCard68Configured(): Promise<boolean> {
  const account = await getSetting("shopcard68_account");
  return !!account;
}

export async function submitCard68(params: SC68SubmitParams): Promise<SC68SubmitResponse> {
  const account = await getSetting("shopcard68_account");
  if (!account) throw new Error("shopcard68_account chưa được cấu hình trong Admin Panel");

  const url = new URL(SHOPCARD68_ENDPOINT);
  url.searchParams.set("daily", account);
  url.searchParams.set("seri", params.code);
  url.searchParams.set("mathe", params.serial);
  url.searchParams.set("loai", params.telco);
  url.searchParams.set("gia", String(params.amount));

  logger.info({ telco: params.telco, amount: params.amount }, "Submitting card to ShopCard68");

  const res = await fetchWithTimeout(url.toString());
  if (!res.ok) {
    throw new Error(`ShopCard68 HTTP error: ${res.status}`);
  }

  const raw = await res.text();
  logger.info({ raw }, "ShopCard68 submit raw response");

  const data = parseSubmitResponse(raw);
  logger.info({ status: data.status, transId: data.transId, price: data.price }, "ShopCard68 submit parsed");
  return data;
}

export async function checkCard68(transactionId: string): Promise<SC68CheckResponse> {
  const account = await getSetting("shopcard68_account");
  if (!account) throw new Error("shopcard68_account chưa được cấu hình");

  const url = new URL(SHOPCARD68_CHECK_ENDPOINT);
  url.searchParams.set("daily", account);
  url.searchParams.set("magd", transactionId);

  const res = await fetchWithTimeout(url.toString());
  if (!res.ok) {
    throw new Error(`ShopCard68 check HTTP error: ${res.status}`);
  }

  const raw = await res.text();
  logger.info({ raw, transactionId }, "ShopCard68 check raw response");
  return parseCheckResponse(raw);
}

export async function pollCard68Result(
  transactionId: string,
  maxAttempts = 18,
  intervalMs = 10000
): Promise<SC68CheckResponse | null> {
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise<void>((resolve) => setTimeout(resolve, intervalMs));
    try {
      const result = await checkCard68(transactionId);
      // status 200 with price > 0 = success
      if (result.status === 200 && result.price > 0) {
        return result;
      }
      // status 100 with price > 0 = also credited (some API variants)
      if (result.price > 0) {
        return result;
      }
      // Terminal failure (not "đang xử lý")
      const msg = result.message.toLowerCase();
      if (result.status === 100 && !msg.includes("xử lý") && !msg.includes("chờ") && !msg.includes("đang")) {
        return result;
      }
    } catch (err) {
      logger.error({ err, transactionId }, "Error polling ShopCard68");
    }
  }
  return null;
}
