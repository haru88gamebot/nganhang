import { Router, type Request, type Response } from "express";
import { readFileSync } from "fs";
import { join } from "path";
import { storage } from "../lib/storage";
import { gameServer, registerSSEGameClient, removeSSEGameClient } from "../lib/gameServer";

const router = Router();

const GAME_TYPE = "quaythu";
const QUAY_THU_HTML = readFileSync(join(import.meta.dirname, "../public/games/games/quay-thu.html"), "utf-8");

router.get("/games/quay-thu.html", (_req: Request, res: Response): void => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.send(QUAY_THU_HTML);
});

router.get("/games/quay-thu", (_req: Request, res: Response): void => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.send(QUAY_THU_HTML);
});

router.get("/games/quay-thu-stream", async (req: Request, res: Response): Promise<void> => {
  const tgId = req.query.tgid as string;
  if (!tgId) { res.status(400).json({ error: "tgid required" }); return; }

  const user = await storage.getBotUser(tgId);
  if (!user) { res.status(404).json({ error: "User not found" }); return; }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  const balance = parseFloat(user.balance);
  const name = user.firstName || user.username || `Player${tgId.slice(-4)}`;

  gameServer.joinRoomSSE(tgId, GAME_TYPE, name, balance);
  registerSSEGameClient(tgId, GAME_TYPE, res);

  res.write(`data: ${JSON.stringify({ type: "init", balance, name })}\n\n`);
  res.write(`data: ${JSON.stringify(gameServer.getSnapshot(GAME_TYPE))}\n\n`);

  const keepalive = setInterval(() => {
    try { res.write(": keepalive\n\n"); } catch { cleanup(); }
  }, 25000);

  function cleanup() {
    clearInterval(keepalive);
    removeSSEGameClient(tgId, GAME_TYPE);
    gameServer.removePlayer(tgId, GAME_TYPE);
  }

  req.on("close", cleanup);
});

router.get("/games/quay-thu-history", async (req: Request, res: Response): Promise<void> => {
  const tgid = String(req.query.tgid || "");
  if (!/^\d{5,15}$/.test(tgid)) {
    res.status(400).json({ success: false, message: "Invalid tgid" });
    return;
  }
  const sessions = await storage.getGameSessionsByUser(tgid, 50);
  const rows = sessions
    .filter((s) => s.gameType === GAME_TYPE)
    .map((s) => {
      const r = s.result as any;
      return {
        animal_name: s.betType || "",
        net: r?.netChange ?? 0,
        played_at: s.createdAt
          ? new Date(s.createdAt).toLocaleString("vi-VN")
          : "",
      };
    });
  res.json({ success: true, rows });
});

router.post("/games/quay-thu-bet", async (req: Request, res: Response): Promise<void> => {
  const { tgid, betType, amount } = req.body;
  if (!tgid || !betType || amount == null) {
    res.status(400).json({ success: false, message: "Missing params" });
    return;
  }
  if (!/^\d{5,15}$/.test(String(tgid))) {
    res.status(400).json({ success: false, message: "Invalid tgid" });
    return;
  }
  const amountNum = Number(amount);
  if (!Number.isFinite(amountNum) || amountNum <= 0) {
    res.status(400).json({ success: false, message: "Amount must be a positive number" });
    return;
  }
  const result = await gameServer.placeBet(String(tgid), GAME_TYPE, String(betType), amountNum);
  res.json(result);
});

export default router;
