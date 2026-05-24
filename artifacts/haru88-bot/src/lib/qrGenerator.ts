import { Jimp } from "jimp";
import { readFileSync } from "fs";
import { join } from "path";
import { logger } from "./logger";

const LOGO_RATIO = 0.22;

/**
 * Fetches a clean QR-only image from VietQR and overlays the HARU88 logo
 * in the centre. No border, no frame — just logo on QR.
 */
export async function generateBankQR(
  bankCode: string,
  accountNumber: string,
  amount: number,
  addInfo: string,
  accountName: string,
): Promise<Buffer> {
  const url =
    `https://img.vietqr.io/image/${bankCode}-${accountNumber}-qr_only.png` +
    `?amount=${amount}` +
    `&addInfo=${encodeURIComponent(addInfo)}` +
    `&accountName=${encodeURIComponent(accountName)}`;

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`VietQR responded ${response.status}`);
  }
  const qrBuf = Buffer.from(await response.arrayBuffer());

  const qrImg = await Jimp.fromBuffer(qrBuf);
  const qrSize = qrImg.bitmap.width;

  const logoSize = Math.round(qrSize * LOGO_RATIO);
  const logoPath = join(__dirname, "..", "public", "haru88-logo.png");
  const logoRaw = readFileSync(logoPath);
  const logoImg = await Jimp.fromBuffer(logoRaw);
  logoImg.resize({ w: logoSize, h: logoSize });
  const lx = Math.round((qrSize - logoSize) / 2);
  const ly = Math.round((qrSize - logoSize) / 2);
  qrImg.composite(logoImg, lx, ly);

  logger.debug({ bankCode, accountNumber, amount }, "🖼️ QR with logo generated");
  return qrImg.getBuffer("image/png");
}
