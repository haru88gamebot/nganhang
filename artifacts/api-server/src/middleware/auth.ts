import { type Request, type Response, type NextFunction } from "express";
import { timingSafeEqual } from "node:crypto";
import { getSettings } from "../services/settings.js";

function safeCompare(a: string, b: string): boolean {
  try {
    const bufA = Buffer.from(a);
    const bufB = Buffer.from(b);
    if (bufA.length !== bufB.length) return false;
    return timingSafeEqual(bufA, bufB);
  } catch {
    return false;
  }
}

export function requireApiKey(req: Request, res: Response, next: NextFunction): void {
  const clientId = req.headers["x-client-id"] as string | undefined;
  const apiKey   = req.headers["x-api-key"]   as string | undefined;

  if (!clientId || !apiKey) {
    res.status(401).json({
      success: false,
      message: "Unauthorized: Missing X-Client-ID or X-API-Key header.",
      hint: "Lấy credentials tại trang Cài đặt → Thông tin xác thực API",
    });
    return;
  }

  const creds = getSettings().apiCredentials;

  const clientOk = safeCompare(clientId, creds.clientId);
  const keyOk    = safeCompare(apiKey,   creds.apiKey);

  if (!clientOk || !keyOk) {
    res.status(403).json({
      success: false,
      message: "Forbidden: Invalid credentials.",
    });
    return;
  }

  next();
}
