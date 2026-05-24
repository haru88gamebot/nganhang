import { PayOS } from "@payos/node";
import { getSetting } from "../lib/settings";

// Map bank short codes to PayOS BIN numbers
const BANK_BIN_MAP: Record<string, string> = {
  ACB: "970416",
  BIDV: "970418",
  MBB: "970422",
  MSB: "970426",
  TCB: "970407",
  TPB: "970423",
  VCB: "970436",
  VIB: "970441",
  VPB: "970432",
  VTB: "970415",
  SHB: "970443",
  ABB: "970425",
  AGR: "970405",
  VCCB: "970454",
  BVB: "970438",
  DAB: "970406",
  EIB: "970431",
  GPB: "970408",
  HDB: "970437",
  KLB: "970452",
  NAB: "970428",
  NCB: "970419",
  OCB: "970448",
  OJB: "970414",
  PGB: "970430",
  PVB: "970412",
  STB: "970403",
  SGB: "970400",
  SCB: "970429",
  SAB: "970440",
  SHIB: "970424",
};

export interface PayoutResult {
  success: boolean;
  payoutId?: string;
  errorMessage?: string;
}

async function getPayOS(): Promise<PayOS> {
  const clientId = await getSetting("payos_client_id");
  const apiKey = await getSetting("payos_api_key");
  const checksumKey = await getSetting("payos_checksum_key");
  return new PayOS({ clientId, apiKey, checksumKey });
}

export async function createBankPayout(params: {
  referenceId: string;
  amount: number;
  bankCode: string;
  accountNumber: string;
  description: string;
}): Promise<PayoutResult> {
  try {
    const bin = BANK_BIN_MAP[params.bankCode.toUpperCase()];
    if (!bin) {
      return { success: false, errorMessage: `Ngân hàng ${params.bankCode} chưa được hỗ trợ qua PayOS` };
    }

    const payos = await getPayOS();
    const payout = await payos.payouts.create(
      {
        referenceId: params.referenceId,
        amount: params.amount,
        description: params.description,
        toBin: bin,
        toAccountNumber: params.accountNumber,
      },
      params.referenceId
    );

    const approved = payout.approvalState === "COMPLETED" || payout.approvalState === "PROCESSING" || payout.approvalState === "SUBMITTED" || payout.approvalState === "APPROVED";
    if (approved) {
      return { success: true, payoutId: payout.id };
    } else {
      const tx = payout.transactions?.[0];
      return {
        success: false,
        payoutId: payout.id,
        errorMessage: tx?.errorMessage || `Trạng thái: ${payout.approvalState}`,
      };
    }
  } catch (err: any) {
    const msg = err?.message || String(err);
    return { success: false, errorMessage: msg };
  }
}

export function isBankCodeSupported(bankCode: string): boolean {
  return !!BANK_BIN_MAP[bankCode.toUpperCase()];
}

export async function isPayOSConfigured(): Promise<boolean> {
  const clientId = await getSetting("payos_client_id");
  const apiKey = await getSetting("payos_api_key");
  const checksumKey = await getSetting("payos_checksum_key");
  return !!(clientId && apiKey && checksumKey);
}
