export interface MBResponse<T = unknown> {
  result: { ok: boolean; responseCode: string; message: string };
  sessionId?: string;
  [key: string]: T | unknown;
}

export interface CaptchaResponse {
  imageString: string;
  result: { ok: boolean; responseCode: string; message: string };
}

export interface AccountBalance {
  number: string;
  name: string;
  currency: string;
  balance: number;
}

export interface BalanceSummary {
  totalBalance: number;
  currencyEquivalent: string;
  accounts: AccountBalance[];
}

export interface Transaction {
  postDate: string;
  transactionDate: string;
  accountNumber: string;
  creditAmount: number;
  debitAmount: number;
  currency: string;
  description: string;
  availableBalance: number;
  refNo: string;
  beneficiaryName?: string;
  beneficiaryBank?: string;
  beneficiaryAccount?: string;
  type?: string;
}

export interface SessionState {
  sessionId: string;
  deviceId: string;
  username: string;
  createdAt: number;
}

export interface LoginRequest {
  username: string;
  password: string;
}
