/**
 * HARU88 Node.js SDK
 * Tích hợp HARU88 Payment Monitor vào hệ thống của bạn.
 *
 * Usage:
 *   import { HARU88 } from './haru88-node';
 *   const haru88 = new HARU88({ clientId, apiKey, checksumKey, baseUrl });
 */

import { createHmac, timingSafeEqual } from "node:crypto";

export interface HARU88Config {
  clientId: string;
  apiKey: string;
  checksumKey: string;
  baseUrl: string; // e.g. "https://your-haru88-domain.com/api"
}

export interface CreatePaymentRequestData {
  orderCode: number;
  amount: number;
  description: string;
  returnUrl: string;
  cancelUrl: string;
  expireInMinutes?: number;
  buyerName?: string;
}

export interface PaymentRequest {
  id: string;
  orderCode: number;
  amount: number;
  description: string;
  returnUrl: string;
  cancelUrl: string;
  status: "PENDING" | "PAID" | "CANCELLED";
  createdAt: string;
  expiredAt: string;
  paidAt?: string;
  cancelledAt?: string;
  txRef?: string;
  accountNumber?: string;
  checkoutUrl?: string;
}

export interface WebhookData {
  orderCode: number;
  amount: number;
  description: string;
  accountNumber: string;
  reference: string;
  transactionDateTime: string;
  currency: string;
  paymentLinkId: string;
  code: string;
  desc: string;
  status?: string;
  returnUrl?: string;
  cancelUrl?: string;
  counterAccountName?: string;
  counterAccountNumber?: string;
  [key: string]: unknown;
}

export interface WebhookPayload {
  code: string;
  desc: string;
  success: boolean;
  data: WebhookData;
  signature: string;
}

class HARU88Error extends Error {
  constructor(
    message: string,
    public readonly code?: string,
    public readonly statusCode?: number
  ) {
    super(message);
    this.name = "HARU88Error";
  }
}

export class HARU88 {
  private readonly config: HARU88Config;

  constructor(config: HARU88Config) {
    if (!config.clientId || !config.apiKey || !config.checksumKey || !config.baseUrl) {
      throw new HARU88Error("clientId, apiKey, checksumKey và baseUrl là bắt buộc");
    }
    this.config = config;
  }

  private get headers(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      "X-Client-ID": this.config.clientId,
      "X-API-Key": this.config.apiKey,
    };
  }

  private async request<T>(
    method: "GET" | "POST" | "PUT",
    path: string,
    body?: unknown
  ): Promise<T> {
    const url = `${this.config.baseUrl}${path}`;
    const res = await fetch(url, {
      method,
      headers: this.headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    const json = (await res.json()) as { code: string; desc: string; data?: T };

    if (!res.ok || (json.code && json.code !== "00" && json.code !== "success")) {
      throw new HARU88Error(
        json.desc || `HTTP ${res.status}`,
        json.code,
        res.status
      );
    }

    return (json.data ?? json) as T;
  }

  // ── Payment Requests ──────────────────────────────────────────────────────

  readonly paymentRequests = {
    /**
     * Tạo đơn hàng mới. Trả về thông tin để hiển thị cho khách chuyển khoản.
     */
    create: (data: CreatePaymentRequestData): Promise<PaymentRequest> =>
      this.request("POST", "/payment-requests", data),

    /**
     * Lấy trạng thái đơn hàng theo orderCode.
     */
    get: (orderCode: number): Promise<PaymentRequest> =>
      this.request("GET", `/payment-requests/${orderCode}`),

    /**
     * Danh sách tất cả đơn hàng gần nhất.
     */
    list: (): Promise<PaymentRequest[]> =>
      this.request("GET", "/payment-requests"),

    /**
     * Hủy đơn hàng PENDING.
     */
    cancel: (orderCode: number): Promise<PaymentRequest> =>
      this.request("PUT", `/payment-requests/${orderCode}/cancel`),
  };

  // ── Webhooks ──────────────────────────────────────────────────────────────

  readonly webhooks = {
    /**
     * Xác minh payload webhook từ HARU88.
     * Ném HARU88Error nếu signature không hợp lệ.
     * Trả về WebhookData đã xác minh.
     */
    verify: (payload: WebhookPayload): WebhookData => {
      const { data, signature } = payload;
      if (!data || !signature) {
        throw new HARU88Error("Payload thiếu data hoặc signature");
      }

      const sortedStr = Object.keys(data)
        .sort()
        .map((k) => `${k}=${data[k] ?? ""}`)
        .join("&");

      const expected = createHmac("sha256", this.config.checksumKey)
        .update(sortedStr)
        .digest("hex");

      let isValid = false;
      try {
        isValid = timingSafeEqual(
          Buffer.from(expected),
          Buffer.from(signature)
        );
      } catch {
        isValid = false;
      }

      if (!isValid) {
        throw new HARU88Error("Signature không hợp lệ", "INVALID_SIGNATURE", 401);
      }

      return data;
    },

    /**
     * Xác minh từ Express request body (đã parse JSON).
     * Tiện hơn khi dùng với Express middleware.
     */
    verifyFromRequest: (body: unknown): WebhookData => {
      return (this as any).webhooks.verify(body as WebhookPayload);
    },
  };

  // ── Monitor ───────────────────────────────────────────────────────────────

  readonly monitor = {
    /** Kiểm tra trạng thái server và session MB Bank. */
    status: (): Promise<{ status: string; loggedIn: boolean; username: string | null }> =>
      this.request("GET", "/status"),
  };
}

export default HARU88;
