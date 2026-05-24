import { db, botSettingsTable } from "@workspace/db";
import { eq } from "drizzle-orm";

const ENV_FALLBACKS: Record<string, string> = {
  bot_token: "BOT_TOKEN",
  bot2_token: "BOT2_TOKEN",
  support_bot_token: "SUPPORT_BOT_TOKEN",
  shopcard68_account: "SHOPCARD68_ACCOUNT",
  bank_account_number: "BANK_ACCOUNT_NUMBER",
  bank_name: "BANK_NAME",
  bank_account_holder: "BANK_ACCOUNT_HOLDER",
  bank_webhook_secret: "BANK_WEBHOOK_SECRET",
  corebank_api_url: "COREBANK_API_URL",
  corebank_client_id: "COREBANK_CLIENT_ID",
  corebank_api_key: "COREBANK_API_KEY",
  bot_webhook_url: "BOT_WEBHOOK_URL",
  payos_client_id: "PAYOS_CLIENT_ID",
  payos_api_key: "PAYOS_API_KEY",
  payos_checksum_key: "PAYOS_CHECKSUM_KEY",
  admin_password: "ADMIN_PASSWORD",
  admin_chat_id: "ADMIN_CHAT_ID",
  bot2_gift_channel_id: "BOT2_GIFT_CHANNEL_ID",
};

export async function getSetting(key: string): Promise<string> {
  try {
    const [row] = await db
      .select({ value: botSettingsTable.value })
      .from(botSettingsTable)
      .where(eq(botSettingsTable.key, key));
    if (row?.value) return row.value;
  } catch {
  }
  const envKey = ENV_FALLBACKS[key] ?? key.toUpperCase();
  return process.env[envKey] ?? "";
}

export async function getSettingBool(key: string): Promise<boolean> {
  const v = await getSetting(key);
  return v === "true" || v === "1" || v === "yes";
}

export async function getSettingNumber(key: string, defaultVal = 0): Promise<number> {
  const v = await getSetting(key);
  const n = parseFloat(v);
  return isNaN(n) ? defaultVal : n;
}
