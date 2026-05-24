import { Router } from "express";
import { storage } from "../lib/storage";
import { gameSession, type GameId } from "../telegram/gameSession";
import { webGameResolve } from "../lib/webGameLock";

const router = Router();

router.get("/game/balance", async (req, res) => {
  try {
    const tgid = req.query["tgid"] as string;
    if (!tgid) {
      res.status(400).json({ error: "tgid is required" });
      return;
    }
    const user = await storage.getBotUser(tgid);
    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }
    res.json({
      balance: user.balance,
      username: user.username,
      firstName: user.firstName,
      lastName: user.lastName,
    });
  } catch (err) {
    req.log.error({ err }, "game/balance error");
    res.status(500).json({ error: "Server error" });
  }
});

router.post("/game/update-balance", async (req, res) => {
  try {
    const { tgid, balance, delta, game, round } = req.body as {
      tgid: string;
      balance: number;
      delta: number;
      game: string;
      round?: number;
    };

    if (!tgid || balance === undefined || delta === undefined) {
      res.status(400).json({ error: "tgid, balance and delta are required" });
      return;
    }

    // Validate tgid is a numeric Telegram user ID
    if (!/^\d{5,15}$/.test(String(tgid))) {
      res.status(400).json({ error: "Invalid tgid" });
      return;
    }

    // Validate balance is a non-negative finite number
    const balanceNum = Number(balance);
    if (!Number.isFinite(balanceNum) || balanceNum < 0) {
      res.status(400).json({ error: "Invalid balance value" });
      return;
    }

    // Security: the game can only report losses (negative delta) or wins
    // but cannot inflate balance beyond current balance + a reasonable win multiplier
    const user = await storage.getBotUser(String(tgid));
    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    const currentBalance = parseFloat(user.balance || "0");
    const deltaNum = Number(delta);

    // Cap win: new balance cannot exceed current_balance + 100x bet (reasonable max multiplier)
    // This prevents exploiters from setting arbitrary large balances
    const maxAllowedBalance = currentBalance + Math.abs(deltaNum) * 100;
    const newBalance = Math.max(0, Math.min(balanceNum, maxAllowedBalance)).toFixed(2);
    await storage.updateBotUser(tgid, { balance: newBalance });

    // Notify user via Telegram with game result
    const balFmt = Math.floor(parseFloat(newBalance)).toLocaleString("vi-VN");
    if (delta > 0) {
      await webGameResolve(tgid,
        `🦀 <b>Bầu Cua — Thắng!</b>\n` +
        `💰 Nhận: <b>+${Math.floor(delta).toLocaleString("vi-VN")}đ</b>\n` +
        `💳 Số dư: ${balFmt}đ`
      );
    } else if (delta < 0) {
      await webGameResolve(tgid,
        `🦀 <b>Bầu Cua — Thua!</b>\n` +
        `📉 Mất: <b>${Math.floor(Math.abs(delta)).toLocaleString("vi-VN")}đ</b>\n` +
        `💳 Số dư: ${balFmt}đ`
      );
    }

    const totalBet = delta < 0 ? Math.abs(delta) : 0;
    if (totalBet > 0) {
      const now = new Date();
      const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
      const weekNum = Math.ceil(
        ((now.getTime() - new Date(now.getFullYear(), 0, 1).getTime()) / 86400000 + 1) / 7
      );
      const weekYearStr = `${now.getFullYear()}-W${String(weekNum).padStart(2, "0")}`;
      await storage.createOrUpdateBettingStats(tgid, dateStr, weekYearStr, totalBet);
    }

    res.json({ ok: true, balance: newBalance });
  } catch (err) {
    req.log.error({ err }, "game/update-balance error");
    res.status(500).json({ error: "Server error" });
  }
});

const VALID_GAMES: GameId[] = ["bau-cua", "xoc-dia", "quay-thu", "dua-xe"];

router.get("/game/state", (req, res) => {
  const game = req.query["game"] as string;
  if (!VALID_GAMES.includes(game as GameId)) {
    res.status(400).json({ error: "invalid game" });
    return;
  }
  res.json(gameSession.getState(game as GameId));
});

export default router;
