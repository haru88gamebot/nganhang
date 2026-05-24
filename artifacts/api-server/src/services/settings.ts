import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";

export interface Settings {
  telegram: { enabled: boolean; botToken: string; chatId: string };
  discord: { enabled: boolean; webhookUrl: string };
  customWebhook: { enabled: boolean; url: string; secret: string };
  monitor: { intervalSeconds: number; running: boolean };
  apiCredentials: { clientId: string; apiKey: string; checksumKey: string };
}

function generateClientId(): string {
  return "haru88-" + randomBytes(8).toString("hex");
}

function generateKey(): string {
  return randomBytes(32).toString("hex");
}

const DEFAULT_SETTINGS: Omit<Settings, "apiCredentials"> = {
  telegram: { enabled: false, botToken: "", chatId: "" },
  discord: { enabled: false, webhookUrl: "" },
  customWebhook: { enabled: false, url: "", secret: "" },
  monitor: { intervalSeconds: 60, running: false },
};

function getSettingsPath(): string {
  const __dirname_local = dirname(fileURLToPath(import.meta.url));
  return path.join(__dirname_local, "..", "data", "settings.json");
}

export const getSettings = (): Settings => {
  const p = getSettingsPath();
  let saved: Partial<Settings> = {};
  if (fs.existsSync(p)) {
    try { saved = JSON.parse(fs.readFileSync(p, "utf-8")); } catch { /**/ }
  }
  const merged = { ...DEFAULT_SETTINGS, ...saved } as Settings;
  if (!merged.apiCredentials?.clientId || !merged.apiCredentials?.apiKey || !merged.apiCredentials?.checksumKey) {
    merged.apiCredentials = {
      clientId: saved.apiCredentials?.clientId || generateClientId(),
      apiKey: saved.apiCredentials?.apiKey || generateKey(),
      checksumKey: saved.apiCredentials?.checksumKey || generateKey(),
    };
    const dir = path.dirname(p);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(p, JSON.stringify(merged, null, 2), "utf-8");
  }
  return merged;
};

export const saveSettings = (newSettings: Partial<Settings>): void => {
  const p = getSettingsPath();
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const current = getSettings();
  const updated = { ...current, ...newSettings };
  fs.writeFileSync(p, JSON.stringify(updated, null, 2), "utf-8");
};

export const regenerateCredential = (field: "clientId" | "apiKey" | "checksumKey"): string => {
  const current = getSettings();
  const newValue = field === "clientId" ? generateClientId() : generateKey();
  current.apiCredentials = { ...current.apiCredentials, [field]: newValue };
  const p = getSettingsPath();
  fs.writeFileSync(p, JSON.stringify(current, null, 2), "utf-8");
  return newValue;
};
