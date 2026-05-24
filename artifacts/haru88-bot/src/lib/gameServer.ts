import { WebSocket, WebSocketServer } from "ws";
import { IncomingMessage } from "http";
import type { Response } from "express";
import { storage } from "./storage";
import { sendBotNotify, addPendingBet, reducePendingBet, getPendingBets, registerBalanceListener, broadcastBalance } from "./webGameLock";

// ─── Register SSE balance broadcast listener (called once at module load) ─────
// When any game calls broadcastBalance(tgId, balance), this listener pushes
// balance_update to all SSE game rooms (baucua, xocdia, quaythu, duaxe) for
// that user. crashGame registers its own listener separately.
registerBalanceListener((tgId: string, balance: number) => {
  const allGameTypes = ["baucua", "xocdia", "quaythu", "duaxe"];
  for (const gt of allGameTypes) {
    sendSSEToPlayer(tgId, gt, { type: "balance_update", balance });
  }
});

interface PlayerBet {
  betType: string;
  amount: number;
}

interface Player {
  ws: WebSocket | null;
  tgId: string;
  name: string;
  balance: number;
  bets: PlayerBet[];
  connected: boolean;
}

interface HistoryEntry {
  sessionId: number;
  result: any;
  timestamp: number;
}

interface GameRoom {
  id: string;
  gameType: string;
  state: "waiting" | "countdown" | "playing" | "result";
  players: Map<string, Player>;
  countdown: number;
  timer: ReturnType<typeof setInterval> | null;
  sessionId: number;
  result: any;
  history: HistoryEntry[];
}

const COUNTDOWN_SECONDS = 30;
const RESULT_DISPLAY_SECONDS = 8;

// ─── Game name & emoji maps ────────────────────────────────────────────────────

const GAME_DISPLAY: Record<string, string> = {
  baucua: "🦀 Bầu Cua",
  xocdia: "🎲 Xóc Đĩa",
  quaythu: "🎡 Quay Thưởng",
  duaxe: "🏎️ Đua Xe",
};

const BAU_CUA_EMOJI: Record<string, string> = {
  bau: "🎯", cua: "🦀", tom: "🦐", ca: "🐟", ga: "🐓", nai: "🦌",
};

function fmt(n: number) {
  return Math.round(n).toLocaleString("vi-VN") + "đ";
}

// ─── Global Pending Bets ──────────────────────────────────────────────────────
// Managed in webGameLock.ts (shared with crashGame.ts to prevent cross-game
// double-spending). Use addPendingBet / reducePendingBet / getPendingBets.

// ─── Debounced Bet Notifications ───────────────────────────────────────────────
//
// When a player places multiple bets quickly (different cửa), we collect them
// for 1.5s and send ONE grouped message instead of spamming.

interface PendingBetNotif {
  gameType: string;
  sessionId: number;
  bets: { betType: string; amount: number }[];
}

const betNotifTimers = new Map<string, ReturnType<typeof setTimeout>>();
const pendingBetNotifs = new Map<string, PendingBetNotif>();

function scheduleBetNotification(tgId: string, gameType: string, sessionId: number, betType: string, amount: number) {
  const existing = pendingBetNotifs.get(tgId);
  if (existing && existing.gameType === gameType) {
    const found = existing.bets.find((b) => b.betType === betType);
    if (found) {
      found.amount += amount;
    } else {
      existing.bets.push({ betType, amount });
    }
  } else {
    pendingBetNotifs.set(tgId, { gameType, sessionId, bets: [{ betType, amount }] });
  }

  if (betNotifTimers.has(tgId)) clearTimeout(betNotifTimers.get(tgId)!);
  betNotifTimers.set(tgId, setTimeout(async () => {
    betNotifTimers.delete(tgId);
    const notif = pendingBetNotifs.get(tgId);
    pendingBetNotifs.delete(tgId);
    if (!notif) return;

    const user = await storage.getBotUser(tgId).catch(() => null);
    const balance = parseFloat(user?.balance ?? "0");
    const pending = getPendingBets(tgId);
    const available = Math.max(0, balance - pending);

    const totalBet = notif.bets.reduce((s, b) => s + b.amount, 0);
    const gameName = GAME_DISPLAY[notif.gameType] || notif.gameType;

    const betLines = notif.bets
      .map((b) => {
        const emoji = BAU_CUA_EMOJI[b.betType] || "";
        return `  ${emoji ? emoji + " " : ""}${b.betType.toUpperCase()}: ${fmt(b.amount)}`;
      })
      .join("\n");

    const msg =
      `🎰 Đặt cược ${gameName} — Phiên #${notif.sessionId}\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `${betLines}\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `💵 Tổng đặt: ${fmt(totalBet)}\n` +
      `💰 Số dư khả dụng: ${fmt(available)}`;

    await sendBotNotify(tgId, msg);
  }, 1500));
}

