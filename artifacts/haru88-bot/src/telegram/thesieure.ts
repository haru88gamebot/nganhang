import crypto from "crypto";
import { logger } from "../lib/logger";

const TSR_ENDPOINT = "https://thesieure.com/chargingws/v2";

export const TSR_PARTNER_ID = process.env["TSR_PARTNER_ID"] ?? "";
export const TSR_PARTNER_KEY = process.env["TSR_PARTNER_KEY"] ?? "";

export function isTSRConfigured(): boolean {
  return !!(TSR_PARTNER_ID && TSR_PARTNER_KEY);
}

export type TsrTelco = "VIETTEL" | "VINAPHONE" | "MOBIFONE" | "VNMOBI";

export const TELCO_LABELS: Record<TsrTelco, string> = {
  VIETTEL: "Viettel",
  VINAPHONE: "Vinaphone",
  MOBIFONE: "Mobifone",
  VNMOBI: "Vietnamobile",
};

export const CARD_AMOUNTS = [10000, 20000, 50000, 100000, 200000, 500000];

export interface TsrSubmitParams {
  telco: TsrTelco;
  code: string;
  serial: string;
  amount: number;
  requestId: string;
}

export interface TsrResponse {
  status: number;
  message: string;
  request_id: string;
  declared_value?: number;
  value?: number | string | null;
  amount?: number;
  code?: string;
  serial?: string;
  telco?: string;
  trans_id?: number;
  callback_sign?: string;
}

export interface TsrCallbackPayload {
  status: string;
  request_id: string;
  trans_id: string;
  declared_value: string;
  value: string;
  amount: string;
  code: string;
  serial: string;
  telco: string;
  callback_sign: string;
}

export function makeSign(requestId: string, code: string, serial: string): string {
  return crypto
    .createHash("md5")
    .update(TSR_PARTNER_KEY + requestId + code + serial)
    .digest("hex");
}

export function verifyCallbackSign(payload: TsrCallbackPayload): boolean {
  const expected = crypto
    .createHash("md5")
    .update(TSR_PARTNER_KEY + payload.request_id + payload.trans_id + payload.value + payload.amount)
    .digest("hex");
  return expected === payload.callback_sign;
}

export async function submitCard(params: TsrSubmitParams): Promise<TsrResponse> {
  const sign = makeSign(params.requestId, params.code, params.serial);

  const body = new URLSearchParams({
    telco: params.telco,
    code: params.code,
    serial: params.serial,
    amount: String(params.amount),
    request_id: params.requestId,
    partner_id: TSR_PARTNER_ID,
    command: "charging",
    sign,
  });

  logger.info({ requestId: params.requestId, telco: params.telco, amount: params.amount }, "Submitting card to TSR");

  const res = await fetch(TSR_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!res.ok) {
    throw new Error(`TSR HTTP error: ${res.status}`);
  }

  const data = (await res.json()) as TsrResponse;
  logger.info({ requestId: params.requestId, status: data.status }, "TSR response received");
  return data;
}