// ─── Result Notifications ──────────────────────────────────────────────────────

async function sendBauCuaResult(
  tgId: string,
  sessionId: number,
  bets: PlayerBet[],
  outcomes: { won: boolean; winAmount: number; matches: number; netChange: number }[],
  dice: string[],
  totalNet: number,
  newBalance: number
) {
  const diceStr = dice.map((d) => BAU_CUA_EMOJI[d] || d).join(" ");
  const lines = bets.map((b, i) => {
    const o = outcomes[i];
    if (o.won) {
      return `  ${BAU_CUA_EMOJI[b.betType] || ""} ${b.betType.toUpperCase()} ×${o.matches} → +${fmt(o.winAmount - b.amount)} ✅`;
    } else {
      return `  ${BAU_CUA_EMOJI[b.betType] || ""} ${b.betType.toUpperCase()} × 0 → -${fmt(b.amount)} ❌`;
    }
  }).join("\n");

  const resultLine = totalNet > 0
    ? `🎉 Thắng: +${fmt(totalNet)}`
    : totalNet < 0
    ? `😢 Thua: -${fmt(Math.abs(totalNet))}`
    : `🤝 Hoà`;

  const msg =
    `${totalNet >= 0 ? "🏆" : "😢"} Bầu Cua — Phiên #${sessionId}\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `🎲 Kết quả: ${diceStr}\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `${lines}\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `${resultLine}\n` +
    `💰 Số dư: ${fmt(newBalance)}`;

  await sendBotNotify(tgId, msg);
}

async function sendXocDiaResult(
  tgId: string,
  sessionId: number,
  bets: PlayerBet[],
  outcomes: { won: boolean; winAmount: number; netChange: number }[],
  result: { dice: number[]; redCount: number },
  totalNet: number,
  newBalance: number
) {
  const diceStr = result.dice.map((d) => d === 1 ? "🔴" : "⚪").join(" ");
  const chanLe = result.redCount % 2 === 0 ? "Chẵn" : "Lẻ";

  const lines = bets.map((b, i) => {
    const o = outcomes[i];
    if (o.won) {
      return `  ✅ ${b.betType.toUpperCase()}: đặt ${fmt(b.amount)} → +${fmt(o.winAmount - b.amount)}`;
    } else {
      return `  ❌ ${b.betType.toUpperCase()}: đặt ${fmt(b.amount)} → -${fmt(b.amount)}`;
    }
  }).join("\n");

  const resultLine = totalNet > 0
    ? `🎉 Thắng: +${fmt(totalNet)}`
    : totalNet < 0
    ? `😢 Thua: -${fmt(Math.abs(totalNet))}`
    : `🤝 Hoà`;

  const msg =
    `${totalNet >= 0 ? "🏆" : "😢"} Xóc Đĩa — Phiên #${sessionId}\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `🎲 ${diceStr} → ${chanLe} (${result.redCount} đỏ)\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `${lines}\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `${resultLine}\n` +
    `💰 Số dư: ${fmt(newBalance)}`;

  await sendBotNotify(tgId, msg);
}

async function sendQuayThuResult(
  tgId: string,
  sessionId: number,
  bets: PlayerBet[],
  winner: string,
  multiplier: number,
  totalNet: number,
  winAmount: number,
  newBalance: number
) {
  const totalBet = bets.reduce((s, b) => s + b.amount, 0);
  const lines = bets.map((b) => {
    const isWinner = b.betType === winner;
    const isGroupWin = Object.values(QUAY_THU_GROUPS).some(
      (g) => g.members.includes(winner) && b.betType === Object.keys(QUAY_THU_GROUPS).find((k) => QUAY_THU_GROUPS[k] === g)
    );
    if (isWinner) {
      return `  ✅ ${b.betType} (×${multiplier}): đặt ${fmt(b.amount)} → +${fmt(b.amount * multiplier - b.amount)}`;
    } else if (isGroupWin) {
      return `  ✅ ${b.betType} (nhóm ×2): đặt ${fmt(b.amount)} → +${fmt(b.amount * 2 - b.amount)}`;
    } else {
      return `  ❌ ${b.betType}: đặt ${fmt(b.amount)} → -${fmt(b.amount)}`;
    }
  }).join("\n");

  const resultLine = totalNet > 0
    ? `🎉 Thắng: +${fmt(totalNet)}`
    : totalNet < 0
    ? `😢 Thua: -${fmt(Math.abs(totalNet))}`
    : `🤝 Hoà`;

  const msg =
    `${totalNet >= 0 ? "🏆" : "😢"} Quay Thưởng — Phiên #${sessionId}\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `🎡 Kết quả: ${winner}${multiplier > 0 ? ` (×${multiplier})` : " — Mất cược"}\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `${lines}\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `${resultLine}\n` +
    `💰 Số dư: ${fmt(newBalance)}`;

  await sendBotNotify(tgId, msg);
}

// ─── SSE Registry ────────────────────────────────────────────────────────────

const sseRegistry = new Map<string, Map<string, Response>>();

function sseRoomKey(gameType: string) {
  return `${gameType}_main`;
}

export function registerSSEGameClient(tgId: string, gameType: string, res: Response) {
  const key = sseRoomKey(gameType);
  if (!sseRegistry.has(key)) sseRegistry.set(key, new Map());
  sseRegistry.get(key)!.set(tgId, res);
}

export function removeSSEGameClient(tgId: string, gameType: string) {
  sseRegistry.get(sseRoomKey(gameType))?.delete(tgId);
}

export function sendSSEToPlayer(tgId: string, gameType: string, data: object) {
  const res = sseRegistry.get(sseRoomKey(gameType))?.get(tgId);
  if (res) {
    try { res.write(`data: ${JSON.stringify(data)}\n\n`); } catch {}
  }
}

function broadcastSSE(room: GameRoom, payload: string) {
  const rm = sseRegistry.get(room.id);
  if (!rm) return;
  for (const [tid, res] of rm) {
    try { res.write(`data: ${payload}\n\n`); } catch { rm.delete(tid); }
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function randInt(min: number, max: number) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function buildRoomPayload(room: GameRoom): string {
  const playerList = Array.from(room.players.values()).map((p) => ({
    tgId: p.tgId,
    name: p.name,
    bets: p.bets,
    connected: p.connected,
  }));
  const potByBet: Record<string, number> = {};
  for (const p of room.players.values()) {
    for (const b of p.bets) {
      potByBet[b.betType] = (potByBet[b.betType] || 0) + b.amount;
    }
  }
  return JSON.stringify({
    type: "state",
    roomId: room.id,
    gameType: room.gameType,
    state: room.state,
    countdown: room.countdown,
    players: playerList,
    pot: potByBet,
    result: room.result,
    sessionId: room.sessionId,
    history: room.history,
  });
}

function broadcastRoom(room: GameRoom) {
  const msg = buildRoomPayload(room);
  for (const p of room.players.values()) {
    if (p.ws && p.ws.readyState === WebSocket.OPEN) {
      p.ws.send(msg);
    }
  }
  broadcastSSE(room, msg);
}

function sendToPlayer(ws: WebSocket, data: object) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

// ─── Game Logic ───────────────────────────────────────────────────────────────

function runXocDia(): { dice: number[]; redCount: number } {
  const dice = [randInt(0, 1), randInt(0, 1), randInt(0, 1), randInt(0, 1)];
  const redCount = dice.filter((d) => d === 1).length;
  return { dice, redCount };
}

function resolveXocDia(
  bets: PlayerBet[],
  result: { dice: number[]; redCount: number }
): { won: boolean; winAmount: number; netChange: number }[] {
  const { redCount } = result;
  const isChan = redCount % 2 === 0;
  return bets.map((b) => {
    const betWins =
      (b.betType === "chan" && isChan) ||
      (b.betType === "le" && !isChan) ||
      (b.betType === "tu-do" && redCount === 4) ||
      (b.betType === "tu-trang" && redCount === 0) ||
      (b.betType === "ba-do" && redCount === 3) ||
      (b.betType === "ba-trang" && redCount === 1);

    let multiplier = 1.95;
    if (b.betType === "tu-do" || b.betType === "tu-trang") multiplier = 5.5;
    if (b.betType === "ba-do" || b.betType === "ba-trang") multiplier = 3.5;

    const winAmount = betWins ? Math.floor(b.amount * multiplier) : 0;
    return { won: betWins, winAmount, netChange: betWins ? winAmount - b.amount : -b.amount };
  });
}

const BAU_CUA_SYMBOLS = ["bau", "cua", "tom", "ca", "ga", "nai"];

function runBauCua(): { dice: string[] } {
  const dice = [
    BAU_CUA_SYMBOLS[randInt(0, 5)],
    BAU_CUA_SYMBOLS[randInt(0, 5)],
    BAU_CUA_SYMBOLS[randInt(0, 5)],
  ];
  return { dice };
}

function resolveBauCua(
  bets: PlayerBet[],
  result: { dice: string[] }
): { won: boolean; winAmount: number; matches: number; netChange: number }[] {
  return bets.map((b) => {
    const matches = result.dice.filter((d) => d === b.betType).length;
    const won = matches > 0;
    const winAmount = won ? b.amount * (1 + matches) : 0;
    return { won, winAmount, matches, netChange: won ? winAmount - b.amount : -b.amount };
  });
}

// ─── Quay Thú Animals ─────────────────────────────────────────────────────────

const QUAY_THU_ANIMALS = [
  { name: "Yến",        multiplier: 6,   weight: 14 },
  { name: "Bồ Câu",    multiplier: 8,   weight: 11 },
  { name: "Gấu Trúc",  multiplier: 8,   weight: 10 },
  { name: "Khỉ",       multiplier: 8,   weight: 10 },
  { name: "Thỏ",       multiplier: 6,   weight: 13 },
  { name: "Công",      multiplier: 8,   weight: 10 },
  { name: "Hổ",        multiplier: 12,  weight: 7  },
  { name: "Đại Bàng",  multiplier: 12,  weight: 6  },
  { name: "Cá Mập Xanh", multiplier: 24, weight: 4 },
  { name: "Cá Mập Vàng", multiplier: 100, weight: 2 },
  { name: "Rương",     multiplier: 0,   weight: 2  },
  { name: "Bom",       multiplier: 0,   weight: 11 },
];

const QUAY_THU_GROUPS: Record<string, { multiplier: number; members: string[] }> = {
  "Chim": { multiplier: 2, members: ["Yến", "Bồ Câu", "Công", "Đại Bàng"] },
  "Thú":  { multiplier: 2, members: ["Khỉ", "Gấu Trúc", "Thỏ", "Hổ"] },
};

function runQuayThu(): { winner: string; multiplier: number } {
  const total = QUAY_THU_ANIMALS.reduce((s, a) => s + a.weight, 0);
  let r = randInt(0, total - 1);
  for (const a of QUAY_THU_ANIMALS) {
    if (r < a.weight) return { winner: a.name, multiplier: a.multiplier };
    r -= a.weight;
  }
  return { winner: "Bom", multiplier: 0 };
}

function runDuaXe(): { winner: number; positions: number[] } {
  const lanes = [1, 2, 3, 4];
  const positions = lanes.map(() => randInt(1, 100));
  const maxPos = Math.max(...positions);
  const winner = positions.indexOf(maxPos) + 1;
  return { winner, positions };
}

// ─── Room Manager ─────────────────────────────────────────────────────────────

class GameServer {
  private rooms: Map<string, GameRoom> = new Map();

  getRoomId(gameType: string): string {
    return `${gameType}_main`;
  }

  getOrCreateRoom(gameType: string): GameRoom {
    const roomId = this.getRoomId(gameType);
    if (!this.rooms.has(roomId)) {
      const room: GameRoom = {
        id: roomId,
        gameType,
        state: "countdown",
        players: new Map(),
        countdown: COUNTDOWN_SECONDS,
        timer: null,
        sessionId: 1,
        result: null,
        history: [],
      };
      this.rooms.set(roomId, room);
      // Khởi động phiên đầu tiên ngay khi phòng được tạo
      setImmediate(() => this.startCountdown(room));
    }
    return this.rooms.get(roomId)!;
  }

  joinRoom(ws: WebSocket, tgId: string, gameType: string, name: string, balance: number): GameRoom {
    const room = this.getOrCreateRoom(gameType);

    if (room.players.has(tgId)) {
      const existing = room.players.get(tgId)!;
      existing.ws = ws;
      existing.balance = balance;
      existing.connected = true;
      if (room.state === "waiting") {
        existing.bets = [];
      }
    } else {
      room.players.set(tgId, {
        ws,
        tgId,
        name,
        balance,
        bets: [],
        connected: true,
      });
    }

    broadcastRoom(room);
    return room;
  }

  joinRoomSSE(tgId: string, gameType: string, name: string, balance: number): void {
    const room = this.getOrCreateRoom(gameType);
    if (!room.players.has(tgId)) {
      room.players.set(tgId, {
        ws: null,
        tgId,
        name,
        balance,
        bets: [],
        connected: true,
      });
    } else {
      const p = room.players.get(tgId)!;
      p.balance = balance;
      p.connected = true;
      if (room.state === "waiting") p.bets = [];
    }
  }

  getSnapshot(gameType: string): object {
    const room = this.getOrCreateRoom(gameType);
    const pot: Record<string, number> = {};
    for (const p of room.players.values()) {
      for (const b of p.bets) pot[b.betType] = (pot[b.betType] || 0) + b.amount;
    }
    return {
      type: "state",
      roomId: room.id,
      gameType: room.gameType,
      state: room.state,
      countdown: room.countdown,
      pot,
      result: room.result,
      sessionId: room.sessionId,
      history: room.history,
    };
  }

  async placeBet(tgId: string, gameType: string, betType: string, amount: number): Promise<{ success: boolean; message: string }> {
    const room = this.getOrCreateRoom(gameType);

    if (room.state === "playing" || room.state === "result") {
      return { success: false, message: "Phiên đang chạy, vui lòng chờ phiên mới!" };
    }

    // ── RACE CONDITION FIX: Reserve pending bet FIRST (synchronous), THEN check balance ──
    // This prevents multiple simultaneous requests from all passing the balance check
    // before any of them has called addPendingBet.
    addPendingBet(tgId, amount);

    const user = await storage.getBotUser(tgId);
    if (!user) {
      reducePendingBet(tgId, amount);
      return { success: false, message: "Không tìm thấy tài khoản!" };
    }

    const currentBalance = parseFloat(user.balance);
    const totalPending = getPendingBets(tgId); // includes our reservation
    const availableBalance = currentBalance - totalPending + amount; // available BEFORE this bet

    if (availableBalance < amount) {
      // Rollback reservation — not enough balance
      reducePendingBet(tgId, amount);
      const otherPending = totalPending - amount;
      const pendingMsg = otherPending > 0
        ? ` (đang chờ ${fmt(otherPending)} ở các game khác)`
        : "";
      return {
        success: false,
        message: `Số dư không đủ! Khả dụng: ${fmt(Math.max(0, availableBalance))}${pendingMsg}`,
      };
    }

    let player = room.players.get(tgId);

    // Auto-rejoin if player was removed due to SSE disconnect timeout
    if (!player) {
      const name = user.firstName || user.username || `Player${tgId.slice(-4)}`;
      this.joinRoomSSE(tgId, gameType, name, currentBalance);
      player = room.players.get(tgId);
    }

    if (!player) {
      reducePendingBet(tgId, amount);
      return { success: false, message: "Bạn chưa tham gia phòng!" };
    }

    // Add to room bets
    const existingBet = player.bets.find((b) => b.betType === betType);
    if (existingBet) {
      existingBet.amount += amount;
    } else {
      player.bets.push({ betType, amount });
    }
    player.balance = currentBalance;

    broadcastRoom(room);

    // ── Immediately push provisional balance to ALL open game tabs ──
    // availableBalance = DB balance - totalPending (including this new bet)
    const provisionalBalance = Math.max(0, currentBalance - getPendingBets(tgId));
    broadcastBalance(tgId, provisionalBalance);

    // Schedule a debounced Telegram notification (groups rapid multi-door bets)
    scheduleBetNotification(tgId, gameType, room.sessionId, betType, amount);

    return { success: true, message: `Đặt cược ${betType} ${amount.toLocaleString("vi-VN")}đ thành công!` };
  }

  private startCountdown(room: GameRoom) {
    if (room.timer) clearInterval(room.timer);

    room.timer = setInterval(async () => {
      room.countdown--;
      broadcastRoom(room);

      if (room.countdown <= 0) {
        clearInterval(room.timer!);
        room.timer = null;
        await this.runGame(room);
      }
    }, 1000);
  }

  private async sendBalanceUpdate(tgId: string, ws: WebSocket | null, gameType: string) {
    try {
      const user = await storage.getBotUser(tgId);
      if (user) {
        const balance = parseFloat(user.balance);
        if (ws && ws.readyState === WebSocket.OPEN) {
          sendToPlayer(ws, { type: "balance_update", balance });
        }
        // Broadcast to ALL web game clients (SSE games + crash) via shared listener
        broadcastBalance(tgId, balance);
      }
    } catch {
      // ignore
    }
  }

  private async runGame(room: GameRoom) {
    room.state = "playing";
    broadcastRoom(room);

    let gameResult: any;

    switch (room.gameType) {
      case "xocdia": {
        const result = runXocDia();
        const playerResults: any[] = [];

        for (const [tgId, player] of room.players) {
          if (player.bets.length === 0) continue;
          const outcomes = resolveXocDia(player.bets, result);
          let totalNet = 0;
          for (let i = 0; i < player.bets.length; i++) {
            totalNet += outcomes[i].netChange;
          }
          const totalWin = outcomes.reduce((s, o) => s + o.winAmount, 0);

          const newBalance = await this.processPlayerResult(tgId, player.bets, totalNet, totalWin, room.gameType);
          playerResults.push({ tgId, outcomes, totalNet });
          await this.sendBalanceUpdate(tgId, player.ws, room.gameType);

          // Telegram result notification
          sendXocDiaResult(tgId, room.sessionId, player.bets, outcomes, result, totalNet, newBalance).catch(() => {});
        }

        gameResult = {
          dice: result.dice,
          redCount: result.redCount,
          isChan: result.redCount % 2 === 0,
          playerResults,
        };
        break;
      }

      case "baucua": {
        const result = runBauCua();
        const playerResults: any[] = [];

        for (const [tgId, player] of room.players) {
          if (player.bets.length === 0) continue;
          const outcomes = resolveBauCua(player.bets, result);
          let totalNet = 0;
          let totalWin = 0;
          for (const o of outcomes) {
            totalNet += o.netChange;
            totalWin += o.winAmount;
          }

          const newBalance = await this.processPlayerResult(tgId, player.bets, totalNet, totalWin, room.gameType);
          playerResults.push({ tgId, outcomes, totalNet });
          await this.sendBalanceUpdate(tgId, player.ws, room.gameType);

          // Telegram result notification
          sendBauCuaResult(tgId, room.sessionId, player.bets, outcomes, result.dice, totalNet, newBalance).catch(() => {});
        }

        gameResult = { dice: result.dice, playerResults };
        break;
      }

      case "quaythu": {
        const spinResult = runQuayThu();
        const playerResults: any[] = [];

        for (const [tgId, player] of room.players) {
          if (player.bets.length === 0) continue;
          const totalBet = player.bets.reduce((s, b) => s + b.amount, 0);
          let winAmount = 0;

          if (spinResult.multiplier > 0) {
            const animalBet = player.bets.find((b) => b.betType === spinResult.winner);
            if (animalBet) winAmount += Math.floor(animalBet.amount * spinResult.multiplier);

            for (const [grpName, grp] of Object.entries(QUAY_THU_GROUPS)) {
              if (grp.members.includes(spinResult.winner)) {
                const grpBet = player.bets.find((b) => b.betType === grpName);
                if (grpBet) winAmount += Math.floor(grpBet.amount * grp.multiplier);
              }
            }
          }

          const net = winAmount - totalBet;
          const newBalance = await this.processPlayerResult(tgId, player.bets, net, winAmount, room.gameType);
          playerResults.push({ tgId, winner: spinResult.winner, multiplier: spinResult.multiplier, winAmount, net });
          await this.sendBalanceUpdate(tgId, player.ws, room.gameType);

          // Telegram result notification
          sendQuayThuResult(tgId, room.sessionId, player.bets, spinResult.winner, spinResult.multiplier, net, winAmount, newBalance).catch(() => {});
        }

        gameResult = { winner: spinResult.winner, multiplier: spinResult.multiplier, playerResults };
        break;
      }

      case "duaxe": {
        const result = runDuaXe();
        const playerResults: any[] = [];

        for (const [tgId, player] of room.players) {
          if (player.bets.length === 0) continue;
          const winningBets = player.bets.filter((b) => b.betType === `lane_${result.winner}`);
          const totalBet = player.bets.reduce((s, b) => s + b.amount, 0);
          const winAmount = winningBets.reduce((s, b) => s + Math.floor(b.amount * 3.5), 0);
          const net = winAmount - totalBet;
          await this.processPlayerResult(tgId, player.bets, net, winAmount, room.gameType);
          playerResults.push({ tgId, net, winAmount });
          await this.sendBalanceUpdate(tgId, player.ws, room.gameType);
        }

        gameResult = { winner: result.winner, positions: result.positions, playerResults };
        break;
      }
    }

    room.result = gameResult;
    room.state = "result";

    room.history.unshift({ sessionId: room.sessionId, result: gameResult, timestamp: Date.now() });
    if (room.history.length > 12) room.history.length = 12;

    broadcastRoom(room);

    setTimeout(async () => {
      room.result = null;
      for (const p of room.players.values()) {
        p.bets = [];
      }

      // Update balances before starting new round
      for (const [tgId, player] of room.players) {
        if (player.connected) {
          await this.sendBalanceUpdate(tgId, player.ws, room.gameType);
        }
      }

      // Auto-restart round immediately (không về waiting — nhiều người có thể chơi cùng)
      room.state = "countdown";
      room.countdown = COUNTDOWN_SECONDS;
      room.sessionId++;
      broadcastRoom(room);
      this.startCountdown(room);
    }, RESULT_DISPLAY_SECONDS * 1000);
  }

  /**
   * Process game result for one player:
   * - Updates DB balance (deducts bet, credits winnings)
   * - Releases global pending bets
   * - Records game session & betting stats
   * Returns the new balance.
   */
  private async processPlayerResult(
    tgId: string,
    bets: PlayerBet[],
    netChange: number,
    winAmount: number,
    gameType: string
  ): Promise<number> {
    try {
      const user = await storage.getBotUser(tgId);
      if (!user) return 0;

      const totalBet = bets.reduce((s, b) => s + b.amount, 0);
      const currentBalance = parseFloat(user.balance);

      const newBalanceNum = Math.max(0, currentBalance - totalBet + winAmount);
      const newBalance = newBalanceNum.toFixed(2);
      await storage.updateBotUser(tgId, { balance: newBalance });

      // ── KEY FIX: Release global pending bets for this game ──
      // Must happen after DB update so balance is consistent
      reducePendingBet(tgId, totalBet);

      const now = new Date();
      const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
      const weekNum = Math.ceil(
        ((now.getTime() - new Date(now.getFullYear(), 0, 1).getTime()) / 86400000 + 1) / 7
      );
      const weekYearStr = `${now.getFullYear()}-W${String(weekNum).padStart(2, "0")}`;
      await storage.createOrUpdateBettingStats(tgId, dateStr, weekYearStr, totalBet);
      await storage.trackBet(tgId, totalBet); // Cập nhật totalWagered + VIP level

      await storage.createGameSession({
        userId: tgId,
        gameType,
        betType: bets.map((b) => b.betType).join(","),
        betAmount: totalBet.toString(),
        winAmount: winAmount.toString(),
        won: netChange > 0,
        status: "completed",
        result: { netChange, bets },
        metadata: { source: "web" },
      });

      return newBalanceNum;
    } catch (err) {
      console.error("Error processing web game result:", err);
      return 0;
    }
  }

  removePlayer(tgId: string, gameType: string) {
    const room = this.getOrCreateRoom(gameType);
    const player = room.players.get(tgId);
    if (player) {
      player.connected = false;
      setTimeout(() => {
        const p = room.players.get(tgId);
        if (p && !p.connected) {
          room.players.delete(tgId);
          broadcastRoom(room);
        }
      }, 10000);
    }
  }
}

export const gameServer = new GameServer();

// ─── WebSocket Handler ────────────────────────────────────────────────────────

export function setupGameWebSocket(wss: WebSocketServer) {
  wss.on("connection", async (ws: WebSocket, req: IncomingMessage) => {
    let tgId: string | null = null;
    let gameType: string | null = null;

    ws.on("message", async (raw) => {
      try {
        const msg = JSON.parse(raw.toString());

        if (msg.type === "join") {
          tgId = String(msg.tgId);
          gameType = String(msg.gameType);

          const user = await storage.getBotUser(tgId);
          const name = user?.firstName || user?.username || `Player${tgId.slice(-4)}`;
          const balance = parseFloat(user?.balance ?? "0");

          gameServer.joinRoom(ws, tgId, gameType, name, balance);

          sendToPlayer(ws, { type: "user_info", name, balance, tgId });
        } else if (msg.type === "bet") {
          if (!tgId || !gameType) {
            sendToPlayer(ws, { type: "error", message: "Chưa tham gia phòng!" });
            return;
          }
          const amount = parseInt(String(msg.amount));
          if (!amount || amount < 1000) {
            sendToPlayer(ws, { type: "error", message: "Số tiền tối thiểu 1,000đ!" });
            return;
          }
          const result = await gameServer.placeBet(tgId, gameType, String(msg.betType), amount);
          sendToPlayer(ws, { type: "bet_result", ...result });

          if (result.success) {
            const user = await storage.getBotUser(tgId);
            sendToPlayer(ws, { type: "balance_update", balance: parseFloat(user?.balance ?? "0") });
          }
        } else if (msg.type === "ping") {
          sendToPlayer(ws, { type: "pong" });
        }
      } catch (err) {
        console.error("Game WS error:", err);
        sendToPlayer(ws, { type: "error", message: "Lỗi server!" });
      }
    });

    ws.on("close", () => {
      if (tgId && gameType) gameServer.removePlayer(tgId, gameType);
    });

    ws.on("error", () => {
      if (tgId && gameType) gameServer.removePlayer(tgId, gameType);
    });
  });
}
