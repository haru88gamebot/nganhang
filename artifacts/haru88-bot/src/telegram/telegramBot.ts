import TelegramBot from "node-telegram-bot-api";
import { storage, MonetaryUtils } from "../lib/storage";
import { db, rewardsTable, transactionsTable } from "@workspace/db";
import { eq, and, sql } from "drizzle-orm";
import { bot2Manager } from "./bot2Manager";
import { logger } from "../lib/logger";
import type { BotSettings, InsertBotUser, InsertTransaction, InsertGameSession } from "@workspace/db";
import { WebSocketServer } from "ws";
import crypto from "crypto";
import { createBankPayout, isPayOSConfigured } from "./payosService";
import { submitCard68, isShopCard68Configured, TELCO_LABELS, CARD_AMOUNTS, pollCard68Result, type SC68Telco } from "./shopcard68";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { getSetting, getSettingNumber } from "../lib/settings";
import { getWebGameSession } from "../lib/webGameLock";

// Works on both Replit (dev) and Render/Docker (prod)
// import.meta.url → dist/index.mjs → up one level = artifacts/api-server/public/
const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');

// Đọc phí chiết khấu theo loại thẻ từ DB settings (mặc định 0 nếu chưa set)
async function getCardFeePercent(telco: SC68Telco): Promise<number> {
  const keyMap: Record<SC68Telco, string> = {
    viettel: "card_fee_viettel",
    mobi:    "card_fee_mobi",
    vina:    "card_fee_vina",
    zing:    "card_fee_zing",
  };
  const val = await getSetting(keyMap[telco]);
  const fee = parseFloat(val ?? "0");
  return isNaN(fee) || fee < 0 ? 0 : Math.min(fee, 100);
}

interface GameSession {
  userId: string;
  gameType: string;
  betType?: string;
  amount?: number;
  status: "betting" | "playing" | "completed" | "waiting_amount" | "waiting_for_emoji" | "waiting_player_roll" | "waiting_trenduoi_continue";
  timestamp: number;
  md5Hash?: string;
  originalCode?: string;
  currentRound?: number;
  totalWinnings?: number;
  lastDice1?: number;
  lastDice2?: number;
  isActive?: boolean;
  originalBet?: number;
  emojiType?: string;
  throwMode?: "bot" | "player";
  pendingGameSessionId?: number;
  pendingBetAmount?: number;
  pendingNewBalance?: string;
}

interface GameMultipliers {
  [key: string]: number;
}

interface GameResult {
  won: boolean | null; // null for ties
  result: any;
  resultText: string;
  winAmount?: number;
  payoutMultiplier?: number;
}

interface QueuedMessage {
  id: string;
  chatId: number;
  type: 'message' | 'photo';
  content: string;
  options?: any;
  priority: 'high' | 'normal' | 'low';
  retries: number;
  timestamp: number;
}

interface LodeBet {
  userId: string;
  chatId: number;
  type: 'lo' | 'de';
  number: string;   // 2-digit string "00"-"99"
  diem: number;     // Số điểm cược (1 điểm = 27,000đ)
  amount: number;   // VND tương đương (diem × 27000)
  timestamp: number;
  date: string;     // "DD-MM-YYYY" to match result date
  txId?: number;    // transactionsTable.id — dùng để cập nhật trạng thái sau kết quả
}

const DIEM_TO_VND = 27000; // 1 điểm = 27,000đ

interface XSMBResult {
  specialPrize: string;   // Giải đặc biệt (5 chữ số)
  allNumbers: string[];   // Tất cả số trong tất cả giải (2 chữ số cuối)
  rawPrizes: { name: string; values: string[] }[];
  date: string;
}

class TelegramBotService {
  private bot: TelegramBot | null = null;
  private botUsername: string = '';
  private gameSessions: Map<string, GameSession> = new Map();
  private websocketServer: WebSocketServer | undefined = undefined;
  private customAmountWaiting: Set<string> = new Set();
  private recentInteractions: Set<string> = new Set(); // Debouncing for button clicks
  private paymentMethods: Map<string, string> = new Map(); // userId -> paymentMethod
  private firstDepositBonusActive: Set<string> = new Set(); // Track users who came from first deposit bonus event
  private soloDiceRooms: Map<string, any> = new Map(); // Solo dice room system (code → room)
  private playerDiceCollector: Map<string, number[]> = new Map(); // userId → collected dice values
  private lodeBets: LodeBet[] = [];             // Pending lô đề bets
  private lodeResultProcessed: string = '';     // Track processed date "DD-MM-YYYY"
  private cardSessions: Map<string, { step: "select_telco" | "select_amount" | "enter_card"; telco?: SC68Telco; amount?: number; chatId: number }> = new Map();
  
  // Message queue system for optimization (safe and optimized)
  private messageQueue: QueuedMessage[] = [];
  private isProcessingQueue: boolean = false;
  private messageRateLimit: number = 25; // messages per second limit (Telegram safe limit)
  private lastMessageTime: number = 0;
  private lastChatMessages: Map<number, number> = new Map(); // Per-chat rate limiting
  private messageCache: Map<string, number> = new Map(); // Cache for duplicate message prevention
  private recentCommandsCache: Map<string, number> = new Map(); // Cache for command debouncing
  
  // Duplicate message prevention - stores last message ID for each user
  private lastMessageIds: Map<string, number> = new Map(); // userId -> messageId

  // ─── TX Streak Tracking ───────────────────────────────────────────────────
  private txStreaks: Map<string, { wins: number; losses: number; name: string }> = new Map();

  // ─── Anti-Spam System ────────────────────────────────────────────────────
  // Track how many messages each user sent in the current window
  private spamCounter: Map<string, { count: number; windowStart: number }> = new Map();
  // Users who are temporarily blocked from using the bot
  private spamBlocked: Map<string, number> = new Map(); // userId -> unblockTime (ms)
  // Progressive offense counter: 1→1min, 2→5min, 3→15min, 4+→30min
  private spamOffenses: Map<string, number> = new Map(); // userId -> offense count
  private readonly SPAM_WINDOW_MS = 5000;   // 5-second rolling window
  private readonly SPAM_MAX_MSGS  = 5;      // max messages per window before warn
  
  private readonly gameMultipliers: GameMultipliers = {
    taixiu: 1.95,
    taixiu_md5: 1.95,
    chanle: 1.95,
    xucxac: 1.93,
    phitieu: 1.8,
    quaythuong: 2.5,
  };

  // ========== BOT2 INTEGRATION METHODS ==========
  
  /**
   * Gửi cược từ bot chính đến bot2 (ẩn danh) - with atomic balance validation
   */
  async sendBetToBot2(userId: string, betType: string, amount: number): Promise<boolean> {
    console.log(`🔄 Starting bet transaction: User ${userId}, Type: ${betType}, Amount: ${amount}`);
    
    // Get user data and validate balance BEFORE any modifications
    const userData = await storage.getBotUser(userId);
    if (!userData) {
      console.error(`❌ User not found: ${userId}`);
      await this.sendMessage(userId, "❌ Không tìm thấy thông tin tài khoản. Vui lòng dùng /start để đăng ký.");
      return false;
    }
    
    const originalBalance = parseFloat(userData.balance || "0");
    console.log(`💰 Original balance for user ${userId}: ${originalBalance}`);
    
    if (originalBalance < amount) {
      console.log(`❌ Insufficient balance: User ${userId}, Required: ${amount}, Available: ${originalBalance}`);
      await this.sendMessage(userId, 
        `❌ SỐ DƯ KHÔNG ĐỦ!\n\n` +
        `💎 Số dư hiện tại: ${originalBalance.toLocaleString('vi-VN')}đ\n` +
        `💰 Số tiền cần: ${amount.toLocaleString('vi-VN')}đ\n` +
        `⚠️ Thiếu: ${(amount - originalBalance).toLocaleString('vi-VN')}đ`
      );
      return false;
    }
    
    // Start atomic operation - either everything succeeds or balance is restored
    let balanceDeducted = false;
    
    try {
      // Step 1: Deduct balance
      const newBalance = (originalBalance - amount).toFixed(2);
      await storage.updateBotUser(userId, { balance: newBalance });
      balanceDeducted = true;
      console.log(`✅ Balance deducted: User ${userId}, New balance: ${newBalance}`);
      
      // Step 2: Import bot2 service (can throw)
      console.log(`🔄 Importing telegramBot2Service for user ${userId}`);
      const { telegramBot2Service } = await import('./telegramBot2');
      
      // Step 3: Send bet to bot2 (can throw or return false)
      console.log(`🎯 Sending bet to Bot2: User ${userId}, Type: ${betType}, Amount: ${amount}`);
      const success = await telegramBot2Service.receiveBetFromMainBot(userId, betType, amount);
      
      if (!success) {
        // Bot2 explicitly rejected the bet - restore balance
        console.warn(`⚠️ Bot2 rejected bet: User ${userId}, restoring balance to ${originalBalance}`);
        await storage.updateBotUser(userId, { balance: originalBalance.toFixed(2) });
        await this.sendMessage(userId, "❌ Không thể đặt cược lúc này. Số dư đã được hoàn lại.");
        return false;
      }
      
      // Track bet for wagering requirements
      await storage.trackBet(userId, amount);
      
      // Track betting stats for rankings
      try {
        const now = this.nowVN();
        const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
        const weekNumber = this.getWeekNumber(now);
        const weekYearStr = `${now.getFullYear()}-W${String(weekNumber).padStart(2, '0')}`;
        await storage.createOrUpdateBettingStats(userId, dateStr, weekYearStr, amount);
        console.log(`📊 Tracking bet: ${userId}, ${amount}, ${dateStr}`);
      } catch (error) {
        console.error('Error tracking betting stats:', error);
        // Don't throw - continue with bet even if stats tracking fails
      }
      
      console.log(`✅ Bet successfully sent to Bot2: User ${userId}, Type: ${betType}, Amount: ${amount}`);
      return true;
      
    } catch (error) {
      // ANY error after balance deduction requires balance restoration
      console.error(`💥 Error in sendBetToBot2 for user ${userId}:`, error);
      console.error(`Stack trace:`, error instanceof Error ? error.stack : 'No stack trace available');
      
      if (balanceDeducted) {
        console.log(`🔄 Restoring balance for user ${userId} from ${originalBalance - amount} back to ${originalBalance}`);
        try {
          await storage.updateBotUser(userId, { balance: originalBalance.toFixed(2) });
          console.log(`✅ Balance restored for user ${userId}: ${originalBalance}`);
          await this.sendMessage(userId, "❌ Có lỗi xảy ra khi đặt cược. Số dư đã được hoàn lại.");
        } catch (restoreError) {
          console.error(`💥 CRITICAL: Failed to restore balance for user ${userId}:`, restoreError);
          console.error(`💥 CRITICAL: User ${userId} may have lost ${amount} due to balance restore failure`);
          // This is a critical error - the user's balance could not be restored
          await this.sendMessage(userId, "🚨 LỖI NGHIÊM TRỌNG: Không thể hoàn lại số dư. Vui lòng liên hệ admin ngay lập tức!");
        }
      }
      
      return false;
    }
  }

  /**
   * Nhận thông báo cược từ bot2
   */
  async receiveBetFromBot2(userId: string, betType: string, amount: number, sessionId: number): Promise<void> {
    try {
      // Create transaction record for tracking
      await storage.createTransaction({
        userId,
        type: "bet",
        amount: amount.toString(),
        status: "completed",
        method: "taixiu_room",
        metadata: { 
          betType, 
          sessionId: sessionId.toString(),
          source: "bot2"
        }
      });
      
      console.log(`📥 Received bet notification from Bot2: User ${userId}, Session #${sessionId}`);
    } catch (error) {
      console.error('❌ Error processing bet notification from Bot2:', error);
    }
  }

  /**
   * Nhận kết quả từ bot2 để xử lý thắng/thua
   */
  async receiveResultFromBot2(sessionId: number, _results: any, winners: Array<{userId: string, betType: string, amount: number, winAmount: number}>, losers: Array<{userId: string, betType: string, amount: number}>): Promise<void> {
    // NOTE: Balances are already updated by Bot2 directly.
    // This method only records transactions and sends private chat notifications.

    // Update TX streaks for TX room bets >= 10,000đ
    // A user wins if they have ANY winning bet >= 10k; loses only if ALL their bets >= 10k are losses
    const winnerIds = new Set(winners.filter(w => w.amount >= 10000).map(w => w.userId));
    const loserIds  = new Set(losers.filter(l => l.amount >= 10000).map(l => l.userId));

    const resolveStreakName = async (uid: string): Promise<string> => {
      const existing = this.txStreaks.get(uid);
      if (existing && existing.name && existing.name !== uid) return existing.name;
      try {
        const userData = await storage.getBotUser(uid);
        if (userData) return userData.firstName || userData.username || uid;
      } catch { /* non-critical */ }
      return uid;
    };

    for (const uid of winnerIds) {
      const s = this.txStreaks.get(uid) || { wins: 0, losses: 0, name: uid };
      s.name = await resolveStreakName(uid);
      s.wins++;
      s.losses = 0;
      this.txStreaks.set(uid, s);
    }
    for (const uid of loserIds) {
      if (!winnerIds.has(uid)) {
        const s = this.txStreaks.get(uid) || { wins: 0, losses: 0, name: uid };
        s.name = await resolveStreakName(uid);
        s.losses++;
        s.wins = 0;
        this.txStreaks.set(uid, s);
      }
    }

    try {
      for (const winner of winners) {
        // Record win transaction
        try {
          await storage.createTransaction({
            userId: winner.userId,
            type: "win",
            amount: winner.winAmount.toString(),
            status: "completed",
            method: "taixiu_room",
            metadata: {
              sessionId: sessionId.toString(),
              betType: winner.betType,
              betAmount: winner.amount.toString(),
              source: "bot2"
            }
          });
        } catch { /* ignore transaction errors */ }

        // Read current balance (already updated by bot2) and sync cache
        const userData = await storage.getBotUser(winner.userId);
        const newBalance = userData?.balance ?? "0";
        await this.syncBalanceWithBot2(winner.userId, newBalance);

        // Private notification
        if (this.bot) {
          try {
            await this.bot.sendMessage(
              parseInt(winner.userId),
              `🎉 <b>CHIẾN THẮNG!</b> Phiên #${sessionId}\n` +
              `🎯 Cược: ${this.getBetTypeDisplay(winner.betType)} <b>${winner.amount.toLocaleString("vi-VN")}đ</b>\n` +
              `💰 Thắng: <b>+${winner.winAmount.toLocaleString("vi-VN")}đ</b>\n` +
              `💎 Số dư: <b>${parseFloat(newBalance).toLocaleString("vi-VN")}đ</b>`,
              { parse_mode: "HTML" }
            );
          } catch { /* user may have blocked bot */ }
        }
      }

      for (const loser of losers) {
        // Read current balance and sync cache
        const userData = await storage.getBotUser(loser.userId);
        const currentBalance = userData?.balance ?? "0";
        await this.syncBalanceWithBot2(loser.userId, currentBalance);

        if (this.bot) {
          try {
            await this.bot.sendMessage(
              parseInt(loser.userId),
              `😢 <b>Chưa may mắn!</b> Phiên #${sessionId}\n` +
              `🎯 Cược: ${this.getBetTypeDisplay(loser.betType)} <b>${loser.amount.toLocaleString("vi-VN")}đ</b>\n` +
              `💔 Mất: <b>-${loser.amount.toLocaleString("vi-VN")}đ</b>\n` +
              `💰 Số dư: <b>${parseFloat(currentBalance).toLocaleString("vi-VN")}đ</b>`,
              { parse_mode: "HTML" }
            );
          } catch { /* user may have blocked bot */ }
        }
      }
    } catch (error) {
      logger.error({ error }, "Error processing results from Bot2");
    }
  }

  /**
   * Get bet type display name for notifications
   */
  private getBetTypeDisplay(betType: string): string {
    switch (betType) {
      case 'T': return '🔵 TÀI';
      case 'X': return '🔴 XỈU';
      case 'TC': return '🔵⚪️ TÀI CHẴN (12,14,16,18)';
      case 'TL': return '🔵⚫️ TÀI LẺ (11,13,15,17)';
      case 'XC': return '🔴⚪️ XỈU CHẴN (4,6,8,10)';
      case 'XL': return '🔴⚫️ XỈU LẺ (3,5,7,9)';
      case 'C': return '⚪️ CHẴN';
      case 'L': return '⚫️ LẺ';
      case 'MC': return '🔵 MD5 CHẴN';
      case 'ML': return '🔴 MD5 LẺ';
      default:
        if (betType.startsWith('ddt_')) {
          const targetTotal = betType.split('_')[1];
          return `🎯 DỰ ĐOÁN TỔNG ${targetTotal}`;
        } else if (betType.startsWith('ddxx_')) {
          const targetNumber = betType.split('_')[1];
          return `🎲 DỰ ĐOÁN SỐ ${targetNumber}`;
        }
        return betType;
    }
  }

  // ========== BALANCE SYNCHRONIZATION METHODS ==========
  
  /**
   * Thông báo bot2 khi số dư thay đổi (từ bot chính)
   */
  async syncBalanceWithBot2(userId: string, newBalance: string): Promise<void> {
    try {
      const { telegramBot2Service } = await import('./telegramBot2');
      await (telegramBot2Service as any).syncBalanceFromMainBot?.(userId, newBalance);
    } catch (error) {
      // Non-critical: don't break main operation
    }
  }

  /**
   * Nhận thông báo đồng bộ từ bot2 khi số dư thay đổi
   */
  async receiveSyncFromBot2(userId: string, newBalance: string): Promise<void> {
    try {
      // Update internal cache/state if any (currently we don't cache balance)
      // The database is already updated by bot2, so we just log this
      console.log(`📥 Received balance sync from Bot2: User ${userId}, New Balance: ${newBalance}`);
      
      // Optional: Notify user if they're currently interacting with main bot
      // We can add more sophisticated notification logic here if needed
    } catch (error) {
      console.error('❌ Error receiving sync from Bot2:', error);
    }
  }

  // ========== END BALANCE SYNCHRONIZATION METHODS ==========
  
  // ========== END BOT2 INTEGRATION METHODS ==========

  /**
   * Helper method to send or edit a message with inline keyboard
   */
  private async sendOrEditMessage(
    chatId: number,
    text: string,
    keyboard: any,
    parseMode: "HTML" | "Markdown" = "HTML",
    messageId?: number
  ): Promise<void> {
    if (!this.bot) return;

    if (messageId) {
      try {
        await this.bot.editMessageText(text, {
          chat_id: chatId,
          message_id: messageId,
          reply_markup: keyboard,
          parse_mode: parseMode
        });
      } catch (error) {
        console.error("Error editing message:", error);
        // Fallback to sending new message if edit fails
        await this.bot.sendMessage(chatId, text, {
          reply_markup: keyboard,
          parse_mode: parseMode
        });
      }
    } else {
      await this.bot.sendMessage(chatId, text, {
        reply_markup: keyboard,
        parse_mode: parseMode
      });
    }
  }

  async initialize(botToken: string, websocketServer?: WebSocketServer) {
    // Clean shutdown of existing bot
    if (this.bot) {
      try {
        console.log("🔄 Shutting down existing bot instance...");
        await this.bot.close();
        this.bot = null;
        // Wait a bit to ensure cleanup
        await new Promise(resolve => setTimeout(resolve, 1000));
      } catch (error) {
        console.warn("Warning during bot shutdown:", error);
      }
    }

    this.websocketServer = websocketServer || undefined;
    
    try {
      // Create bot with proper error handling
      this.bot = new TelegramBot(botToken, { 
        polling: {
          interval: 300,
          autoStart: false,
          params: {
            timeout: 30
          }
        }
      });
      
      // Clear any existing webhook AND drop pending buffered updates to avoid
      // re-processing /start commands that were queued during downtime
      try {
        await (this.bot as any).deleteWebHook({ drop_pending_updates: true });
        console.log("🧹 Cleared existing webhook and pending updates");
      } catch (error) {
        console.warn("Failed to delete webhook:", error);
      }

      // Remove any lingering listeners from a previous initialize() call
      // BEFORE registering new ones to prevent duplicate processing
      this.bot.removeAllListeners();

      // Set up polling error handler AFTER removeAllListeners so it is not wiped
      this.bot.on('polling_error', (error: any) => {
        const msg: string = error?.message ?? '';
        // 401 Unauthorized — token is invalid, stop polling immediately (no point retrying)
        if (msg.includes('401') || error?.response?.body?.error_code === 401) {
          logger.error('❌ Bot1 got 401 Unauthorized — invalid token. Stopping polling.');
          this.bot?.stopPolling().catch(() => {});
          return;
        }
        logger.warn({ msg }, '⚠️ Bot polling error');
        // On 409 Conflict (another instance still polling), retry after Telegram's
        // long-poll timeout expires (~30s). Using a flag to avoid stacking retries.
        if (error?.code === 'ETELEGRAM' && (error?.response?.body?.error_code === 409 || msg.includes('409'))) {
          if (!(this as any)._retrying409) {
            (this as any)._retrying409 = true;
            logger.warn('Bot got 409 Conflict — will retry polling in 35s');
            setTimeout(async () => {
              (this as any)._retrying409 = false;
              if (!this.bot) return;
              try {
                await this.bot.stopPolling();
                await new Promise(r => setTimeout(r, 1000));
                await this.bot.startPolling();
                logger.info('✅ Bot polling restarted after 409');
              } catch (e) {
                logger.error({ err: e }, 'Failed to restart polling after 409');
              }
            }, 35_000);
          }
        }
      });

      // Set up message/callback handlers before starting polling
      this.setupHandlers();
      
      // Start polling manually
      await this.bot.startPolling();

      // Store bot username for deeplinks
      try {
        const me = await this.bot.getMe();
        this.botUsername = me.username || '';
      } catch { /* ignore */ }
      
      // Start message queue processor
      this.startMessageQueueProcessor();
      
      // Start cache cleanup every 3 minutes
      setInterval(() => {
        this.messageCache.clear();
        this.recentCommandsCache.clear();
      }, 3 * 60 * 1000);
      
      // Recover lode state (processed date + pending bets) from DB after restart
      await this.loadLodeStateFromDB();

      // Start scheduled tasks for auto rewards and reset
      this.setupScheduledTasks();
      
      console.log("✅ Telegram bot initialized successfully");
    } catch (error) {
      console.error("❌ Failed to initialize bot:", error);
      this.bot = null;
      throw error;
    }
  }

  /**
   * Setup scheduled tasks for auto reset and rewards
   */
  private setupScheduledTasks() {
    // Check every minute for scheduled tasks
    setInterval(async () => {
      // Always use Vietnam time (UTC+7) for scheduling
      const nowVN = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Ho_Chi_Minh" }));
      const hour = nowVN.getHours();
      const minute = nowVN.getMinutes();
      const dayOfWeek = nowVN.getDay(); // 0 = Sunday, 1 = Monday, ...

      // Daily top rewards → hòm quà at 00:00 every day (VN time)
      if (hour === 0 && minute === 0) {
        await this.distributeDailyRewards();
      }

      // Weekly top rewards → hòm quà at Monday 00:00 (VN time)
      if (dayOfWeek === 1 && hour === 0 && minute === 0) {
        await this.distributeWeeklyRewards();
      }

      // Poll for XSMB results every minute from 18:30 to 21:00 (VN time) until processed
      // 18:30 là thời điểm phiên XSMB đã ra đầy đủ kết quả
      const today = `${nowVN.getDate().toString().padStart(2,'0')}-${(nowVN.getMonth()+1).toString().padStart(2,'0')}-${nowVN.getFullYear()}`;
      const after1830 = hour > 18 || (hour === 18 && minute >= 30);
      if (after1830 && hour <= 21 && this.lodeResultProcessed !== today) {
        await this.processLodeResults();
      }
    }, 60000); // Check every minute

    console.log("⏰ Scheduled tasks initialized (VN time UTC+7): Daily rewards 00:00, Weekly Monday 00:00, Lô Đề poll 18:00-21:00");
  }

  private setupHandlers() {
    if (!this.bot) return;

    // Start command - only works in private chat
    this.bot.onText(/\/start(?:\s+(.+))?/, async (msg: TelegramBot.Message, match) => {
      const chatId = msg.chat.id;
      const user = msg.from;
      
      // Only work in private chats, ignore in groups
      if (msg.chat.type !== 'private') {
        return;
      }

      // Dedup: ignore /start if the same user triggered it within last 5s
      const startKey = `start_${user?.id}`;
      if (this.recentInteractions.has(startKey)) return;
      this.recentInteractions.add(startKey);
      setTimeout(() => this.recentInteractions.delete(startKey), 5000);
      
      const param = match?.[1]?.trim();
      
      if (user) {
        // Deep link: /start nap_tien — redirect straight to deposit menu
        if (param === 'nap_tien') {
          await this.createOrUpdateUser(user, undefined);
          await this.showDepositOptions(chatId);
          return;
        }
        // Deep link: /start rut_tien — redirect straight to withdraw menu
        if (param === 'rut_tien') {
          await this.createOrUpdateUser(user, undefined);
          await this.handleWithdraw(chatId, String(user.id));
          return;
        }
        // Deep link: /start join_HARU88-XXXXXX — join a solo dice room from group button
        if (param && param.startsWith('join_')) {
          const roomCode = param.substring(5).toUpperCase();
          await this.createOrUpdateUser(user, undefined);
          await this.handleJoinSoloDiceRoom(chatId, String(user.id), roomCode);
          return;
        }
        // Normal referral or plain /start
        const referralCode = param;
        await this.createOrUpdateUser(user, referralCode);
        // Gửi banner trước, sau đó mới hiện menu
        try {
          const photoBuffer = readFileSync(join(PUBLIC_DIR, 'haru88-banner.png'));
          await this.bot?.sendPhoto(chatId, photoBuffer, {
            caption: `🎫 ID của bạn là: ${user.id}\n\n👉 Tham gia Room TX để săn hũ và nhận giftcode hằng ngày https://t.me/TXCLHARU88`
          });
        } catch { /* banner optional */ }
        await this.sendMainMenu(chatId);
      }
    });

    // Code command for gift code redemption - only works in private chats
    this.bot.onText(/\/code\s+(.+)/, async (msg: TelegramBot.Message, match) => {
      const chatId = msg.chat.id;
      const user = msg.from;
      const giftCode = match?.[1]?.trim();
      
      // Only work in private chats, ignore in groups
      if (msg.chat.type !== 'private') {
        return;
      }
      
      if (user && giftCode) {
        await this.redeemGiftCode(chatId, user.id.toString(), giftCode);
      } else {
        await this.bot?.sendMessage(chatId, "🎁 Cách nhập giftcode:\n/code [dấu cách] mã giftcode\n\nVD: /code CODE123");
      }
    });

    // /taocode (số_lượng) (giá_trị) — chỉ dành cho admin 6030019812
    this.bot.onText(/\/taocode(?:\s+(\d+))?(?:\s+(\d+))?/, async (msg: TelegramBot.Message, match) => {
      const chatId = msg.chat.id;
      const senderId = msg.from?.id.toString();
      const ALLOWED_USER = "6030019812";

      if (senderId !== ALLOWED_USER) {
        await this.bot?.sendMessage(chatId, "❌ Bạn không có quyền sử dụng lệnh này!");
        return;
      }

      const quantity = parseInt(match?.[1] || "0");
      const value = parseInt(match?.[2] || "0");

      if (!quantity || quantity < 1 || quantity > 100) {
        await this.bot?.sendMessage(chatId,
          "⚙️ <b>Tạo Gift Code</b>\n\n" +
          "Cú pháp: <code>/taocode [số lượng] [giá trị]</code>\n\n" +
          "Ví dụ: <code>/taocode 5 50000</code>\n" +
          "→ Tạo 5 code, mỗi code trị giá 50,000đ\n\n" +
          "⚠️ Số lượng tối đa: 100 code/lần",
          { parse_mode: "HTML" }
        );
        return;
      }

      if (!value || value < 1000) {
        await this.bot?.sendMessage(chatId, "❌ Giá trị tối thiểu mỗi code là 1,000đ!", { parse_mode: "HTML" });
        return;
      }

      // Generate codes
      const createdCodes: string[] = [];
      const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
      for (let i = 0; i < quantity; i++) {
        let suffix = "";
        for (let j = 0; j < 6; j++) {
          suffix += chars.charAt(Math.floor(Math.random() * chars.length));
        }
        const code = `HARU88-${suffix}`;
        try {
          await storage.createGiftCode({
            code,
            amount: value.toString(),
            maxUses: 1,
            isActive: true,
            createdBy: null,
          } as any);
          createdCodes.push(code);
        } catch (err) {
          // Skip duplicate
        }
      }

      if (createdCodes.length === 0) {
        await this.bot?.sendMessage(chatId, "❌ Tạo code thất bại, vui lòng thử lại!");
        return;
      }

      const codeList = createdCodes.map((c, i) => `${i + 1}. <code>${c}</code>`).join("\n");
      const totalValue = (createdCodes.length * value).toLocaleString("vi-VN");

      await this.bot?.sendMessage(chatId,
        `✅ <b>Đã tạo ${createdCodes.length} gift code</b>\n` +
        `💰 Mệnh giá: ${value.toLocaleString("vi-VN")}đ/code\n` +
        `💎 Tổng giá trị: ${totalValue}đ\n\n` +
        `📋 <b>Danh sách code:</b>\n${codeList}\n\n` +
        `📌 Người chơi nhập code: <code>/code [mã]</code>`,
        { parse_mode: "HTML" }
      );
    });

    // Admin setroom command for tài xỉu room - only works in private chats
    this.bot.onText(/\/setroom\s+(\d+)\s+(\d+)\s+(\d+)/, async (msg: TelegramBot.Message, match) => {
      const chatId = msg.chat.id;
      const userId = msg.from?.id.toString();
      
      // Only work in private chats, ignore in groups
      if (msg.chat.type !== 'private') {
        return;
      }
      
      if (userId && match) {
        const dice1 = parseInt(match[1]);
        const dice2 = parseInt(match[2]);
        const dice3 = parseInt(match[3]);
        
        try {
          await this.setRoomResults([dice1, dice2, dice3]);
          await this.bot!.sendMessage(chatId, 
            `✅ <b>ĐÃ THIẾT LẬP KẾT QUẢ PHÒNG</b>\n\n` +
            `🎲 Kết quả: ${dice1} ${dice2} ${dice3}\n` +
            `📊 Tổng: ${dice1 + dice2 + dice3} (${dice1 + dice2 + dice3 >= 11 ? 'TÀI' : 'XỈU'})\n\n` +
            `💰 Đã xử lý thanh toán cho tất cả người chơi!`,
            { parse_mode: 'HTML' }
          );
        } catch (error) {
          await this.bot!.sendMessage(chatId, `❌ Lỗi: ${error}`);
        }
      }
    });

    // Top bet today command - only works in private chats
    this.bot.onText(/^\/topcuoc(?:\s|$)/, async (msg: TelegramBot.Message) => {
      const chatId = msg.chat.id;
      
      // Only work in private chats, ignore in groups
      if (msg.chat.type !== 'private') {
        return;
      }
      
      await this.showDailyBettingRankings(chatId);
    });

    // Top bet weekly command - only works in private chats
    this.bot.onText(/^\/topcuoctuan(?:\s|$)/, async (msg: TelegramBot.Message) => {
      const chatId = msg.chat.id;
      
      // Only work in private chats, ignore in groups
      if (msg.chat.type !== 'private') {
        return;
      }
      
      await this.showWeeklyBettingRankings(chatId);
    });

    // /code without args — show guide
    this.bot.onText(/^\/code$/, async (msg: TelegramBot.Message) => {
      if (msg.chat.type !== 'private') return;
      await this.bot?.sendMessage(msg.chat.id,
        "🎁 <b>Nhập Gift Code</b>\n\nCú pháp: <code>/code [mã code]</code>\nVD: <code>/code HARU88XYZ</code>",
        { parse_mode: "HTML" }
      );
    });

    // /lode without args — show guide
    this.bot.onText(/^\/hotro$/, async (msg: TelegramBot.Message) => {
      await this.showSupport(msg.chat.id);
    });

    this.bot.onText(/^\/lode$/, async (msg: TelegramBot.Message) => {
      if (msg.chat.type !== 'private') return;
      await this.sendGameBettingOptions(msg.chat.id, "lode");
    });

    // /thongke — show user stats
    this.bot.onText(/^\/thongke$/, async (msg: TelegramBot.Message) => {
      const chatId = msg.chat.id;
      if (msg.chat.type !== 'private') return;
      const userId = msg.from?.id.toString();
      if (!userId) return;
      try {
        const user = await storage.getBotUser(userId);
        if (!user) { await this.bot?.sendMessage(chatId, "❌ Không tìm thấy tài khoản!"); return; }
        const sessions = await storage.getGameSessionsByUser(userId, 1000);
        const total = sessions.length;
        const wins = sessions.filter((s: any) => parseFloat(s.winAmount || "0") > parseFloat(s.betAmount || "0")).length;
        const losses = sessions.filter((s: any) => s.status === "completed" && parseFloat(s.winAmount || "0") < parseFloat(s.betAmount || "0")).length;
        const ties = total - wins - losses;
        const totalBet = sessions.reduce((sum: number, s: any) => sum + parseFloat(s.betAmount || "0"), 0);
        const totalWin = sessions.reduce((sum: number, s: any) => sum + parseFloat(s.winAmount || "0"), 0);
        const pnl = totalWin - totalBet;
        const winRate = total > 0 ? ((wins / total) * 100).toFixed(1) : "0.0";
        // Most played game
        const gameCount: Record<string, number> = {};
        for (const s of sessions) { gameCount[s.gameType] = (gameCount[s.gameType] || 0) + 1; }
        const topGame = Object.entries(gameCount).sort((a, b) => b[1] - a[1])[0];
        await this.bot?.sendMessage(chatId,
          `📊 <b>THỐNG KÊ CÁ NHÂN</b>\n\n` +
          `👤 Tài khoản: @${user.username || userId}\n` +
          `💰 Số dư: ${parseFloat(user.balance || "0").toLocaleString()}đ\n\n` +
          `🎮 Tổng ván: <b>${total}</b>\n` +
          `✅ Thắng: <b>${wins}</b> | ❌ Thua: <b>${losses}</b> | 🤝 Hòa: <b>${ties}</b>\n` +
          `📈 Tỉ lệ thắng: <b>${winRate}%</b>\n\n` +
          `💵 Tổng cược: ${totalBet.toLocaleString()}đ\n` +
          `🏆 Tổng thắng: ${totalWin.toLocaleString()}đ\n` +
          `${pnl >= 0 ? "📈" : "📉"} P&L: ${pnl >= 0 ? "+" : ""}${pnl.toLocaleString()}đ\n` +
          (topGame ? `🎯 Game yêu thích: <b>${topGame[0]}</b> (${topGame[1]} ván)` : ""),
          { parse_mode: "HTML" }
        );
      } catch (err) {
        console.error("Error in /thongke:", err);
        await this.bot?.sendMessage(chatId, "❌ Có lỗi khi lấy thống kê!");
      }
    });


    // /ip command — admin only
    this.bot.onText(/\/ip/, async (msg: TelegramBot.Message) => {
      const chatId = msg.chat.id;
      const userId = msg.from?.id?.toString();
      const ADMIN_ID = "6030019812";
      if (userId !== ADMIN_ID) {
        await this.bot?.sendMessage(chatId, "❌ Bạn không có quyền dùng lệnh này!");
        return;
      }
      try {
        const res = await fetch("https://api.ipify.org?format=json");
        const data = await res.json() as { ip: string };
        const domains = process.env["REPLIT_DOMAINS"] ?? "";
        const callbackUrl = `https://${domains.split(",")[0]}/api/card/callback`;
        await this.bot?.sendMessage(
          chatId,
          `🌐 <b>Thông tin server:</b>\n\n` +
          `📍 IP hiện tại: <code>${data.ip}</code>\n\n` +
          `🔗 Callback URL (TSR):\n<code>${callbackUrl}</code>`,
          { parse_mode: "HTML" }
        );
      } catch {
        await this.bot?.sendMessage(chatId, "❌ Không lấy được IP, vui lòng thử lại!");
      }
    });

    // /gui (nội dung) — admin: gửi tin nhắn vào nhóm và ghim
    this.bot.onText(/^\/gui(?:\s+([\s\S]+))?$/i, async (msg: TelegramBot.Message, match) => {
      const chatId = msg.chat.id;
      const userId = msg.from?.id?.toString();
      const ADMIN_ID = "6030019812";
      const MAIN_GROUP = -1003132451812;

      if (userId !== ADMIN_ID) {
        await this.bot?.sendMessage(chatId, "❌ Bạn không có quyền dùng lệnh này!");
        return;
      }

      const content = match?.[1]?.trim();
      if (!content) {
        await this.bot?.sendMessage(
          chatId,
          "📢 <b>Lệnh gửi thông báo nhóm</b>\n\n" +
          "Cú pháp: <code>/gui [nội dung]</code>\n\n" +
          "Ví dụ:\n<code>/gui Hệ thống bảo trì 30 phút!</code>\n\n" +
          "Bot sẽ gửi nội dung vào nhóm và tự động ghim tin nhắn.",
          { parse_mode: "HTML" }
        );
        return;
      }

      try {
        const sent = await this.bot?.sendMessage(MAIN_GROUP, content, { parse_mode: "HTML" });
        if (sent) {
          try {
            await this.bot?.pinChatMessage(MAIN_GROUP, sent.message_id, { disable_notification: false });
          } catch (pinErr) {
            // Pin might fail if bot lacks admin rights in group
            await this.bot?.sendMessage(chatId,
              "✅ Đã gửi tin nhắn vào nhóm!\n⚠️ Không thể ghim (bot cần quyền ghim tin nhắn trong nhóm).",
              { parse_mode: "HTML" }
            );
            return;
          }
          await this.bot?.sendMessage(
            chatId,
            `✅ <b>Đã gửi và ghim thành công!</b>\n\n📋 Nội dung:\n${content}`,
            { parse_mode: "HTML" }
          );
        }
      } catch (err) {
        await this.bot?.sendMessage(chatId, "❌ Gửi thất bại! Bot cần là admin trong nhóm mới gửi được.");
      }
    });

    // /doidiemvip — exchange VIP points for money
    this.bot.onText(/\/doidiemvip(?:\s+(\d+))?/, async (msg: TelegramBot.Message, match) => {
      const chatId = msg.chat.id;
      const userId = msg.from?.id?.toString();
      if (!userId || msg.chat.type !== 'private') return;

      const pointsInput = parseInt(match?.[1] || "0");
      const user = await storage.getBotUser(userId);
      if (!user) return;

      const totalWagered = parseFloat(user.totalWagered || "0");
      const earnedPoints = Math.floor(totalWagered / 300000);
      const spentPoints = await storage.getSpentVipPoints(userId);
      const availablePoints = Math.max(0, earnedPoints - spentPoints);
      const vipLevel = this.getVipLevelFromPoints(earnedPoints);
      const vipDetails = this.getVipDetails(vipLevel);

      if (vipLevel === 0) {
        await this.bot?.sendMessage(chatId,
          `❌ Bạn chưa đủ điểm để lên VIP 1!\n\n` +
          `• Điểm hiện tại: <b>${earnedPoints.toLocaleString()}</b> điểm\n` +
          `• Cần: <b>10</b> điểm để lên VIP 1 (Tép Con 🦐)\n` +
          `• Cách kiếm điểm: mỗi 300,000đ cược = 1 điểm VIP`,
          { parse_mode: "HTML" }
        );
        return;
      }

      if (pointsInput <= 0) {
        await this.bot?.sendMessage(chatId,
          `💎 <b>ĐỔI ĐIỂM VIP</b>\n\n` +
          `• Cấp VIP: <b>VIP ${vipLevel}</b> ${vipDetails.emoji} ${vipDetails.name}\n` +
          `• Điểm tích lũy: <b>${earnedPoints.toLocaleString()}</b> điểm\n` +
          `• Điểm có thể đổi: <b>${availablePoints.toLocaleString()}</b> điểm\n` +
          `• Tỷ lệ: <b>${vipDetails.rate}đ/điểm</b>\n\n` +
          `👉 Dùng: <code>/doidiemvip [số điểm]</code>\n` +
          `VD: <code>/doidiemvip 10</code> → nhận ${(10 * vipDetails.rate).toLocaleString()}đ`,
          { parse_mode: "HTML" }
        );
        return;
      }

      if (availablePoints < pointsInput) {
        await this.bot?.sendMessage(chatId,
          `❌ Bạn chỉ có <b>${availablePoints.toLocaleString()}</b> điểm có thể đổi!\n` +
          `(Đã dùng: ${spentPoints.toLocaleString()} điểm)`,
          { parse_mode: "HTML" }
        );
        return;
      }

      const moneyReceived = pointsInput * vipDetails.rate;
      const newBalance = (parseFloat(user.balance || "0") + moneyReceived).toString();
      await storage.updateBotUser(userId, { balance: newBalance });
      await storage.createTransaction({
        userId,
        type: "vip_exchange",
        amount: moneyReceived.toString(),
        status: "completed",
        method: "vip_points",
        metadata: { pointsSpent: pointsInput, vipLevel, rate: vipDetails.rate }
      });

      await this.bot?.sendMessage(chatId,
        `✅ <b>ĐỔI ĐIỂM VIP THÀNH CÔNG!</b>\n\n` +
        `• Đã đổi: <b>${pointsInput.toLocaleString()}</b> điểm\n` +
        `• Nhận: <b>+${moneyReceived.toLocaleString()}đ</b>\n` +
        `• Số dư mới: <b>${parseFloat(newBalance).toLocaleString()}đ</b>\n` +
        `• Điểm còn lại: <b>${(availablePoints - pointsInput).toLocaleString()}</b> điểm`,
        { parse_mode: "HTML" }
      );
    });

    // /daythang — view current winning streak
    this.bot.onText(/\/daythang/, async (msg: TelegramBot.Message) => {
      const chatId = msg.chat.id;
      const userId = msg.from?.id?.toString();
      if (!userId) return;
      const userName = msg.from?.first_name || "Bạn";
      const isGroup = chatId < 0;

      // Cập nhật tên trong map khi user gọi lệnh
      const myStreak = this.txStreaks.get(userId) || { wins: 0, losses: 0, name: userName };
      myStreak.name = userName;
      this.txStreaks.set(userId, myStreak);

      if (isGroup) {
        // Trong nhóm: hiển thị bảng tất cả chuỗi thắng
        const allWinStreaks = Array.from(this.txStreaks.entries())
          .filter(([, s]) => s.wins > 0)
          .sort(([, a], [, b]) => b.wins - a.wins)
          .slice(0, 10);

        if (allWinStreaks.length === 0) {
          await this.bot?.sendMessage(chatId,
            `🏆 <b>Hiện chưa ai có chuỗi thắng!</b>\n` +
            `<i>(Chỉ tính cược Tài Xỉu ≥ 10,000đ)</i>`,
            { parse_mode: "HTML" }
          );
        } else {
          const medals = ['🥇', '🥈', '🥉'];
          const lines = allWinStreaks.map(([uid, s], i) => {
            const medal = medals[i] ?? `${i + 1}.`;
            const name = s.name && s.name !== uid ? s.name : `Người chơi`;
            return `${medal} <b>${name}</b> — 🔥 <b>${s.wins}</b> lần liên tiếp`;
          });
          await this.bot?.sendMessage(chatId,
            `🔥 <b>BẢNG CHUỖI THẮNG LIÊN TIẾP</b>\n` +
            `━━━━━━━━━━━━━━━━━━━━━━\n` +
            lines.join('\n') + '\n\n' +
            `<i>Chỉ tính cược Tài Xỉu ≥ 10,000đ</i>`,
            { parse_mode: "HTML" }
          );
        }
      } else {
        // Chat riêng: hiển thị streak của bản thân
        if (myStreak.wins === 0) {
          await this.bot?.sendMessage(chatId,
            `🎯 <b>${userName}</b> chưa có chuỗi thắng nào!\n` +
            `(Chỉ tính cược Tài Xỉu ≥ 10,000đ)`,
            { parse_mode: "HTML" }
          );
        } else {
          await this.bot?.sendMessage(chatId,
            `🔥 <b>${userName}</b> đang có chuỗi <b>${myStreak.wins} lần THẮNG</b> liên tiếp!\n\n` +
            `💪 Đú dây đi anh ơi! https://t.me/TXCLHARU88`,
            { parse_mode: "HTML" }
          );
        }
      }
    });

    // /daythua — view current losing streak
    this.bot.onText(/\/daythua/, async (msg: TelegramBot.Message) => {
      const chatId = msg.chat.id;
      const userId = msg.from?.id?.toString();
      if (!userId) return;
      const userName = msg.from?.first_name || "Bạn";
      const isGroup = chatId < 0;

      // Cập nhật tên trong map khi user gọi lệnh
      const myStreak = this.txStreaks.get(userId) || { wins: 0, losses: 0, name: userName };
      myStreak.name = userName;
      this.txStreaks.set(userId, myStreak);

      if (isGroup) {
        // Trong nhóm: hiển thị bảng tất cả chuỗi thua
        const allLoseStreaks = Array.from(this.txStreaks.entries())
          .filter(([, s]) => s.losses > 0)
          .sort(([, a], [, b]) => b.losses - a.losses)
          .slice(0, 10);

        if (allLoseStreaks.length === 0) {
          await this.bot?.sendMessage(chatId,
            `🏅 <b>Hiện chưa ai đang có chuỗi thua!</b>\n` +
            `<i>(Chỉ tính cược Tài Xỉu ≥ 10,000đ)</i>`,
            { parse_mode: "HTML" }
          );
        } else {
          const medals = ['💀', '😭', '😢'];
          const lines = allLoseStreaks.map(([uid, s], i) => {
            const medal = medals[i] ?? `${i + 1}.`;
            const name = s.name && s.name !== uid ? s.name : `Người chơi`;
            return `${medal} <b>${name}</b> — ❌ <b>${s.losses}</b> lần liên tiếp`;
          });
          await this.bot?.sendMessage(chatId,
            `😱 <b>BẢNG CHUỖI THUA LIÊN TIẾP</b>\n` +
            `━━━━━━━━━━━━━━━━━━━━━━\n` +
            lines.join('\n') + '\n\n' +
            `<i>Chỉ tính cược Tài Xỉu ≥ 10,000đ</i>`,
            { parse_mode: "HTML" }
          );
        }
      } else {
        // Chat riêng: hiển thị streak của bản thân
        if (myStreak.losses === 0) {
          await this.bot?.sendMessage(chatId,
            `🎯 <b>${userName}</b> chưa có chuỗi thua nào!\n` +
            `(Chỉ tính cược Tài Xỉu ≥ 10,000đ)`,
            { parse_mode: "HTML" }
          );
        } else {
          await this.bot?.sendMessage(chatId,
            `😭 <b>${userName}</b> đang có chuỗi <b>${myStreak.losses} lần THUA</b> liên tiếp!\n\n` +
            `💡 Hãy thử đú dây ngược chiều! https://t.me/TXCLHARU88`,
            { parse_mode: "HTML" }
          );
        }
      }
    });

    // Bank withdrawal command
    this.bot.onText(/\/rutbank\s+(.+)/, async (msg: TelegramBot.Message, match) => {
      const chatId = msg.chat.id;
      const user = msg.from;
      const params = match?.[1]?.trim();
      
      if (user && params) {
        const userId = user.id.toString();
        const webSession = getWebGameSession(userId);
        if (webSession) {
          await this.bot?.sendMessage(chatId,
            `⚠️ <b>Không thể rút tiền!</b>\n\n` +
            `Bạn đang có cược <b>${webSession.betAmount.toLocaleString("vi-VN")}đ</b> trong game <b>${webSession.game}</b>.\n\n` +
            `Vui lòng chờ phiên kết thúc (thắng hoặc thua) rồi mới rút tiền được nhé! 🎯`,
            { parse_mode: "HTML" }
          );
          return;
        }
        await this.handleBankWithdrawal(chatId, userId, params);
      } else {
        await this.bot?.sendMessage(chatId, 
          "🏧 Vui lòng thực hiện theo hướng dẫn sau:\n\n" +
          "👉 /rutbank [dấu cách] Số tiền muốn rút [dấu cách]  Mã ngân hàng [dấu cách] Số tài khoản [dấu cách] Tên chủ tài khoản\n" +
          "👉 VD:  Muốn rút 100k đến TK số 01234567890 tại Ngân hàng Vietcombank. Thực hiện theo cú pháp sau:\n\n" +
          "/rutbank 100000 VCB 01234567890 NGUYEN VAN A\n\n" +
          "⚠️ Lưu ý: Không hỗ trợ hoàn tiền nếu bạn nhập sai thông tin Tài khoản.\n" +
          "👉 Rút tối thiểu 100,000đ\n\n" +
          "MÃ NGÂN HÀNG - TÊN NGÂN HÀNG\n\n" +
          "📌 ACB ==> ACB - NH TMCP A CHAU\n" +
          "📌 BIDV ==> BIDV - NH DAU TU VA PHAT TRIEN VIET NAM\n" +
          "📌 MBB ==> MB - NH TMCP QUAN DOI\n" +
          "📌 MSB ==> MSB - NH TMCP HANG HAI\n" +
          "📌 TCB ==> TECHCOMBANK - NH TMCP KY THUONG VIET NAM\n" +
          "📌 TPB ==> TPBANK - NH TMCP TIEN PHONG\n" +
          "📌 VCB ==> VIETCOMBANK - NH TMCP NGOAI THUONG VIET NAM\n" +
          "📌 VIB ==> VIB - NH TMCP QUOC TE VIET NAM\n" +
          "📌 VPB ==> VPBANK - NH TMCP VIET NAM THINH VUONG\n" +
          "📌 VTB ==> VIETINBANK - NH TMCP CONG THUONG VIET NAM\n" +
          "📌 SHIB ==> SHINHANBANK - NH TNHH SHINHAN VIET NAM\n" +
          "📌 ABB ==> ABBANK - NH TMCP AN BINH\n" +
          "📌 AGR ==> AGRIBANK - NH NN & PTNT VIET NAM\n" +
          "📌 VCCB ==> BANVIET - NH TMCP BAN VIET\n" +
          "📌 BVB ==> BAOVIETBANK - NH TMCP BAO VIET (BVB)\n" +
          "📌 DAB ==> DONGABANK - NH TMCP DONG A\n" +
          "📌 EIB ==> EXIMBANK - NH TMCP XUAT NHAP KHAU VIET NAM\n" +
          "📌 GPB ==> GPBANK - NH TMCP DAU KHI TOAN CAU\n" +
          "📌 HDB ==> HDBANK - NH TMCP PHAT TRIEN TP.HCM\n" +
          "📌 KLB ==> KIENLONGBANK - NH TMCP KIEN LONG\n" +
          "📌 NAB ==> NAMABANK - NH TMCP NAM A\n" +
          "📌 NCB ==> NCB - NH TMCP QUOC DAN\n" +
          "📌 OCB ==> OCB - NH TMCP PHUONG DONG\n" +
          "📌 OJB ==> OCEANBANK - NH TMCP DAI DUONG (OJB)\n" +
          "📌 PGB ==> PGBANK - NH TMCP XANG DAU PETROLIMEX\n" +
          "📌 PVB ==> PVCOMBANK - NH TMCP DAI CHUNG VIET NAM\n" +
          "📌 STB ==> SACOMBANK - NH TMCP SAI GON THUONG TIN\n" +
          "📌 SGB ==> SAIGONBANK - NH TMCP SAI GON CONG THUONG\n" +
          "📌 SCB ==> SCB - NH TMCP SAI GON\n" +
          "📌 SAB ==> SEABANK - NH TMCP DONG NAM A\n" +
          "📌 SHB ==> SHB - NH TMCP SAI GON HA NOI"
        );
      }
    });

    // Transfer money command
    this.bot.onText(/\/chuyen\s+(.+)/, async (msg: TelegramBot.Message, match) => {
      const chatId = msg.chat.id;
      const senderId = msg.from?.id.toString();
      const params = match?.[1]?.trim();
      
      // Only work in private chats
      if (msg.chat.type !== 'private') {
        return;
      }
      
      if (senderId && params) {
        await this.processTransferMoney(chatId, senderId, params);
      } else {
        await this.bot?.sendMessage(chatId,
          "💸 **CHUYỂN TIỀN** 💸\n\n" +
          "📝 **Sử dụng:** /chuyen [ID người nhận] [số tiền]\n\n" +
          "💡 **Ví dụ:** /chuyen 123456789 50000\n\n" +
          "⚠️ **Lưu ý:**\n" +
          "• Số tiền tối thiểu: 10,000đ\n" +
          "• Kiểm tra kỹ ID người nhận",
          { parse_mode: "Markdown" }
        );
      }
    });

    // Balance check command - works in both groups and private chats
    this.bot.onText(/\/sd/, async (msg: TelegramBot.Message) => {
      const chatId = msg.chat.id;
      const user = msg.from;
      
      if (user) {
        try {
          const userId = user.id.toString();
          let userData = await storage.getBotUser(userId);
          
          if (!userData) {
            await this.createOrUpdateUser(user);
            userData = await storage.getBotUser(userId);
          }
          
          // Always delete the /sd message
          try { await this.bot!.deleteMessage(chatId, msg.message_id); } catch {}

          if (userData) {
            const currentBalance = parseFloat(userData.balance || "0");
            const name = `${user.first_name || ''} ${user.last_name || ''}`.trim() || 'Người dùng';

            const balanceMsg =
              `💎 <b>SỐ DƯ TÀI KHOẢN</b>\n\n` +
              `<blockquote>` +
              `👤 Tên: <b>${name}</b>\n` +
              `🆔 ID: <b>${user.id}</b>\n` +
              `💰 Số dư: <b>${currentBalance.toLocaleString('vi-VN')}đ</b>\n` +
              `📅 Cập nhật: <b>${new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })}</b>` +
              `</blockquote>`;

            const closeKeyboard = {
              inline_keyboard: [[{ text: "❌ Đóng", callback_data: "close_message" }]]
            };

            const sdMsg = await this.bot!.sendMessage(chatId, balanceMsg, {
              parse_mode: 'HTML',
              reply_markup: closeKeyboard,
            });
            // Tự xoá tin nhắn sau 2 giây
            setTimeout(() => {
              this.bot!.deleteMessage(chatId, sdMsg.message_id).catch(() => {});
            }, 2000);
          } else {
            await this.bot!.sendMessage(chatId, "❌ Có lỗi xảy ra khi tạo tài khoản!");
          }
        } catch (error) {
          console.error('Error handling /sd command:', error);
        }
      }
    });

    // Weekly reward claim command
    this.bot.onText(/\/homqua/, async (msg: TelegramBot.Message) => {
      const chatId = msg.chat.id;
      const user = msg.from;
      
      // Only work in private chats
      if (msg.chat.type !== 'private') {
        return;
      }
      
      if (user) {
        await this.handleOnePieceTreasure(chatId, user.id.toString());
      }
    });

    // Quick access commands
    this.bot.onText(/\/nap/, async (msg: TelegramBot.Message) => {
      const chatId = msg.chat.id;
      if (msg.chat.type === 'private') {
        await this.showDepositOptions(chatId);
      }
    });

    this.bot.onText(/\/rút/, async (msg: TelegramBot.Message) => {
      const chatId = msg.chat.id;
      const user = msg.from;
      if (msg.chat.type === 'private' && user) {
        await this.handleWithdraw(chatId, user.id.toString());
      }
    });

    this.bot.onText(/\/menu/, async (msg: TelegramBot.Message) => {
      const chatId = msg.chat.id;
      if (msg.chat.type === 'private') {
        await this.sendMainMenu(chatId);
      }
    });

    this.bot.onText(/\/game/, async (msg: TelegramBot.Message) => {
      const chatId = msg.chat.id;
      if (msg.chat.type === 'private') {
        await this.showGamesMenu(chatId);
      }
    });

    // Handle web_app_data from mini apps
    this.bot.on("message", async (msg: TelegramBot.Message) => {
      if (msg.web_app_data?.data) {
        const chatId = msg.chat.id;
        const userId = msg.from?.id.toString();
        
        try {
          const data = JSON.parse(msg.web_app_data.data);
          
          if (data.action === 'deposit' && userId) {
            // User clicked deposit button in Bầu Cua game
            await this.showDepositOptions(chatId);
          }
        } catch (error) {
          console.error("Error handling web_app_data:", error);
        }
      }
    });

    // Handle callback queries (inline buttons)
    this.bot.on("callback_query", async (query: TelegramBot.CallbackQuery) => {
      if (!query.data || !query.message) return;
      
      const chatId = query.message.chat.id;
      const userId = query.from.id.toString();
      const data = query.data;
      const messageId = query.message.message_id;

      // Anti-spam check for button clicks too
      if (await this.checkSpam(chatId, userId)) {
        await this.bot!.answerCallbackQuery(query.id, { text: "🚫 Bạn đang bị chặn do spam!" });
        return;
      }

      try {
        await this.handleCallbackQuery(chatId, userId, data, messageId, query.id);
        await this.bot!.answerCallbackQuery(query.id);
      } catch (error) {
        console.error("Callback query error:", error);
        await this.bot!.answerCallbackQuery(query.id, { text: "❌ Có lỗi xảy ra!" });
      }
    });

    // Handle text messages with debouncing to prevent duplicates
    this.bot.on("message", async (msg: TelegramBot.Message) => {
      if (msg.text && !msg.text.startsWith("/")) {
        const chatId = msg.chat.id;
        const userId = msg.from?.id.toString();
        
        if (userId) {
          try {
            // Anti-spam check first
            if (await this.checkSpam(chatId, userId)) return;

            // Add debouncing for text messages to prevent duplicates
            const textMessageKey = `${userId}_text_${msg.text.substring(0, 50)}`;
            if (this.recentInteractions.has(textMessageKey)) {
              console.log(`🚫 Blocked duplicate text message: ${textMessageKey}`);
              return; // Ignore duplicate rapid text messages
            }
            this.recentInteractions.add(textMessageKey);
            setTimeout(() => this.recentInteractions.delete(textMessageKey), 3000); // 3 second cooldown
            
            await this.handleTextMessage(chatId, userId, msg.text);
          } catch (err) {
            console.error(`❌ Error in message handler for user ${userId}:`, err);
          }
        }
      }
    });

    // Handle dice emoji messages sent by player (for waiting_player_roll mode)
    this.bot.on("message", async (msg: TelegramBot.Message) => {
      if (!msg.dice || msg.dice.emoji !== "🎲") return;
      const userId = msg.from?.id.toString();
      const chatId = msg.chat.id;
      if (!userId) return;

      const sess = this.gameSessions.get(userId);
      if (!sess || sess.status !== "waiting_player_roll") return;

      try {
        const collected = this.playerDiceCollector.get(userId) || [];
        collected.push(msg.dice.value);

        if (collected.length < 3) {
          this.playerDiceCollector.set(userId, collected);
          // Silent — Telegram already shows the dice animation
        } else {
          // Got all 3 dice — calculate result immediately
          this.playerDiceCollector.delete(userId);
          await this.completePendingXucXacBetWithValues(chatId, userId, sess, collected);
        }
      } catch (err) {
        console.error(`❌ Error in dice handler for user ${userId}:`, err);
      }
    });

    // ─── Solo Dice slash commands ───────────────────────
    const handleSoloCmd = async (msg: TelegramBot.Message) => {
      const chatId = msg.chat.id;
      const userId = msg.from?.id.toString();
      if (chatId > 0 && userId && msg.text) {
        await this.handleTextMessage(chatId, userId, msg.text);
      }
    };
    this.bot.onText(/^\/solo(?:\s+\d+)?$/i, handleSoloCmd);
    this.bot.onText(/^\/mophong(?:\s+\d+)?$/i, handleSoloCmd);
    this.bot.onText(/^\/vao(?:\s+\S+)?$/i, handleSoloCmd);
    this.bot.onText(/^\/huy(?:\s+\S+)?$/i, handleSoloCmd);
    this.bot.onText(/^\/phong$/i, handleSoloCmd);

    console.log("🤖 Bot handlers setup complete");
  }

  private async createOrUpdateUser(telegramUser: TelegramBot.User, referralCode?: string) {
    const existingUser = await storage.getBotUser(telegramUser.id.toString());
    
    if (!existingUser) {
      const userData: InsertBotUser = {
        id: telegramUser.id.toString(),
        username: telegramUser.username || null,
        firstName: telegramUser.first_name || null,
        lastName: telegramUser.last_name || null,
        referredBy: referralCode || null,
      };

      await storage.createBotUser(userData);
      
      // Generate referral code for new user
      const generatedCode = await storage.generateReferralCode(userData.id);
      console.log(`Generated referral code for user ${userData.id}: ${generatedCode}`);
      
      // Process referral if provided
      if (referralCode) {
        await this.processReferral(userData.id, referralCode);
      }
    } else {
      // Update user info if changed
      await storage.updateBotUser(existingUser.id, {
        username: telegramUser.username || existingUser.username,
        firstName: telegramUser.first_name || existingUser.firstName,
        lastName: telegramUser.last_name || existingUser.lastName,
      });
      
      // Generate referral code if not exists
      if (!existingUser.referralCode) {
        const generatedCode = await storage.generateReferralCode(existingUser.id);
        console.log(`Generated referral code for existing user ${existingUser.id}: ${generatedCode}`);
      }
    }
  }

  private async processReferral(newUserId: string, referralCode: string) {
    try {
      // Find referrer by referralCode field OR by user ID (backward compat with old links)
      const users = await storage.getAllBotUsers();
      const referrer = users.find(u =>
        (u.referralCode && u.referralCode === referralCode) ||
        u.id === referralCode
      );
      
      if (referrer && referrer.id !== newUserId) {
        // Track referral — bonus amount is read from bot_settings (referral_bonus key)
        const { bonus } = await storage.trackReferral(referrer.id, newUserId);
        
        // Get updated stats
        const stats = await storage.getReferralStats(referrer.id);
        
        // Notify referrer with actual bonus amount
        if (this.bot) {
          await this.bot.sendMessage(
            parseInt(referrer.id),
            `🎉 Bạn vừa nhận được ${bonus.toLocaleString("vi-VN")}đ thưởng giới thiệu!\n\n` +
            `👤 Người được giới thiệu: ${newUserId}\n` +
            `📊 Tổng số người giới thiệu: ${stats.referralCount}\n` +
            `💰 Tổng thu nhập giới thiệu: ${stats.totalEarnings.toLocaleString()}đ\n` +
            `🎯 Mốc tiếp theo: ${stats.nextMilestone} người`
          );
        }
      }
    } catch (error) {
      console.error("Error processing referral:", error);
    }
  }

  /**
   * Returns the public base URL of this server — works on Replit, Render, VPS, or any platform.
   * Priority: PUBLIC_URL env → RENDER_EXTERNAL_URL → REPLIT_DOMAINS → REPLIT_DEV_DOMAIN → bot-config.json
   */
  private getPublicUrl(): string {
    if (process.env["PUBLIC_URL"]) return process.env["PUBLIC_URL"].replace(/\/$/, "");
    if (process.env["RENDER_EXTERNAL_URL"]) return process.env["RENDER_EXTERNAL_URL"].replace(/\/$/, "");
    const domains = process.env["REPLIT_DOMAINS"]?.split(",");
    if (domains?.[0]) return `https://${domains[0].trim()}`;
    if (process.env["REPLIT_DEV_DOMAIN"]) return `https://${process.env["REPLIT_DEV_DOMAIN"]}`;
    // Fallback: đọc từ bot-config.json (dành cho VPS/host tự quản)
    try {
      const cfg = JSON.parse(readFileSync(join(process.cwd(), "bot-config.json"), "utf8"));
      if (cfg.publicUrl && typeof cfg.publicUrl === "string" && cfg.publicUrl.startsWith("http")) {
        return cfg.publicUrl.replace(/\/$/, "");
      }
    } catch { /* file không tồn tại hoặc sai định dạng — bỏ qua */ }
    return "";
  }

  private async sendMainMenu(chatId: number, messageId?: number) {
    if (!this.bot) return;

    const keyboard = {
      keyboard: [
        [{ text: "👤 Hồ Sơ" }, { text: "🎮 Trò Chơi" }],
        [{ text: "🎁 Giới Thiệu" }, { text: "🏆 Xếp Hạng" }],
        [{ text: "🎊 Sự Kiện" }, { text: "💰 Hoa Hồng" }],
        [{ text: "🆘 Hỗ Trợ" }]
      ],
      resize_keyboard: true,
      one_time_keyboard: false,
    };

    await this.bot.sendMessage(chatId, `✨ Chọn chức năng bên dưới để bắt đầu.`, {
      reply_markup: keyboard,
    });
  }

  /**
   * Anti-spam check — returns true if the user is currently blocked.
   * Counts messages per user in a rolling window; after SPAM_MAX_MSGS exceeded
   * sends ONE warning then blocks for SPAM_BLOCK_MS.
   */
  private async checkSpam(chatId: number, userId: string): Promise<boolean> {
    const now = Date.now();

    // Already blocked?
    const unblockAt = this.spamBlocked.get(userId);
    if (unblockAt) {
      if (now < unblockAt) {
        // Still in block period — silently ignore
        return true;
      }
      // Block expired — clean up
      this.spamBlocked.delete(userId);
      this.spamCounter.delete(userId);
    }

    // Update rolling counter
    const entry = this.spamCounter.get(userId);
    if (!entry || now - entry.windowStart > this.SPAM_WINDOW_MS) {
      this.spamCounter.set(userId, { count: 1, windowStart: now });
      return false;
    }
    entry.count++;

    if (entry.count === this.SPAM_MAX_MSGS + 1) {
      // Progressive block duration based on offense count
      const offenses = (this.spamOffenses.get(userId) ?? 0) + 1;
      this.spamOffenses.set(userId, offenses);
      const blockDurations: number[] = [60_000, 300_000, 900_000, 1_800_000]; // 1m,5m,15m,30m
      const blockMs = blockDurations[Math.min(offenses - 1, blockDurations.length - 1)];
      const blockMinutes = blockMs / 60_000;
      const unblockTime = new Date(now + blockMs).toLocaleTimeString('vi-VN');
      const offenseText = offenses === 1
        ? '1️⃣ Lần đầu vi phạm — cảnh cáo 1 phút'
        : offenses === 2
          ? '2️⃣ Vi phạm lần 2 — chặn 5 phút'
          : offenses === 3
            ? '3️⃣ Vi phạm lần 3 — chặn 15 phút'
            : `🔴 Vi phạm lần ${offenses} — chặn 30 phút`;
      await this.bot!.sendMessage(chatId,
        `🚫 <b>CẢNH BÁO SPAM!</b>\n\n` +
        `Bạn đang gửi quá nhiều tin nhắn liên tục.\n` +
        `${offenseText}\n\n` +
        `⏱ Thời gian chặn: <b>${blockMinutes} phút</b>\n` +
        `🕐 Mở khóa lúc: <b>${unblockTime}</b>`,
        { parse_mode: 'HTML' }
      );
      this.spamBlocked.set(userId, now + blockMs);
      return true;
    }

    if (entry.count > this.SPAM_MAX_MSGS + 1) {
      return true; // Silently block after warning
    }

    return false;
  }

  private async handleCallbackQuery(chatId: number, userId: string, data: string, messageId?: number, queryId?: string) {
    if (!this.bot) return;

    // Prevent multiple rapid clicks - debouncing mechanism
    const interactionKey = `${userId}_${data}`;
    if (this.recentInteractions.has(interactionKey)) {
      return; // Ignore duplicate rapid clicks
    }
    this.recentInteractions.add(interactionKey);
    setTimeout(() => this.recentInteractions.delete(interactionKey), 2000); // 2 second cooldown

    // Handle copy functionality
    if (data.startsWith("copy:")) {
      const [, type, orderCode] = data.split(":");
      await this.handleCopyCallback(chatId, userId, type, orderCode);
      return;
    }

    // Handle card telco selection
    if (data.startsWith("card_telco_")) {
      const telco = data.replace("card_telco_", "") as SC68Telco;
      const cardSession = this.cardSessions.get(userId) ?? { step: "select_telco" as const, chatId };
      cardSession.telco = telco;
      cardSession.step = "select_amount";
      cardSession.chatId = chatId;
      this.cardSessions.set(userId, cardSession as any);
      await this.showCardAmountSelection(chatId, telco, messageId);
      return;
    }

    // Handle card amount selection
    if (data.startsWith("card_amount_")) {
      const amount = parseInt(data.replace("card_amount_", ""));
      const cardSession = this.cardSessions.get(userId);
      if (cardSession?.telco) {
        // Remove buttons immediately so user knows the tap was registered
        try {
          await this.bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: messageId });
        } catch { /* ignore if message already edited */ }
        cardSession.amount = amount;
        cardSession.step = "enter_card";
        this.cardSessions.set(userId, cardSession);
        await this.showCardInputPrompt(chatId, cardSession.telco, amount, messageId);
      }
      return;
    }

    // Handle gift code purchase
    if (data.startsWith("buygift_")) {
      // Step 1: quantity selection buygift_qty_N or buygift_qty_custom
      if (data.startsWith("buygift_qty_")) {
        if (data === "buygift_qty_custom") {
          await this.bot.sendMessage(chatId, "🔢 Nhập số lượng code bạn muốn mua (1-100):");
          this.customAmountWaiting.add(`buygift_qty_custom_${userId}`);
          return;
        }
        const qty = parseInt(data.split("_")[2]);
        if (!isNaN(qty) && qty > 0) {
          await this.showBuyGiftCodeAmounts(chatId, userId, qty, messageId);
        }
        return;
      }
      // Step 2: amount selection — format: buygift_{qty}_{amount|custom}
      const parts = data.split("_");
      if (parts.length === 3 && parts[0] === "buygift") {
        const qty = parseInt(parts[1]);
        if (parts[2] === "custom") {
          await this.bot.sendMessage(chatId, `💰 Nhập mệnh giá mỗi code (VNĐ):`);
          this.customAmountWaiting.add(`buygift_${qty}_${userId}`);
          return;
        }
        const unitAmount = parseInt(parts[2]);
        if (!isNaN(unitAmount) && unitAmount > 0) {
          await this.processBuyGiftCode(chatId, userId, qty, unitAmount);
          return;
        }
      }
      // Legacy fallback: buygift_custom (old flow)
      if (data === "buygift_custom") {
        await this.bot.sendMessage(chatId, "💰 Nhập mệnh giá gift code bạn muốn mua (VNĐ):");
        this.customAmountWaiting.add(`buygift_1_${userId}`);
        return;
      }
      return;
    }

    // Handle amount selection (both deposit and game betting)
    if (data.startsWith("amount_")) {
      if (data === "amount_custom") {
        const session = this.gameSessions.get(userId);
        const inDepositContext = !!this.paymentMethods.get(userId);
        
        if (session && session.betType && !inDepositContext) {
          // Game context with bet type selected - ask for bet amount
          await this.bot.sendMessage(chatId, "💰 Nhập số tiền bạn muốn cược:\n(Từ 5,000đ đến 10,000,000đ)");
          session.status = "waiting_amount";
          this.gameSessions.set(userId, session);
        } else if (inDepositContext) {
          // Deposit context - ask for deposit amount
          await this.bot.sendMessage(chatId, "💰 Nhập số tiền bạn muốn nạp (VNĐ):");
          this.customAmountWaiting.add(userId);
        } else if (session && session.gameType) {
          // Game session without bet type - guide to select bet type first
          await this.bot.sendMessage(chatId, `🎮 Bạn đang chơi **${session.gameType.toUpperCase()}**. Vui lòng chọn kiểu cược trước!`);
          await this.sendGameBettingOptions(chatId, session.gameType);
        } else {
          // No context - show games menu
          await this.bot.sendMessage(chatId, "❓ Vui lòng chọn game hoặc chức năng nạp tiền trước!");
          await this.showGamesMenu(chatId, messageId);
        }
        return;
      }
      
      const amount = parseInt(data.split("_")[1]);
      const session = this.gameSessions.get(userId);
      const inDepositContext = !!this.paymentMethods.get(userId);
      
      if (session && session.betType) {
        // Active game bet with bet type selected
        // xucxac: always skip emoji keyboard (bot rolls auto / player sends dice after processGameBet)
        // Other dice games (chanle, phitieu): keep emoji keyboard as trigger
        const skipKeyboard = session.gameType === "xucxac";
        if (!skipKeyboard && this.needsDiceEmojiButton(session.gameType)) {
          // Save amount to session and show dice emoji keyboard (player-controlled games)
          session.amount = amount;
          this.gameSessions.set(userId, session);
          await this.showDiceEmojiKeyboard(chatId, session.gameType);
        } else {
          // xucxac or other non-emoji games: process bet directly
          await this.processGameBet(chatId, userId, session, amount);
        }
      } else if (inDepositContext) {
        // Remove buttons immediately so user knows the tap was registered
        try {
          await this.bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: messageId });
        } catch { /* ignore if message already edited */ }
        // User is in explicit deposit context
        await this.createPaymentRequest(chatId, userId, amount);
      } else if (session && session.gameType) {
        // User has game session but no bet type selected - guide them back to betting options
        await this.bot.sendMessage(chatId, `🎮 Bạn đang chơi **${session.gameType.toUpperCase()}**. Vui lòng chọn kiểu cược trước!`);
        await this.sendGameBettingOptions(chatId, session.gameType, messageId);
      } else {
        // No context - shouldn't happen, but safe fallback
        await this.bot.sendMessage(chatId, "❓ Vui lòng chọn game hoặc chức năng nạp tiền trước!");
        await this.showGamesMenu(chatId, messageId);
      }
      return;
    }

    // Handle game betting
    if (data.startsWith("bet_")) {
      // Handle prediction buttons specially 
      if (data === "bet_prediction_total") {
        await this.bot.sendMessage(chatId, 
          "🔮 DỰ ĐOÁN TỔNG\n\n" +
          "Tính năng dự đoán tổng sẽ giúp bạn phân tích các phiên trước để đưa ra dự đoán chính xác hơn!\n\n" +
          "👉 Tham gia nhóm để sử dụng: https://t.me/TXCLHARU88"
        );
        return;
      }
      
      if (data === "bet_prediction_dice") {
        await this.bot.sendMessage(chatId, 
          "🎯 DỰ ĐOÁN XÚC XẮC\n\n" +
          "Tính năng dự đoán xúc xắc sẽ giúp bạn phân tích xu hướng của từng viên xúc xắc!\n\n" +
          "👉 Tham gia nhóm để sử dụng: https://t.me/TXCLHARU88"
        );
        return;
      }
      
      // Handle new room prediction buttons
      if (data === "bet_du_doan_tong") {
        await this.bot.sendMessage(chatId, 
          "🔮 GAME ĐOÁN TỔNG 3 XÚC XẮC TẠI ROOM\n\n" +
          "Chiến thắng khi tổng 3 viên xúc xắc là kết quả trùng số bạn chọn.\n" +
          "👉 Tỷ lệ trả thưởng:\n" +
          "• 4, 17 | 40\n" +
          "• 5, 16 | 18\n" +
          "• 6, 15 | 12\n" +
          "• 7, 14 | 8\n" +
          "• 8, 13 | 6\n" +
          "• 9, 12 | 5\n" +
          "• 10, 11 | 5\n\n" +
          "Lệnh cược: DDT [số chọn] [tiền chơi]\n" +
          "VD: DDT 11 20000"
        );
        return;
      }
      
      if (data === "bet_du_doan_xuc_xac") {
        await this.bot.sendMessage(chatId, 
          "🎲 GAME ĐOÁN XÚC XẮC TẠI ROOM\n\n" +
          "Chiến thắng khi 1 trong 3 viên xúc xắc có kết quả trùng số bạn chọn.\n" +
          "• Trùng 1 viên: 1 ĂN 2\n" +
          "• Trùng 2 viên: 1 ĂN 3\n" +
          "• Trùng 3 viên: 1 ĂN 4\n\n" +
          "Lệnh cược: D[số chọn 1-6] [tiền chơi]\n" +
          "VD: D6 20000"
        );
        return;
      }
      
      if (data === "bet_doan_xien") {
        await this.bot.sendMessage(chatId, 
          "🎲 ĐOÁN XIÊN XÚC XẮC ROOM 🎲\n\n" +
          "Nội dung |  Tổng điểm 3 XX Room  |  Tỷ lệ ăn\n" +
          " TL  |  11,13,15,17  |  x2.6\n" +
          " TC  |  12,14,16,18  |  x3.3\n" +
          " XL  |  3,5,7,9  |  x3.3\n" +
          " XC  |  4,6,8,10  |  x2.6\n\n" +
          "VD: TC 10000"
        );
        return;
      }

      // ─── xúc xắc throw-mode intercept ───
      if (data === "bet_bottung" || data === "bet_nguoitung") {
        const sess = this.gameSessions.get(userId);
        if (sess && sess.status === "betting" && sess.gameType === "xucxac") {
          sess.throwMode = data === "bet_bottung" ? "bot" : "player";
          this.gameSessions.set(userId, sess);
          await this.sendOrEditMessage(chatId,
            `🎲 <b>XÚC XẮC</b> — ${data === "bet_bottung" ? "🤖 Bot tung" : "👤 Bạn tung"}\n\nChọn <b>TÀI</b> (11-18) hoặc <b>XỈU</b> (3-10):`,
            { inline_keyboard: [[
              { text: "🔴 TÀI (11-18)", callback_data: "bet_xxt" },
              { text: "🔵 XỈU (3-10)", callback_data: "bet_xxx" }
            ]] },
            "HTML", messageId
          );
        }
        return;
      }

      // ─── trên/đúng/dưới continuation intercept ───
      if ((data === "bet_tren" || data === "bet_dung" || data === "bet_duoi")) {
        const sess = this.gameSessions.get(userId);
        if (sess && sess.status === "waiting_trenduoi_continue" && sess.amount) {
          // Encode ĐÚNG with last dice value
          const betKey = data === "bet_dung" ? `dung_${sess.lastDice1 || 4}` : data.substring(4);
          sess.betType = betKey;
          this.gameSessions.set(userId, sess);
          await this.processGameBet(chatId, userId, sess, sess.amount);
          return;
        }
      }

      // ─── do_tung_xx: player self-roll for xucxac ───
      if (data === "do_tung_xx") {
        const sess = this.gameSessions.get(userId);
        if (sess && sess.status === "waiting_player_roll" && sess.pendingGameSessionId !== undefined) {
          await this.completePendingXucXacBet(chatId, userId, sess);
        }
        return;
      }

      const session = this.gameSessions.get(userId);
      if (session && session.status === "betting") {
        session.betType = data.substring(4); // Remove "bet_" prefix
        this.gameSessions.set(userId, session);
        
        // Don't auto-send dice animation anymore, show amount selection instead
        await this.sendAmountSelection(chatId, session.gameType, messageId);
      }
      return;
    }

    // Handle miniapp game selection - show button first, then send mini app
    if (data.startsWith("miniapp_")) {
      const gameType = data.substring(8); // Remove "miniapp_" prefix
      let gameUrl = "";
      let gameName = "";
      const base = this.getPublicUrl();
      
      switch (gameType) {
        case "xocdia":
          gameUrl = `${base}/api/games/xoc-dia.html?tgid=${userId}`;
          gameName = "Xóc Đĩa";
          break;
        case "quaythu":
        case "quaythuong":
          gameUrl = `${base}/api/games/quay-thu.html?tgid=${userId}`;
          gameName = "Quay Thú";
          break;
        case "baucua":
          gameUrl = `${base}/api/games/bau-cua?tgid=${userId}`;
          gameName = "Bầu Cua";
          break;
        case "maybay":
          gameUrl = `${base}/api/games/may-bay?tgid=${userId}`;
          gameName = "Máy Bay";
          break;
        case "rongho":
        case "sicbo":
        case "xucxac":
          gameUrl = `${base}/api/games/xoc-dia.html?tgid=${userId}`;
          gameName = "Xóc Đĩa";
          break;
      }
      
      if (gameUrl) {
        const keyboard = {
          inline_keyboard: [
            [
              { text: `🎮 Chơi ${gameName}`, web_app: { url: gameUrl } }
            ]
          ]
        };
        
        await this.bot!.sendMessage(chatId,
          `🎮 <b>${gameName.toUpperCase()}</b>\n\n` +
          `✨ Nhấn nút bên dưới để chơi game!\n` +
          `🎯 Chúc bạn may mắn!`,
          {
            reply_markup: keyboard,
            parse_mode: "HTML"
          }
        );
      }
      return;
    }

    // Handle solo dice roll
    if (data.startsWith("solo_roll_")) {
      const roomCode = data.substring(10); // Remove "solo_roll_" prefix
      await this.processSoloDiceRoll(chatId, userId, roomCode);
      return;
    }

    // Handle "⚔️ Vào Phòng" button clicked in group — check balance then send deeplink
    if (data.startsWith("solo_join_")) {
      const roomCode = data.substring(10);
      const qid = queryId ?? "";
      try {
        const room = this.soloDiceRooms.get(roomCode);
        if (!room || room.status !== "waiting") {
          await this.bot.answerCallbackQuery(qid, {
            text: "❌ Phòng này đã kết thúc hoặc không còn tồn tại!",
            show_alert: true,
          });
          return;
        }
        if (room.players.length >= 2) {
          await this.bot.answerCallbackQuery(qid, {
            text: "❌ Phòng đã đủ 2 người chơi!",
            show_alert: true,
          });
          return;
        }
        if (room.players.some((p: any) => p.userId === userId)) {
          await this.bot.answerCallbackQuery(qid, {
            text: "❌ Bạn là chủ phòng này, không thể tự vào!",
            show_alert: true,
          });
          return;
        }
        const joinerData = await storage.getBotUser(userId);
        if (!joinerData) {
          await this.bot.answerCallbackQuery(qid, {
            text: "❌ Bạn chưa đăng ký! Hãy nhắn /start với bot trước.",
            show_alert: true,
          });
          return;
        }
        if (parseFloat(joinerData.balance || "0") < room.betAmount) {
          await this.bot.answerCallbackQuery(qid, {
            text: `❌ Số dư không đủ!\nCần: ${room.betAmount.toLocaleString()}đ\nSố dư: ${parseFloat(joinerData.balance || "0").toLocaleString()}đ`,
            show_alert: true,
          });
          return;
        }
        // Balance OK → open private chat with bot and auto-join via deeplink
        const deepLink = `https://t.me/${this.botUsername}?start=join_${roomCode}`;
        await this.bot.answerCallbackQuery(qid, { url: deepLink });
      } catch {
        await this.bot.answerCallbackQuery(qid, {
          text: "❌ Có lỗi xảy ra, thử lại!",
          show_alert: true,
        });
      }
      return;
    }

    // Handle game selection
    if (data.startsWith("play_")) {
      const gameType = data.substring(5); // Remove "play_" prefix
      this.paymentMethods.delete(userId); // Clear payment method when starting new game
      this.createGameSession(userId, gameType);
      await this.sendGameBettingOptions(chatId, gameType);
      return;
    }

    // Handle specific actions
    switch (data) {
      case "event_first_deposit_nap":
        this.firstDepositBonusActive.add(userId);
        await this.showDepositOptions(chatId, messageId);
        break;
      case "nap_tien":
        await this.showDepositOptions(chatId, messageId);
        break;
      case "claim_weekly_reward":
        await this.handleClaimWeeklyReward(chatId, userId);
        break;
      case "claim_daily_reward":
        await this.handleClaimDailyReward(chatId, userId);
        break;
      case "claim_all_gifts":
        await this.handleClaimAllGifts(chatId, userId);
        break;
      case "nap_bank":
        this.storePaymentMethod(userId, "bank");
        await this.showQuickAmountButtons(chatId, messageId);
        break;
      case "livechat_maintenance":
        await this.bot.sendMessage(chatId, "🔧 <b>Live Chat đang bảo trì</b>\n\nVui lòng liên hệ qua Telegram: @Hotroharu88bot", { parse_mode: "HTML" });
        break;
      case "main_menu":
        this.clearGameSession(userId);
        this.paymentMethods.delete(userId); // Clear payment method when going to main menu
        await this.sendMainMenu(chatId, messageId);
        break;
      case "games":
        this.paymentMethods.delete(userId); // Clear payment method when going to games menu
        await this.showGamesMenu(chatId, messageId);
        break;
      case "play_again":
        await this.handlePlayAgain(chatId, userId);
        break;
      case "back_to_games":
        this.clearGameSession(userId);
        this.paymentMethods.delete(userId); // Clear payment method when going back to games
        await this.showGamesMenu(chatId, messageId);
        break;
      case "bxh":
      case "leaderboard":
        await this.showLeaderboard(chatId, messageId);
        break;
      case "leaderboard_daily":
        await this.showLeaderboardDaily(chatId, userId);
        break;
      case "leaderboard_weekly":
        await this.showLeaderboardWeekly(chatId, userId);
        break;
      case "top_bet_daily":
        await this.showDailyBettingRankings(chatId, messageId);
        break;
      case "top_bet_weekly":
        await this.showWeeklyBettingRankings(chatId, messageId);
        break;
      case "top_cuoc_ngay":
        await this.showDailyBettingRankings(chatId, messageId);
        break;
      case "top_cuoc_tuan":
        await this.showWeeklyBettingRankings(chatId, messageId);
        break;
      case "rut_tien":
        await this.handleWithdraw(chatId, userId);
        break;
      case "nhapgiftcode":
        await this.bot.sendMessage(chatId, "🎁 Cách nhập giftcode:\n/code [dấu cách] mã giftcode\n\nVD: /code CODE123");
        break;
      case "lichsunap":
        await this.showDepositHistory(chatId, userId, messageId);
        break;
      case "lichsurut":
        await this.showWithdrawHistory(chatId, userId, messageId);
        break;
      case "lichsucuoc":
        await this.showGameHistory(chatId, userId, messageId);
        break;
      case "muagiftcode":
        await this.showBuyGiftCodeOptions(chatId, userId, messageId);
        break;
      case "homqua":
        await this.handleOnePieceTreasure(chatId, userId, messageId);
        break;
      case "chuyen_tien":
        await this.handleTransferMoney(chatId, userId, messageId);
        break;
      case "gift_guide":
        await this.showGiftGuide(chatId, messageId);
        break;
      case "vip_guide":
        await this.bot.sendMessage(chatId,
          `📖 <b>HƯỚNG DẪN ĐỔI ĐIỂM VIP</b>\n\n` +
          `Với mỗi <b>300,000đ</b> tiền cược, bạn sẽ được tặng thêm <b>1 điểm</b> cấp VIP.\n\n` +
          `📌 Điểm VIP dùng để:\n` +
          `• Nâng cấp bậc VIP (mở thêm tính năng)\n` +
          `• Đổi trực tiếp thành tiền mặt theo tỷ lệ từng cấp VIP\n\n` +
          `💸 <b>Tỷ lệ đổi điểm → tiền:</b>\n` +
          `🦐 VIP 1 — 100đ/điểm\n` +
          `🦀 VIP 2 — 200đ/điểm\n` +
          `🦞 VIP 3 — 300đ/điểm\n` +
          `🐬 VIP 4 — 400đ/điểm\n` +
          `🦈 VIP 5 — 500đ/điểm\n` +
          `🐋 VIP 6 — 600đ/điểm\n` +
          `🦑 VIP 7 — 700đ/điểm\n` +
          `🐳 VIP 8 — 800đ/điểm\n` +
          `🐉 VIP 9 — 1,000đ/điểm\n\n` +
          `💡 Dùng lệnh <code>/doidiemvip [số điểm]</code> để đổi điểm lấy tiền\n` +
          `Ví dụ: <code>/doidiemvip 100</code> → nhận 10,000đ (VIP 1)`,
          { parse_mode: 'HTML' }
        );
        break;
      case "close_message":
        try { await this.bot.deleteMessage(chatId, messageId!); } catch {}
        return;
      case "vip_info":
        await this.showVipInfo(chatId, userId);
        break;
      case "event_first_deposit":
        await this.showEventFirstDeposit(chatId);
        break;
      case "event_referral":
        await this.showEventReferral(chatId);
        break;
      case "event_du_day":
        await this.showEventDuDay(chatId);
        break;
      case "event_tich_luy_nap":
        await this.showEventTichLuyNap(chatId, userId);
        break;
      case "event_daily_top":
        await this.showEventDailyTop(chatId);
        break;
      case "event_weekly_top":
        await this.showEventWeeklyTop(chatId);
        break;
      case "event_attendance":
        await this.showEventAttendance(chatId, userId);
        break;
      case "attendance_checkin":
        await this.handleAttendanceCheckIn(chatId, userId);
        break;
      case "attendance_rules":
        await this.bot.sendMessage(chatId,
          `📜 <b>ĐIỀU KIỆN THAM GIA ĐIỂM DANH</b>\n\n` +
          `1️⃣ Tên Telegram phải chứa <b>HARU88 FAN</b>\n` +
          `   (VD: Nguyen Van A HARU88 FAN)\n\n` +
          `2️⃣ Phải có ít nhất 1 lần nạp tiền trong <b>7 ngày</b> gần nhất\n\n` +
          `3️⃣ Điểm danh <b>mỗi ngày 1 lần</b>\n\n` +
          `4️⃣ Đủ <b>7 ngày liên tiếp</b> sẽ nhận ngay <b>35,000đ</b> vào 🧧 LÌ XÌ\n\n` +
          `⚠️ <i>Bỏ lỡ 1 ngày = reset chuỗi, phải bắt đầu lại!</i>`,
          { parse_mode: 'HTML' }
        );
        break;
      case "rut_bank":
        await this.showWithdrawBank(chatId, userId, messageId);
        break;
      case "rut_card":
        await this.bot.sendMessage(chatId, "🔧 Rút Thẻ Cào đang bảo trì. Vui lòng sử dụng phương thức khác!");
        break;
      case "nap_card":
        this.paymentMethods.set(userId, "card");
        await this.showCardTelcoSelection(chatId, messageId);
        break;
      case "card_history":
        await this.showCardHistory(chatId, userId, messageId);
        break;
      case "play_bowling":
        await this.bot.sendMessage(chatId,
          `🎳 <b>BOWLING</b>\n\n` +
          `Cách chơi: gõ lệnh với số tiền cược\n\n` +
          `<b>Loại cược:</b>\n` +
          `• <code>BC [tiền]</code> — Chẵn (ki còn: 0, 2, 6) x1.95\n` +
          `• <code>BL [tiền]</code> — Lẻ (ki còn: 1, 3, 5) x1.95\n` +
          `• <code>BX [tiền]</code> — Xanh/Nhỏ (ki còn: 0-2) x1.95\n` +
          `• <code>BT [tiền]</code> — Tím/To (ki còn: 3-6) x1.95\n\n` +
          `<b>Ví dụ:</b> <code>BC 10000</code>\n\n` +
          `💰 Cược tối thiểu: 1,000đ | Tối đa: 300,000đ`,
          { parse_mode: 'HTML' }
        );
        break;
      case "play_basketball":
        await this.bot.sendMessage(chatId,
          `🏀 <b>BÓNG RỔ</b>\n\n` +
          `Cách chơi: gõ lệnh <code>BR [số tiền]</code>\n\n` +
          `<b>Luật chơi:</b>\n` +
          `• Telegram tung bóng rổ 🏀\n` +
          `• Vào rổ (value 4 hoặc 5) → <b>THẮNG x2.3</b>\n` +
          `• Trượt rổ (value 1, 2, 3) → Thua\n\n` +
          `<b>Ví dụ:</b> <code>BR 10000</code>\n\n` +
          `💰 Cược tối thiểu: 1,000đ | Tối đa: 300,000đ`,
          { parse_mode: 'HTML' }
        );
        break;
      case "play_football":
        await this.bot.sendMessage(chatId,
          `⚽ <b>BÓNG ĐÁ</b>\n\n` +
          `Cách chơi: gõ lệnh <code>BD [số tiền]</code>\n\n` +
          `<b>Luật chơi:</b>\n` +
          `• Telegram sút bóng ⚽\n` +
          `• Vào lưới (value 4 hoặc 5) → <b>THẮNG x2.3</b>\n` +
          `• Ra ngoài (value 1, 2, 3) → Thua\n\n` +
          `<b>Ví dụ:</b> <code>BD 10000</code>\n\n` +
          `💰 Cược tối thiểu: 1,000đ | Tối đa: 300,000đ`,
          { parse_mode: 'HTML' }
        );
        break;
      default:
        await this.bot.sendMessage(chatId, "❓ Tính năng đang phát triển...");
    }
  }

  private async handleTextMessage(chatId: number, userId: string, text: string) {
    if (!this.bot) return;

    // Handle menu buttons
    switch (text) {
      case "👤 Hồ Sơ":
        await this.showAccountMenu(chatId, userId);
        return;
      case "🎮 Trò Chơi":
        await this.showGamesMenu(chatId);
        return;
      case "👥 Giới Thiệu":
      case "🎁 Giới Thiệu":
        await this.showReferralInfo(chatId, userId);
        return;
      case "🏆 Xếp Hạng":
        await this.showLeaderboard(chatId);
        return;
      case "🎊 Sự Kiện":
        await this.showEvents(chatId);
        return;
      case "💰 Hoa Hồng":
        await this.showCommissionInfo(chatId, userId);
        return;
      case "🆘 Hỗ Trợ":
        await this.showSupport(chatId);
        return;
      case "🆘 Hỗ trợ":
        await this.showSupport(chatId);
        return;
    }

    // Handle dice emoji button press (user clicked the keyboard button)
    const session = this.gameSessions.get(userId);
    if (session && this.needsDiceEmojiButton(session.gameType)) {
      const diceEmoji = this.getDiceEmojiForGame(session.gameType);
      // Check if user sent the expected emoji (with or without amount set)
      if (text === diceEmoji || text.trim() === diceEmoji) {
        // If amount is already set, process the bet
        if (session.amount) {
          await this.processGameBet(chatId, userId, session, session.amount);
          return;
        } else {
          // Amount not set yet - ask user to select amount first
          await this.bot.sendMessage(chatId, "⚠️ Vui lòng chọn số tiền cược trước khi chơi!");
          await this.sendAmountSelection(chatId, session.gameType);
          return;
        }
      }
    }

    // Handle custom amount input
    if (session && session.status === "waiting_amount") {
      const amount = parseInt(text.replace(/[^\d]/g, ""));
      if (amount >= 5000 && amount <= 10000000) {
        await this.processGameBet(chatId, userId, session, amount);
      } else {
        await this.bot.sendMessage(chatId, "⚠️ Số tiền không hợp lệ! Vui lòng nhập từ 5,000đ đến 10,000,000đ");
      }
      return;
    }

    // Handle gift code input
    if (this.customAmountWaiting.has(`gift_${userId}`)) {
      this.customAmountWaiting.delete(`gift_${userId}`);
      await this.redeemGiftCode(chatId, userId, text.trim().toUpperCase());
      return;
    }

    // Handle custom quantity input for buy gift code
    if (this.customAmountWaiting.has(`buygift_qty_custom_${userId}`)) {
      this.customAmountWaiting.delete(`buygift_qty_custom_${userId}`);
      const qty = parseInt(text.replace(/[^\d]/g, ""));
      if (qty >= 1 && qty <= 100) {
        await this.showBuyGiftCodeAmounts(chatId, userId, qty);
      } else {
        await this.bot.sendMessage(chatId, "⚠️ Số lượng phải từ 1 đến 100");
      }
      return;
    }

    // Handle gift code purchase amount input (format: buygift_{qty}_{userId})
    const buygiftAmtKey = Array.from(this.customAmountWaiting).find(
      k => k.startsWith("buygift_") && k.endsWith(`_${userId}`) && !k.includes("qty_custom")
    );
    if (buygiftAmtKey) {
      this.customAmountWaiting.delete(buygiftAmtKey);
      const keyParts = buygiftAmtKey.split("_");
      const qty = parseInt(keyParts[1]) || 1;
      const unitAmount = parseInt(text.replace(/[^\d]/g, ""));
      if (unitAmount >= 10000) {
        await this.processBuyGiftCode(chatId, userId, qty, unitAmount);
      } else {
        await this.bot.sendMessage(chatId, "⚠️ Mệnh giá tối thiểu là 10,000đ");
      }
      return;
    }
    // Legacy: old key format buygift_{userId}
    if (this.customAmountWaiting.has(`buygift_${userId}`)) {
      this.customAmountWaiting.delete(`buygift_${userId}`);
      const amount = parseInt(text.replace(/[^\d]/g, ""));
      if (amount >= 10000) {
        await this.processBuyGiftCode(chatId, userId, 1, amount);
      } else {
        await this.bot.sendMessage(chatId, "⚠️ Mệnh giá tối thiểu là 10,000đ");
      }
      return;
    }

    // Handle card info input (SERIAL CODE)
    const cardSession = this.cardSessions.get(userId);
    if (cardSession?.step === "enter_card" && cardSession.telco && cardSession.amount) {
      await this.handleCardInput(chatId, userId, text, cardSession.telco, cardSession.amount);
      return;
    }

    // Handle deposit amount input
    if (this.customAmountWaiting.has(userId)) {
      this.customAmountWaiting.delete(userId);
      const amount = parseInt(text.replace(/[^\d]/g, ""));
      if (amount >= 5000) {
        await this.createPaymentRequest(chatId, userId, amount);
      } else {
        await this.bot.sendMessage(chatId, "⚠️ Số tiền tối thiểu là 5,000đ");
      }
      return;
    }

    // Handle tài xỉu room betting commands (t 10000, x 5000, c 20000, etc.)
    // Only allow in private chat (not in group -1003132451812, that's handled by bot2)
    const bettingMatch = text.trim().match(/^(t|x|c|l|mc|ml|mt|mx|tc|tl|xc|xl)\s+(\d+|max)$/i);
    if (bettingMatch && chatId > 0) {
      const betType = bettingMatch[1].toUpperCase();
      const betAmountText = bettingMatch[2].toLowerCase();
      
      try {
        // Get user data for balance check
        const userData = await storage.getBotUser(userId);
        if (!userData) {
          await this.bot.sendMessage(chatId, "❌ Không tìm thấy thông tin tài khoản. Vui lòng dùng /start để đăng ký.");
          return;
        }

        const currentBalance = parseFloat(userData.balance || "0");
        let betAmount: number;

        // Handle "max" betting
        if (betAmountText === "max") {
          betAmount = Math.min(Math.floor(currentBalance), 1000000); // Max bet limit 1M VND
        } else {
          betAmount = parseInt(betAmountText);
        }

        // Validate bet amount
        if (isNaN(betAmount) || betAmount <= 0) {
          await this.bot.sendMessage(chatId, "❌ Số tiền cược không hợp lệ!");
          return;
        }

        const minBet = await getSettingNumber('min_bet', 1000);
        const maxBet = await getSettingNumber('max_bet', 1000000);
        if (betAmount < minBet) {
          await this.bot.sendMessage(chatId, `❌ Số tiền cược tối thiểu là ${minBet.toLocaleString('vi-VN')}đ!`);
          return;
        }

        if (betAmount > maxBet) {
          await this.bot.sendMessage(chatId, `❌ Số tiền cược tối đa là ${maxBet.toLocaleString('vi-VN')}đ!`);
          return;
        }

        if (betAmount > currentBalance) {
          await this.bot.sendMessage(chatId, 
            `❌ Số dư không đủ!\n\n` +
            `💰 Số dư hiện tại: ${currentBalance.toLocaleString('vi-VN')}đ\n` +
            `🎯 Số tiền muốn cược: ${betAmount.toLocaleString('vi-VN')}đ`
          );
          return;
        }

        // BALANCE VALIDATION SYSTEM: Main bot checks balance first, then sends to bot2
        // Send bet to bot2 with atomic balance validation
        const betSuccess = await this.sendBetToBot2(userId, betType, betAmount);
        
        if (betSuccess) {
          // Get updated balance after successful bet
          const updatedUserData = await storage.getBotUser(userId);
          const newBalance = updatedUserData ? parseFloat(updatedUserData.balance || "0") : 0;
          
          // Send success message to user
          const betTypeDisplay = this.getBetTypeDisplay(betType);
          await this.bot.sendMessage(chatId,
            `✅ ĐẶT CƯỢC THÀNH CÔNG!\n\n` +
            `🎯 Loại cược: ${betTypeDisplay}\n` +
            `💰 Số tiền: ${betAmount.toLocaleString('vi-VN')}đ\n` +
            `💎 Số dư còn lại: ${newBalance.toLocaleString('vi-VN')}đ\n\n` +
            `🏠 Cược của bạn đã được gửi đến phòng Tài Xỉu (ẩn danh)\n` +
            `⏳ Chờ kết quả quay số...`
          );
        } else {
          // Balance was already restored by sendBetToBot2 if needed
          await this.bot.sendMessage(chatId, "❌ Không thể đặt cược lúc này. Vui lòng thử lại sau!");
        }
      } catch (error) {
        console.error('Error processing betting command:', error);
        await this.bot.sendMessage(chatId, "❌ Có lỗi xảy ra khi đặt cược. Vui lòng thử lại sau!");
      }
      return;
    }

    // Handle DDT command (dự đoán tổng) - works in private chat
    const ddtMatch = text.trim().match(/^ddt\s+(\d+)\s+(\d+)$/i);
    if (ddtMatch && chatId > 0) {
      const targetTotal = parseInt(ddtMatch[1]);
      const amount = parseInt(ddtMatch[2]);
      
      if (targetTotal < 3 || targetTotal > 18) {
        await this.bot!.sendMessage(chatId, "❌ Tổng dự đoán phải từ 3 đến 18!");
        return;
      }
      
      // Send to bot2 for total prediction
      await this.sendBetToBot2(userId, `ddt_${targetTotal}`, amount);
      return;
    }
    
    // Handle D[số] command (đoán xúc xắc D-game) - works in private chat
    // VD: d6 20000 hoặc D3 50000
    const diceMatch = text.trim().match(/^d([1-6])\s+(\d+)$/i);
    if (diceMatch && chatId > 0) {
      const diceNumber = parseInt(diceMatch[1]);
      const amount = parseInt(diceMatch[2]);

      {
        const minBetD = await getSettingNumber('min_bet', 1000);
        const maxBetD = await getSettingNumber('max_bet', 1000000);
        if (amount < minBetD) {
          await this.bot!.sendMessage(chatId, `❌ Tiền cược tối thiểu là ${minBetD.toLocaleString('vi-VN')}đ!`);
          return;
        }
        if (amount > maxBetD) {
          await this.bot!.sendMessage(chatId, `❌ Tiền cược tối đa là ${maxBetD.toLocaleString('vi-VN')}đ!`);
          return;
        }
      }

      const userDataD = await storage.getBotUser(userId);
      if (!userDataD) {
        await this.bot!.sendMessage(chatId, "❌ Tài khoản không tồn tại. Gõ /start để đăng ký.");
        return;
      }
      const balD = parseFloat(userDataD.balance || "0");
      if (balD < amount) {
        await this.bot!.sendMessage(chatId,
          `❌ SỐ DƯ KHÔNG ĐỦ!\n💎 Số dư: ${balD.toLocaleString('vi-VN')}đ\n💰 Cần: ${amount.toLocaleString('vi-VN')}đ`
        );
        return;
      }

      const betSuccess = await this.sendBetToBot2(userId, `D_${diceNumber}`, amount);
      if (betSuccess) {
        const updatedD = await storage.getBotUser(userId);
        const newBalD = parseFloat(updatedD?.balance || "0");
        await this.bot!.sendMessage(chatId,
          `✅ ĐẶT CƯỢC THÀNH CÔNG!\n\n` +
          `🎲 Loại cược: ĐOÁN XÚC XẮC SỐ ${diceNumber}\n` +
          `• Trùng 1 viên: 1 ĂN 2\n` +
          `• Trùng 2 viên: 1 ĂN 3\n` +
          `• Trùng 3 viên: 1 ĂN 4\n` +
          `💰 Số tiền: ${amount.toLocaleString('vi-VN')}đ\n` +
          `💎 Số dư còn lại: ${newBalD.toLocaleString('vi-VN')}đ\n\n` +
          `🏠 Cược đã gửi đến phòng TX (ẩn danh)\n` +
          `⏳ Chờ kết quả quay số...`
        );
      }
      return;
    }

    // ========== LÔ ĐỀ COMMANDS ==========
    // LO [số1,số2,...] [tiền] — hỗ trợ 1 hoặc nhiều số cách nhau bởi dấu phẩy/khoảng trắng
    // VD: LO 79 10000 | LO 23,45,67 10000 | LO 01 05 99 20000
    const loMatch = text.trim().match(/^(?:\/)?lo\s+([\d,\s]+?)\s+(\d+)$/i);
    if (loMatch && chatId > 0) {
      const rawNums = loMatch[1].split(/[,\s]+/).map(s => s.trim()).filter(s => /^\d{1,2}$/.test(s));
      const amount = parseInt(loMatch[2]);
      if (rawNums.length === 0) {
        await this.bot!.sendMessage(chatId, "❌ Số không hợp lệ! VD: <code>LO 23 10000</code> hoặc <code>LO 23,45,67 10000</code>", { parse_mode: 'HTML' });
        return;
      }
      const numbers = [...new Set(rawNums.map(n => n.padStart(2, '0')))];
      await this.handleLodeBetMulti(chatId, userId, 'lo', numbers, amount);
      return;
    }

    // DE [số1,số2,...] [tiền] — hỗ trợ 1 hoặc nhiều số
    const deMatch = text.trim().match(/^(?:\/)?de\s+([\d,\s]+?)\s+(\d+)$/i);
    if (deMatch && chatId > 0) {
      const rawNums = deMatch[1].split(/[,\s]+/).map(s => s.trim()).filter(s => /^\d{1,2}$/.test(s));
      const amount = parseInt(deMatch[2]);
      if (rawNums.length === 0) {
        await this.bot!.sendMessage(chatId, "❌ Số không hợp lệ! VD: <code>DE 45 50000</code> hoặc <code>DE 45,67 50000</code>", { parse_mode: 'HTML' });
        return;
      }
      const numbers = [...new Set(rawNums.map(n => n.padStart(2, '0')))];
      await this.handleLodeBetMulti(chatId, userId, 'de', numbers, amount);
      return;
    }

    // XSMB — xem kết quả hôm nay
    if ((text.trim().toLowerCase() === 'xsmb' || text.trim().toLowerCase() === '/xsmb') && chatId > 0) {
      await this.showXSMBResult(chatId);
      return;
    }

    // CUOCLO — xem các cược lô đề đang chờ của mình
    if ((text.trim().toLowerCase() === 'cuoclo' || text.trim().toLowerCase() === '/cuoclo') && chatId > 0) {
      await this.showMyLodeBets(chatId, userId);
      return;
    }
    // ========== END LÔ ĐỀ COMMANDS ==========

    // Handle Football commands: BD [tiền] hoặc /bd [tiền]
    const footballMatch = text.trim().match(/^(?:\/)?bd\s+(\d+)$/i);
    if (footballMatch && chatId > 0) {
      const amount = parseInt(footballMatch[1]);
      
      try {
        const userData = await storage.getBotUser(userId);
        if (!userData) {
          await this.bot.sendMessage(chatId, "❌ Không tìm thấy thông tin tài khoản.");
          return;
        }

        const currentBalance = parseFloat(userData.balance || "0");
        {
          const minBetF = await getSettingNumber('min_bet', 1000);
          const maxBetF = await getSettingNumber('max_bet', 1000000);
          if (amount < minBetF || amount > maxBetF) {
            await this.bot.sendMessage(chatId, `❌ Số tiền cược phải từ ${minBetF.toLocaleString('vi-VN')}đ đến ${maxBetF.toLocaleString('vi-VN')}đ!`);
            return;
          }
        }

        if (amount > currentBalance) {
          await this.bot.sendMessage(chatId, 
            `❌ Số dư không đủ!\n💰 Số dư hiện tại: ${currentBalance.toLocaleString('vi-VN')}đ`
          );
          return;
        }

        // Deduct balance
        const newBalance = (currentBalance - amount).toString();
        await storage.updateBotUser(userId, { balance: newBalance });

        // Track betting stats for leaderboard
        try {
          const _now = this.nowVN();
          const _dateStr = `${_now.getFullYear()}-${String(_now.getMonth() + 1).padStart(2, '0')}-${String(_now.getDate()).padStart(2, '0')}`;
          const _wk = this.getWeekNumber(_now);
          const _weekStr = `${_now.getFullYear()}-W${String(_wk).padStart(2, '0')}`;
          await storage.createOrUpdateBettingStats(userId, _dateStr, _weekStr, amount);
        } catch (_e) { /* non-critical */ }

        // Send football emoji
        const footballMsg = await this.bot.sendDice(chatId, { emoji: "⚽" });
        const result = footballMsg.dice!.value; // Telegram ⚽ returns 1-5: 3,4,5=goal 1,2=miss

        await new Promise(resolve => setTimeout(resolve, 4000)); // Wait for animation

        const isGoal = result >= 3; // Telegram ⚽: value 3,4,5 = bóng vào lưới; 1,2 = ra ngoài

        if (isGoal) {
          const houseEdgeF = await getSettingNumber('house_edge', 2.5);
          const footballMult = parseFloat((2.5 * (1 - houseEdgeF / 100)).toFixed(4));
          const winAmount = Math.floor(amount * footballMult);
          const finalBalance = (parseFloat(newBalance) + winAmount).toString();
          await storage.updateBotUser(userId, { balance: finalBalance });
          
          await this.bot.sendMessage(chatId,
            `⚽️ <b>BÓNG ĐÁ - CHIẾN THẮNG!</b>\n\n` +
            `🎯 Kết quả: ⚽ VÀO LƯỚI! <code>[dice=${result}]</code>\n` +
            `💰 Cược: ${amount.toLocaleString('vi-VN')}đ\n` +
            `🎉 Thắng: ${winAmount.toLocaleString('vi-VN')}đ (x${footballMult})\n` +
            `💎 Số dư: ${parseFloat(finalBalance).toLocaleString('vi-VN')}đ`,
            { parse_mode: 'HTML' }
          );
        } else {
          await this.bot.sendMessage(chatId,
            `⚽️ <b>BÓNG ĐÁ - THUA!</b>\n\n` +
            `🎯 Kết quả: ❌ RA NGOÀI! <code>[dice=${result}]</code>\n` +
            `💰 Cược: ${amount.toLocaleString('vi-VN')}đ\n` +
            `😢 Thua: ${amount.toLocaleString('vi-VN')}đ\n` +
            `💎 Số dư: ${parseFloat(newBalance).toLocaleString('vi-VN')}đ`,
            { parse_mode: 'HTML' }
          );
        }
      } catch (error) {
        console.error('Error in football game:', error);
        await this.bot.sendMessage(chatId, "❌ Có lỗi xảy ra!");
      }
      return;
    }

    // Handle Basketball commands: BR [tiền] hoặc /br [tiền]
    const basketballMatch = text.trim().match(/^(?:\/)?br\s+(\d+)$/i);
    if (basketballMatch && chatId > 0) {
      const amount = parseInt(basketballMatch[1]);
      
      try {
        const userData = await storage.getBotUser(userId);
        if (!userData) {
          await this.bot.sendMessage(chatId, "❌ Không tìm thấy thông tin tài khoản.");
          return;
        }

        const currentBalance = parseFloat(userData.balance || "0");
        {
          const minBetBk = await getSettingNumber('min_bet', 1000);
          const maxBetBk = await getSettingNumber('max_bet', 1000000);
          if (amount < minBetBk || amount > maxBetBk) {
            await this.bot.sendMessage(chatId, `❌ Số tiền cược phải từ ${minBetBk.toLocaleString('vi-VN')}đ đến ${maxBetBk.toLocaleString('vi-VN')}đ!`);
            return;
          }
        }

        if (amount > currentBalance) {
          await this.bot.sendMessage(chatId, 
            `❌ Số dư không đủ!\n💰 Số dư hiện tại: ${currentBalance.toLocaleString('vi-VN')}đ`
          );
          return;
        }

        // Deduct balance
        const newBalance = (currentBalance - amount).toString();
        await storage.updateBotUser(userId, { balance: newBalance });

        // Track betting stats for leaderboard
        try {
          const _now = this.nowVN();
          const _dateStr = `${_now.getFullYear()}-${String(_now.getMonth() + 1).padStart(2, '0')}-${String(_now.getDate()).padStart(2, '0')}`;
          const _wk = this.getWeekNumber(_now);
          const _weekStr = `${_now.getFullYear()}-W${String(_wk).padStart(2, '0')}`;
          await storage.createOrUpdateBettingStats(userId, _dateStr, _weekStr, amount);
        } catch (_e) { /* non-critical */ }

        // Send basketball emoji
        const basketballMsg = await this.bot.sendDice(chatId, { emoji: "🏀" });
        const result = basketballMsg.dice!.value; // Telegram 🏀 returns 1-5: 3,4,5=basket 1,2=miss

        await new Promise(resolve => setTimeout(resolve, 4000)); // Wait for animation

        const isBasket = result >= 3; // Telegram 🏀: value 3,4,5 = bóng vào rổ; 1,2 = trượt

        if (isBasket) {
          const houseEdgeBk = await getSettingNumber('house_edge', 2.5);
          const basketMult = parseFloat((2.5 * (1 - houseEdgeBk / 100)).toFixed(4));
          const winAmount = Math.floor(amount * basketMult);
          const finalBalance = (parseFloat(newBalance) + winAmount).toString();
          await storage.updateBotUser(userId, { balance: finalBalance });
          
          await this.bot.sendMessage(chatId,
            `🏀 <b>BÓNG RỔ - CHIẾN THẮNG!</b>\n\n` +
            `🎯 Kết quả: 🏀 VÀO RỔ! <code>[dice=${result}]</code>\n` +
            `💰 Cược: ${amount.toLocaleString('vi-VN')}đ\n` +
            `🎉 Thắng: ${winAmount.toLocaleString('vi-VN')}đ (x${basketMult})\n` +
            `💎 Số dư: ${parseFloat(finalBalance).toLocaleString('vi-VN')}đ`,
            { parse_mode: 'HTML' }
          );
        } else {
          await this.bot.sendMessage(chatId,
            `🏀 <b>BÓNG RỔ - THUA!</b>\n\n` +
            `🎯 Kết quả: ❌ TRƯỢT RỔ! <code>[dice=${result}]</code>\n` +
            `💰 Cược: ${amount.toLocaleString('vi-VN')}đ\n` +
            `😢 Thua: ${amount.toLocaleString('vi-VN')}đ\n` +
            `💎 Số dư: ${parseFloat(newBalance).toLocaleString('vi-VN')}đ`,
            { parse_mode: 'HTML' }
          );
        }
      } catch (error) {
        console.error('Error in basketball game:', error);
        await this.bot.sendMessage(chatId, "❌ Có lỗi xảy ra!");
      }
      return;
    }

    // ══════════════════════════════════════════════════
    //  SOLO DICE — /solo <amount> | /mophong <amount>
    // ══════════════════════════════════════════════════
    const soloCreateMatch = text.trim().match(/^\/(?:solo|mophong)\s+(\d+)$/i);
    if (soloCreateMatch && chatId > 0) {
      const betAmount = parseInt(soloCreateMatch[1]);
      if (betAmount < 5000) {
        await this.bot.sendMessage(chatId, "❌ Số tiền tối thiểu là 5,000đ!");
        return;
      }
      try {
        // Chặn tạo nhiều phòng cùng lúc
        const existingRoom = [...this.soloDiceRooms.values()].find(
          (r: any) => r.creator === userId && r.status === "waiting"
        );
        if (existingRoom) {
          await this.bot.sendMessage(chatId,
            `❌ Bạn đã có phòng đang chờ!\n🔑 Mã: <code>${existingRoom.code}</code>\n💰 Cược: <b>${existingRoom.betAmount.toLocaleString()}đ</b>\n\nDùng <code>/huy ${existingRoom.code}</code> để huỷ trước khi tạo phòng mới.`,
            { parse_mode: 'HTML' }
          );
          return;
        }

        const userData = await storage.getBotUser(userId);
        if (!userData) {
          await this.bot.sendMessage(chatId, "❌ Không tìm thấy thông tin tài khoản.");
          return;
        }
        if (parseFloat(userData.balance || "0") < betAmount) {
          await this.bot.sendMessage(chatId, "❌ Số dư không đủ để tạo phòng!");
          return;
        }

        // Deduct balance (hold bet)
        const newBal = (parseFloat(userData.balance || "0") - betAmount).toString();
        await storage.updateBotUser(userId, { balance: newBal });

        // Generate HARU88-XXXXXX code
        const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
        let code = "HARU88-";
        for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];

        this.soloDiceRooms.set(code, {
          code,
          creator: userId,
          creatorChatId: chatId,
          betAmount,
          players: [{ userId, chatId, rolled: false, total: 0 }],
          status: "waiting",
          createdAt: Date.now()
        });

        const isPrivateMode = /^\/mophong/i.test(text.trim()); // /mophong = riêng tư, /solo = đăng nhóm

        // Thông báo cho chủ phòng
        if (isPrivateMode) {
          // /mophong: chơi riêng với bạn bè — không đăng nhóm
          await this.bot.sendMessage(chatId,
            `🔒 <b>PHÒNG RIÊNG TƯ</b>\n\n` +
            `✅ Đã tạo phòng thành công!\n` +
            `🔑 Mã phòng: <code>${code}</code>\n` +
            `💰 Mức cược: <b>${betAmount.toLocaleString()}đ</b>\n\n` +
            `👥 Người chơi: 1/2\n\n` +
            `📨 Gửi mã cho bạn bè để tham gia:\n` +
            `<code>/vao ${code}</code>\n\n` +
            `❌ Hủy phòng: <code>/huy ${code}</code>\n\n` +
            `💡 Phòng này <b>không được đăng lên nhóm</b> — chỉ người có mã mới vào được.`,
            { parse_mode: 'HTML' }
          );
        } else {
          // /solo: đăng lên nhóm để tìm đối thủ
          await this.bot.sendMessage(chatId,
            `🎲 <b>PHÒNG SOLO XÚC XẮC</b>\n\n` +
            `✅ Đã tạo phòng thành công!\n` +
            `🔑 Mã phòng: <code>${code}</code>\n` +
            `💰 Mức cược: <b>${betAmount.toLocaleString()}đ</b>\n\n` +
            `👥 Người chơi: 1/2\n` +
            `📋 Bạn bè tham gia: <code>/vao ${code}</code>\n` +
            `❌ Hủy phòng: <code>/huy ${code}</code>\n\n` +
            `📢 Đã đăng lên nhóm để tìm đối thủ!`,
            { parse_mode: 'HTML' }
          );
          // Announce to main group (chỉ /solo) — dùng nút "Vào Phòng" thay vì text
          try {
            const MAIN_GROUP = -1003132451812;
            const creatorData = await storage.getBotUser(userId);
            const groupMsg = await this.bot.sendMessage(MAIN_GROUP,
              `⚔️ <b>PHÒNG SOLO MỚI!</b>\n\n` +
              `🔑 Mã: <code>${code}</code>\n` +
              `💰 Mức cược: <b>${betAmount.toLocaleString()}đ</b>\n` +
              `👤 Chủ phòng: @${creatorData?.username || userId}\n\n` +
              `👇 Nhấn nút để vào phòng (bot tự kiểm tra số dư):`,
              {
                parse_mode: 'HTML',
                reply_markup: { inline_keyboard: [[
                  { text: "⚔️ Vào Phòng", callback_data: `solo_join_${code}` }
                ]] }
              }
            );
            // Lưu messageId để xoá khi có người vào
            const room = this.soloDiceRooms.get(code);
            if (room) {
              room.groupMessageId = groupMsg.message_id;
              room.groupChatId = MAIN_GROUP;
              this.soloDiceRooms.set(code, room);
            }
          } catch { /* group send optional */ }
        }

      } catch (error) {
        console.error('Error creating solo dice room:', error);
        await this.bot.sendMessage(chatId, "❌ Có lỗi xảy ra!");
      }
      return;
    }

    // /solo or /mophong without amount — show guide
    if (text.trim().match(/^\/(?:solo|mophong)$/i) && chatId > 0) {
      const isMophong = /^\/mophong$/i.test(text.trim());
      if (isMophong) {
        await this.bot.sendMessage(chatId,
          `🔒 <b>MỞ PHÒNG RIÊNG TƯ</b>\n\n` +
          `Cú pháp: <code>/mophong [số tiền]</code>\n` +
          `VD: <code>/mophong 50000</code>\n\n` +
          `• Tạo phòng riêng → gửi mã cho bạn bè\n` +
          `• Bạn bè dùng: <code>/vao HARU88-XXXXXX</code>\n` +
          `• Ai tổng 3 xúc xắc cao hơn THẮNG (x1.9)\n\n` +
          `🔕 <b>Phòng không được đăng lên nhóm</b> — chỉ người có mã mới vào được.`,
          { parse_mode: 'HTML' }
        );
      } else {
        await this.bot.sendMessage(chatId,
          `🎲 <b>SOLO XÚC XẮC (TÌM ĐỐI THỦ)</b>\n\n` +
          `Cú pháp: <code>/solo [số tiền]</code>\n` +
          `VD: <code>/solo 50000</code>\n\n` +
          `• Tạo phòng → đăng lên nhóm tìm đối thủ\n` +
          `• Đối thủ dùng: <code>/vao HARU88-XXXXXX</code>\n` +
          `• Ai tổng 3 xúc xắc cao hơn THẮNG (x1.9)\n\n` +
          `🔒 Muốn chơi riêng với bạn bè? Dùng <code>/mophong [số tiền]</code>`,
          { parse_mode: 'HTML' }
        );
      }
      return;
    }

    // /vao HARU88-XXXXXX
    // /phong — xem danh sách phòng solo đang mở
    if (text.trim().match(/^\/phong$/i) && chatId > 0) {
      const openRooms = [...this.soloDiceRooms.values()].filter((r: any) => r.status === "waiting");
      if (openRooms.length === 0) {
        await this.bot.sendMessage(chatId,
          `🎲 <b>PHÒNG SOLO XÚC XẮC</b>\n\n` +
          `Hiện không có phòng nào đang chờ người chơi.\n\n` +
          `💡 Tạo phòng: <code>/solo [số tiền]</code>`,
          { parse_mode: 'HTML' }
        );
      } else {
        const lines = openRooms.map((r: any) =>
          `• <code>${r.code}</code> — Cược: <b>${r.betAmount.toLocaleString()}đ</b> — <code>/vao ${r.code}</code>`
        ).join('\n');
        await this.bot.sendMessage(chatId,
          `🎲 <b>PHÒNG SOLO ĐANG CHỜ (${openRooms.length})</b>\n\n${lines}`,
          { parse_mode: 'HTML' }
        );
      }
      return;
    }

    const vaoMatch = text.trim().match(/^\/vao\s+(HARU88-[A-Z0-9]{6})$/i);
    if (vaoMatch && chatId > 0) {
      const roomCode = vaoMatch[1].toUpperCase();
      try {
        await this.handleJoinSoloDiceRoom(chatId, userId, roomCode);
      } catch (error) {
        logger.error({ error }, 'Error joining solo dice room');
        await this.bot.sendMessage(chatId, "❌ Có lỗi xảy ra!");
      }
      return;
    }

    // /huy HARU88-XXXXXX
    const huyMatch = text.trim().match(/^\/huy\s+(HARU88-[A-Z0-9]{6})$/i);
    if (huyMatch && chatId > 0) {
      const roomCode = huyMatch[1].toUpperCase();
      try {
        const room = this.soloDiceRooms.get(roomCode);
        if (!room) {
          await this.bot.sendMessage(chatId, "❌ Không tìm thấy phòng này!");
          return;
        }
        if (room.creator !== userId) {
          await this.bot.sendMessage(chatId, "❌ Bạn không phải chủ phòng!");
          return;
        }
        if (room.status === "done") {
          await this.bot.sendMessage(chatId, "❌ Phòng đã kết thúc rồi!");
          return;
        }

        // Refund all players
        for (const p of room.players) {
          const pData = await storage.getBotUser(p.userId);
          if (pData) {
            const refundBal = (parseFloat(pData.balance || "0") + room.betAmount).toString();
            await storage.updateBotUser(p.userId, { balance: refundBal });
            if (p.userId !== userId) {
              await this.bot.sendMessage(p.chatId,
                `❌ Phòng <code>${roomCode}</code> đã bị chủ phòng hủy.\n💰 Hoàn tiền: ${room.betAmount.toLocaleString()}đ`,
                { parse_mode: 'HTML' }
              );
            }
          }
        }
        this.soloDiceRooms.delete(roomCode);
        await this.bot.sendMessage(chatId,
          `✅ Đã hủy phòng <code>${roomCode}</code> thành công!\n💰 Hoàn tiền: ${room.betAmount.toLocaleString()}đ`,
          { parse_mode: 'HTML' }
        );
      } catch (error) {
        console.error('Error canceling solo dice room:', error);
        await this.bot.sendMessage(chatId, "❌ Có lỗi xảy ra!");
      }
      return;
    }

    // Handle Bowling commands: BC/BL/BX/BT [tiền]
    const bowlingMatch = text.trim().match(/^(bc|bl|bx|bt)\s+(\d+)$/i);
    if (bowlingMatch && chatId > 0) {
      const betType = bowlingMatch[1].toUpperCase();
      const amount = parseInt(bowlingMatch[2]);
      
      try {
        const userData = await storage.getBotUser(userId);
        if (!userData) {
          await this.bot.sendMessage(chatId, "❌ Không tìm thấy thông tin tài khoản.");
          return;
        }

        const currentBalance = parseFloat(userData.balance || "0");
        {
          const minBetBw = await getSettingNumber('min_bet', 1000);
          const maxBetBw = await getSettingNumber('max_bet', 1000000);
          if (amount < minBetBw || amount > maxBetBw) {
            await this.bot.sendMessage(chatId, `❌ Số tiền cược phải từ ${minBetBw.toLocaleString('vi-VN')}đ đến ${maxBetBw.toLocaleString('vi-VN')}đ!`);
            return;
          }
        }

        if (amount > currentBalance) {
          await this.bot.sendMessage(chatId, 
            `❌ Số dư không đủ!\n💰 Số dư hiện tại: ${currentBalance.toLocaleString('vi-VN')}đ`
          );
          return;
        }

        // Deduct balance
        const newBalance = (currentBalance - amount).toString();
        await storage.updateBotUser(userId, { balance: newBalance });

        // Track betting stats for leaderboard
        try {
          const _now = this.nowVN();
          const _dateStr = `${_now.getFullYear()}-${String(_now.getMonth() + 1).padStart(2, '0')}-${String(_now.getDate()).padStart(2, '0')}`;
          const _wk = this.getWeekNumber(_now);
          const _weekStr = `${_now.getFullYear()}-W${String(_wk).padStart(2, '0')}`;
          await storage.createOrUpdateBettingStats(userId, _dateStr, _weekStr, amount);
        } catch (_e) { /* non-critical */ }

        // Send bowling emoji
        // Telegram 🎳: value 1-6
        //   6 = STRIKE (all 10 pins down) 🎳
        //   4-5 = knock many pins (Tài)
        //   1-3 = knock few pins (Xỉu)
        //   Chẵn = 2,4,6 | Lẻ = 1,3,5
        const bowlingMsg = await this.bot.sendDice(chatId, { emoji: "🎳" });
        const result = bowlingMsg.dice!.value;

        await new Promise(resolve => setTimeout(resolve, 4000));

        const houseEdgeBw = await getSettingNumber('house_edge', 2.5);
        const multiplier = parseFloat((2 * (1 - houseEdgeBw / 100)).toFixed(4));
        const strikeMultiplier = parseFloat((3 * (1 - houseEdgeBw / 100)).toFixed(4));
        const isStrike = result === 6;
        let won = false;

        // BT = Tài (value >= 4), BX = Xỉu (value <= 3), BC = Chẵn, BL = Lẻ
        switch (betType) {
          case "BT": won = result >= 4; break;
          case "BX": won = result <= 3; break;
          case "BC": won = result % 2 === 0; break;
          case "BL": won = result % 2 === 1; break;
        }

        const resultLabel = isStrike ? "🎳 STRIKE!" : `Điểm: ${result}/6`;
        const betLabel = betType === "BT" ? "Tài (4-6)" : betType === "BX" ? "Xỉu (1-3)" : betType === "BC" ? "Chẵn (2,4,6)" : "Lẻ (1,3,5)";

        if (won) {
          const effectiveMult = isStrike && (betType === "BT" || betType === "BC") ? strikeMultiplier : multiplier;
          const winAmount = Math.floor(amount * effectiveMult);
          const finalBalance = (parseFloat(newBalance) + winAmount).toString();
          await storage.updateBotUser(userId, { balance: finalBalance });

          await this.bot.sendMessage(chatId,
            `🎳 <b>BOWLING - CHIẾN THẮNG!</b>\n\n` +
            `🎯 ${resultLabel}\n` +
            `🃏 Cửa cược: <b>${betLabel}</b>\n` +
            `💰 Cược: ${amount.toLocaleString('vi-VN')}đ\n` +
            `🎉 Thắng: ${winAmount.toLocaleString('vi-VN')}đ (x${effectiveMult})\n` +
            `💎 Số dư: ${parseFloat(finalBalance).toLocaleString('vi-VN')}đ`,
            { parse_mode: 'HTML' }
          );
        } else {
          await this.bot.sendMessage(chatId,
            `🎳 <b>BOWLING - THUA!</b>\n\n` +
            `🎯 ${resultLabel}\n` +
            `🃏 Cửa cược: <b>${betLabel}</b>\n` +
            `💰 Cược: ${amount.toLocaleString('vi-VN')}đ\n` +
            `😢 Thua: ${amount.toLocaleString('vi-VN')}đ\n` +
            `💎 Số dư: ${parseFloat(newBalance).toLocaleString('vi-VN')}đ`,
            { parse_mode: 'HTML' }
          );
        }
      } catch (error) {
        console.error('Error in bowling game:', error);
        await this.bot.sendMessage(chatId, "❌ Có lỗi xảy ra!");
      }
      return;
    }

    // Default response - only in private chat, ignore unknown messages in group -1003132451812
    if (chatId > 0) {
      await this.bot.sendMessage(chatId, "❌ Lệnh không hợp lệ!\n\n📱 Vui lòng sử dụng menu chính bên dưới:");
      await this.sendMainMenu(chatId);
    }
    // In group -1003132451812, ignore all messages except /sd (which is handled separately)
  }

  private getVipInfo(vipLevel: number): { name: string; emoji: string; color: string } {
    const vipData = {
      0: { name: "Otaku-kun", emoji: "👶🌸", color: "⚪" },
      1: { name: "Sakura-chan", emoji: "🌸✨", color: "🌟" },
      2: { name: "Kawaii Desu", emoji: "🌺😊", color: "🌸" },
      3: { name: "Senpai-sama", emoji: "👑🌸", color: "🔵" },
      4: { name: "Maid-chan", emoji: "👸🎀", color: "💜" },
      5: { name: "Tsundere", emoji: "😤💗", color: "💕" },
      6: { name: "Waifu-sama", emoji: "👩‍🎤💖", color: "🧡" },
      7: { name: "Onee-sama", emoji: "👸🌟", color: "💛" },
      8: { name: "Goddess-chan", emoji: "😇✨", color: "💎" },
      9: { name: "Anime Princess", emoji: "👑💫", color: "🌈" },
      10: { name: "Ultimate Otaku", emoji: "⭐💪", color: "✨" }
    };
    return vipData[vipLevel as keyof typeof vipData] || vipData[0];
  }

  private async showAccountMenu(chatId: number, userId: string, messageId?: number) {
    if (!this.bot) return;

    const user = await storage.getBotUser(userId);
    if (!user) return;

    // Calculate total games played (remove limit to get all games)
    const gameSessions = await storage.getGameSessionsByUser(userId);
    const totalGamesPlayed = gameSessions.length;

    // Update user's total games count
    await storage.updateBotUser(userId, { totalGames: totalGamesPlayed });

    // Tính VIP thực tế từ totalWagered (DB field vipLevel không tự cập nhật)
    const totalWageredForVip = parseFloat(user.totalWagered || "0");
    const earnedVipPoints = Math.floor(totalWageredForVip / 300000);
    const realVipLevel = this.getVipLevelFromPoints(earnedVipPoints);
    // Cập nhật DB nếu VIP level thay đổi
    if (realVipLevel !== Number(user.vipLevel ?? 0)) {
      await storage.updateBotUser(userId, { vipLevel: String(realVipLevel) });
    }
    const vipInfo = this.getVipInfo(realVipLevel);

    const keyboard = {
      inline_keyboard: [
        [
          { text: "🏦 Nạp Tiền", callback_data: "nap_tien" },
          { text: "🏦 Rút Tiền", callback_data: "rut_tien" }
        ],
        [
          { text: "🎁 Mua Gifcode", callback_data: "muagiftcode" },
          { text: "🎉 Nhập Gifcode", callback_data: "nhapgiftcode" }
        ],
        [
          { text: "📜 Lịch Sử Nạp", callback_data: "lichsunap" },
          { text: "📜 Lịch Sử Rút", callback_data: "lichsurut" }
        ],
        [
          { text: "🧧 LÌ XÌ", callback_data: "homqua" },
          { text: "📊 Lịch Sử Cược", callback_data: "lichsucuoc" }
        ],
        [
          { text: "👑 CẤP VIP", callback_data: "vip_info" },
          { text: "💸 Chuyển tiền", callback_data: "chuyen_tien" }
        ]
      ]
    };

    // Attendance days
    let attendanceDays = 0;
    try {
      const attDataStr = await storage.getSetting(`att_${userId}`);
      if (attDataStr) {
        const attData: { dates: string[] } = JSON.parse(attDataStr);
        attendanceDays = attData.dates?.length || 0;
      }
    } catch { /* ignore */ }

    // Giftcode used
    let giftcodeStatus = "Chưa";
    try {
      const used = await storage.hasUsedGiftCode(userId);
      giftcodeStatus = used ? "✅ Đã dùng" : "❌ Chưa";
    } catch { /* ignore */ }

    const vipDetails = this.getVipDetails(realVipLevel);
    const colorDots = ["⚡", "🟡", "🔴", "🟢", "🔵", "🟣", "🟠", "💜"];
    const fields = [
      `🧸 Tên: <b>${user.firstName || 'Người dùng'} ${user.lastName || ''}</b>`,
      `🆔 ID: <b>${user.id}</b>`,
      `💰 Số dư: <b>${Number(user.balance || 0).toLocaleString('vi-VN')}đ</b>`,
      `👑 VIP: <b>VIP ${realVipLevel}</b> ${vipDetails.emoji} ${vipDetails.name}`,
      `🎮 Số ván: <b>${totalGamesPlayed}</b>`,
      `💎 Hoa hồng: <b>${Number(user.commission || 0).toLocaleString('vi-VN')}đ</b>`,
      `🎁 Giftcode: <b>${giftcodeStatus}</b>`,
      `📅 Điểm danh: <b>${attendanceDays} ngày</b>`,
    ];
    const profileLines = fields.map((f, i) => `${colorDots[i % colorDots.length]} •${f}`).join('\n');

    const message = `👤 <b>𝗛𝗢̂̀ 𝗦𝗢̛ 𝗛𝗔𝗥𝗨𝟴𝟴:</b>\n\n` +
                   `<blockquote>${profileLines}</blockquote>\n\n` +
                   `✨ Chọn chức năng bên dưới để tiếp tục ✨`;

    await this.sendOrEditMessage(chatId, message, keyboard, "HTML", messageId);
  }

  private async showGamesMenu(chatId: number, messageId?: number) {
    if (!this.bot) return;

    const keyboard = {
      inline_keyboard: [
        [
          { text: "💥 TÀI XỈU SĂN HŨ 💥", callback_data: "play_taixiu_room" }
        ],
        [
          { text: "🎲 SOLO XÚC XẮC 🎲", callback_data: "play_solo_dice" }
        ],
        [
          { text: "🔻 Xúc xắc trên dưới 🔺", callback_data: "play_xucxac_trenduoi" }
        ],
        [
          { text: "💥 Tài Xỉu MD5 💥", callback_data: "play_taixiu_md5" },
          { text: "🎲 XÚC XẮC 🎲", callback_data: "play_xucxac" }
        ],
        [
          { text: "🎳 Bowling 🎳", callback_data: "play_bowling" },
          { text: "💰 Lô Đề 💰", callback_data: "play_lode" }
        ],
        [
          { text: "🏀 Bóng Rổ 🏀", callback_data: "play_basketball" },
          { text: "⚽️ Bóng Đá ⚽️", callback_data: "play_football" }
        ],
        [
          { text: "✈️ Máy Bay", callback_data: "miniapp_maybay" },
          { text: "🎯 Xóc Đĩa", callback_data: "play_xocdia" }
        ],
        [
          { text: "🦀 Bầu Cua", callback_data: "play_baucua" },
          { text: "🎳 Quay Thú", callback_data: "play_quaythu" }
        ],
      ]
    };

    const gameMenuMsg = `🎮 <b>KHU VỰC TRÒ CHƠI</b>\n\n` +
                       `Chọn trò chơi để bắt đầu:`;

    await this.sendOrEditMessage(chatId, gameMenuMsg, keyboard, "HTML", messageId);
  }

  private async showDepositOptions(chatId: number, messageId?: number) {
    if (!this.bot) return;

    const keyboard = {
      inline_keyboard: [
        [
          { text: "🏦 Ngân Hàng", callback_data: "nap_bank" },
          { text: "🎫 Thẻ Cào", callback_data: "nap_card" }
        ]
      ]
    };

    const depositMsg = "💳 **NẠP TIỀN**\n\n" +
                      "Chọn phương thức nạp tiền:";

    await this.sendOrEditMessage(chatId, depositMsg, keyboard, "Markdown", messageId);
  }

  private async showQuickAmountButtons(chatId: number, messageId?: number) {
    if (!this.bot) return;

    const keyboard = {
      inline_keyboard: [
        [
          { text: "5.000đ", callback_data: "amount_5000" },
          { text: "10.000đ", callback_data: "amount_10000" },
          { text: "20.000đ", callback_data: "amount_20000" }
        ],
        [
          { text: "50.000đ", callback_data: "amount_50000" },
          { text: "100.000đ", callback_data: "amount_100000" },
          { text: "200.000đ", callback_data: "amount_200000" }
        ],
        [
          { text: "500.000đ", callback_data: "amount_500000" },
          { text: "1.000.000đ", callback_data: "amount_1000000" }
        ],
        [
          { text: "🌟 Số Khác", callback_data: "amount_custom" }
        ]
      ]
    };

    const message = "<b><i>CHỌN SỐ TIỀN ĐỂ NẠP</i></b>\n\n🌟 Chọn số tiền hoặc nhập số khác (tối thiểu 5,000đ):";
    await this.sendOrEditMessage(chatId, message, keyboard, "HTML", messageId);
  }

  private async createPaymentRequest(chatId: number, userId: string, amount: number) {
    if (!this.bot) return;

    try {
      const user = await storage.getBotUser(userId);
      if (!user) {
        await this.bot.sendMessage(chatId, "❌ Không tìm thấy thông tin người dùng!");
        return;
      }

      const paymentMethod = this.getPaymentMethod(userId);

      // Handle different payment methods
      if (paymentMethod === 'card') {
        await this.handleCardPayment(chatId, userId, amount);
        return;
      }

      // Default to bank payment
      await this.handleBankPayment(chatId, userId, amount);

    } catch (error) {
      console.error("Payment creation error:", error);
      
      // User-friendly error message without exposing backend details
      await this.bot.sendMessage(chatId, "❌ Không thể tạo thanh toán lúc này. Vui lòng thử lại sau ít phút hoặc liên hệ admin!");
    }
  }

  private async handleBankPayment(chatId: number, userId: string, amount: number) {
    if (!this.bot) return;

    try {
      const { bankService } = await import('./bankService');

      // Ensure account info is loaded from DB settings before generating payment code
      await bankService.loadAccountInfoFromSettings();

      const { code, accountNumber, accountHolder, bank } = bankService.createPaymentCode(userId, amount);

      if (!accountNumber) {
        await this.bot.sendMessage(chatId,
          `❌ Hệ thống ngân hàng chưa được cấu hình.\nVui lòng liên hệ admin để được hỗ trợ.`
        );
        return;
      }

      // Store payment details as pending
      await storage.createTransaction({
        userId,
        type: "deposit",
        amount: amount.toString(),
        status: "pending",
        method: "bank",
        metadata: {
          paymentCode: code,
          paymentDetails: { accountNumber, accountHolder, bank, description: code, amount }
        }
      });

      // Register with CoreBank to watch for this specific transaction (5 min TTL)
      const { getSetting } = await import('../lib/settings.js');
      const webhookSecret = await getSetting("bank_webhook_secret");
      // callbackUrl: use configured URL, or auto-detect from REPLIT_DOMAINS, or fallback to localhost proxy
      // NOTE: haru88 api is proxied at /haru88/api so the full external path is /haru88/api/bank/webhook
      let callbackUrl = await getSetting("bot_webhook_url");
      if (!callbackUrl) {
        const replitDomain = process.env["REPLIT_DOMAINS"]?.split(",")[0]?.trim();
        callbackUrl = replitDomain
          ? `https://${replitDomain}/haru88/api/bank/webhook`
          : `http://localhost:80/haru88/api/bank/webhook`;
      }
      bankService.registerPendingWithCoreBank(code, amount, callbackUrl, webhookSecret || undefined)
        .catch(err => logger.warn({ err }, "CoreBank registration failed (non-fatal)"));

      const msg =
        `🏦 <b>THÔNG TIN NẠP TIỀN</b>\n\n` +
        `<blockquote>🏛 Ngân hàng: <b>${bank}</b>\n` +
        `💳 Số tài khoản: <code>${accountNumber}</code>\n` +
        `👤 Chủ tài khoản: <b>${accountHolder}</b>\n\n` +
        `💰 Số tiền: <b>${amount.toLocaleString('vi-VN')}đ</b>\n` +
        `📝 Nội dung CK: <code>${code}</code></blockquote>\n\n` +
        `⚠️ <b>Ghi đúng nội dung</b> <code>${code}</code> để hệ thống tự động xác nhận!\n` +
        `⏰ Yêu cầu này sẽ <b>hết hạn sau 5 phút</b>.\n\n` +
        `🤖 Hệ thống xác nhận tự động sau khi nhận tiền.`;

      // Send QR with logo (no coloured border)
      try {
        const { generateBankQR } = await import('../lib/qrGenerator');
        const bankCode = bank.replace(/\s/g, '');
        const qrBuf = await generateBankQR(bankCode, accountNumber, amount, code, accountHolder);
        await this.bot.sendPhoto(chatId, qrBuf, { caption: msg, parse_mode: 'HTML' });
      } catch (qrErr) {
        logger.warn({ qrErr }, "⚠️ QR send failed, sending text only");
        await this.bot.sendMessage(chatId, msg, { parse_mode: 'HTML' });
      }

    } catch (error) {
      logger.error({ error }, "Bank payment error");
      await this.bot.sendMessage(chatId, "❌ Không thể tạo thanh toán lúc này. Vui lòng thử lại sau ít phút!");
    }
  }

  private async handleCardPayment(chatId: number, userId: string, _amount: number) {
    this.paymentMethods.set(userId, "card");
    await this.showCardTelcoSelection(chatId);
  }

  private async showCardTelcoSelection(chatId: number, messageId?: number) {
    if (!this.bot) return;
    const keyboard = {
      inline_keyboard: [
        [
          { text: "📱 Viettel", callback_data: "card_telco_viettel" },
          { text: "📱 Vinaphone", callback_data: "card_telco_vina" },
        ],
        [
          { text: "📱 Mobifone", callback_data: "card_telco_mobi" },
          { text: "🎮 Zing", callback_data: "card_telco_zing" },
        ],
        [
          { text: "📋 Lịch Sử Nạp Thẻ", callback_data: "card_history" },
        ],
        [
          { text: "↩️ Quay Lại", callback_data: "nap_tien" },
        ],
      ],
    };
    const msg =
      "🎫 <b>NẠP THẺ CÀO TỰ ĐỘNG</b>\n\n" +
      "⚡ Hệ thống xử lý tự động 24/7\n" +
      "💰 Nhận tiền ngay sau khi xử lý\n" +
      "⚠️ <b>Lưu ý:</b> Sai mệnh giá sẽ bị trừ phí 50%\n" +
      "<pre>Loại thẻ  │ Viettel │ Vinaphone │ Mobifone │ Zing\n" +
      "──────────┼─────────┼───────────┼──────────┼─────\n" +
      "Chiết khấu│   25%   │    27%    │   33%    │ 23%</pre>\n" +
      "👇 Chọn nhà mạng:";
    await this.sendOrEditMessage(chatId, msg, keyboard, "HTML", messageId);
  }

  private async showCardAmountSelection(chatId: number, telco: SC68Telco, messageId?: number) {
    if (!this.bot) return;
    const amountRows: { text: string; callback_data: string }[][] = [];
    const amounts = [10000, 20000, 50000, 100000, 200000, 500000];
    for (let i = 0; i < amounts.length; i += 3) {
      amountRows.push(
        amounts.slice(i, i + 3).map(a => ({
          text: `${(a / 1000).toFixed(0)}K`,
          callback_data: `card_amount_${a}`,
        }))
      );
    }
    amountRows.push([{ text: "↩️ Quay Lại", callback_data: "nap_card" }]);
    const keyboard = { inline_keyboard: amountRows };
    const telcoLabel = TELCO_LABELS[telco];
    const msg =
      `🎫 <b>NẠP THẺ ${telcoLabel.toUpperCase()}</b>\n\n` +
      "👇 Chọn mệnh giá thẻ:";
    await this.sendOrEditMessage(chatId, msg, keyboard, "HTML", messageId);
  }

  private async showCardInputPrompt(chatId: number, telco: SC68Telco, amount: number, messageId?: number) {
    if (!this.bot) return;
    const keyboard = {
      inline_keyboard: [[{ text: "❌ Huỷ", callback_data: "nap_card" }]],
    };
    const telcoLabel = TELCO_LABELS[telco];
    const msg =
      `🎫 <b>NHẬP THÔNG TIN THẺ ${telcoLabel.toUpperCase()}</b>\n` +
      `💵 Mệnh giá: <b>${amount.toLocaleString("vi-VN")}đ</b>\n\n` +
      "📤 Gửi thông tin thẻ theo định dạng:\n" +
      "<code>SERIAL MÃ_THẺ</code>\n\n" +
      "Ví dụ:\n" +
      "<code>1234567890 9876543210123</code>\n\n" +
      "⚠️ Serial và mã thẻ cách nhau bằng dấu cách";
    if (messageId) {
      try {
        await this.bot.editMessageText(msg, {
          chat_id: chatId,
          message_id: messageId,
          parse_mode: "HTML",
          reply_markup: keyboard,
        });
      } catch {
        await this.bot.sendMessage(chatId, msg, { parse_mode: "HTML", reply_markup: keyboard });
      }
    } else {
      await this.bot.sendMessage(chatId, msg, { parse_mode: "HTML", reply_markup: keyboard });
    }
  }

  private async handleCardInput(chatId: number, userId: string, text: string, telco: SC68Telco, amount: number) {
    if (!this.bot) return;
    this.cardSessions.delete(userId);
    this.paymentMethods.delete(userId);

    const parts = text.trim().split(/\s+/);
    if (parts.length < 2) {
      await this.bot.sendMessage(
        chatId,
        "❌ <b>Định dạng sai!</b>\nVui lòng nhập: <code>SERIAL MÃ_THẺ</code>",
        { parse_mode: "HTML" }
      );
      return;
    }

    const serial = parts[0].replace(/[^0-9a-zA-Z]/g, "");
    const code = parts[1].replace(/[^0-9a-zA-Z]/g, "");

    if (!serial || !code) {
      await this.bot.sendMessage(chatId, "❌ Serial hoặc mã thẻ không hợp lệ!", { parse_mode: "HTML" });
      return;
    }

    if (!(await isShopCard68Configured())) {
      await this.bot.sendMessage(chatId, "⚠️ Hệ thống nạp thẻ chưa được cấu hình. Vui lòng liên hệ admin!", { parse_mode: "HTML" });
      return;
    }

    const waitMsg = await this.bot.sendMessage(
      chatId,
      `⏳ <b>Đang gửi thẻ ${TELCO_LABELS[telco]}...</b>\nVui lòng chờ trong giây lát...`,
      { parse_mode: "HTML" }
    );

    try {
      const requestId = `card_${userId}_${Date.now()}`;

      await storage.createCardSubmission({
        requestId,
        userId,
        telco,
        code,
        serial,
        declaredAmount: amount,
        status: 99,
        chatId: chatId.toString(),
      });

      const result = await submitCard68({ telco, code, serial, amount });

      if (result.status === 100) {
        await storage.updateCardSubmission(requestId, { status: 3, message: result.message });
        try { await this.bot.deleteMessage(chatId, waitMsg.message_id); } catch { /* ignore */ }
        await this.bot.sendMessage(
          chatId,
          `❌ <b>NẠP THẺ THẤT BẠI!</b>\n\n` +
          `📱 Nhà mạng: <b>${TELCO_LABELS[telco]}</b>\n` +
          `💵 Mệnh giá: <b>${amount.toLocaleString("vi-VN")}đ</b>\n` +
          `📋 Lý do: <b>${result.message ?? "Thẻ sai hoặc đã sử dụng"}</b>\n\n` +
          `Vui lòng kiểm tra lại thông tin thẻ.`,
          { parse_mode: "HTML" }
        );
        return;
      }

      if (result.status === 200) {
        const transactionId = result.transId;
        await storage.updateCardSubmission(requestId, { status: 99, tsrTransId: transactionId, message: "Đang xử lý" });

        // Zing cards return immediate price
        if (telco === "zing" && result.price > 0) {
          const feePercent = await getCardFeePercent(telco);
          const receivedAmount = Math.floor(result.price * (1 - feePercent / 100));
          const user = await storage.getBotUser(userId);
          const currentBalance = parseFloat(user?.balance ?? "0");
          const newBalance = (currentBalance + receivedAmount).toFixed(2);
          await storage.updateBotUser(userId, { balance: newBalance });
          await storage.createTransaction({
            userId, type: "deposit", amount: receivedAmount.toString(), status: "completed", method: "card",
            metadata: { telco, serial, declaredAmount: amount, realAmount: result.price, receivedAmount, feePercent, transactionId, requestId },
          });
          await storage.updateCardSubmission(requestId, { status: 1, realAmount: result.price, receivedAmount, message: "Thẻ đúng", credited: true });
          try { await this.bot.deleteMessage(chatId, waitMsg.message_id); } catch { /* ignore */ }
          await this.bot.sendMessage(chatId,
            `✅ <b>NẠP THẺ THÀNH CÔNG!</b>\n\n` +
            `📱 Nhà mạng: <b>${TELCO_LABELS[telco]}</b>\n` +
            `💵 Mệnh giá: <b>${amount.toLocaleString("vi-VN")}đ</b>\n` +
            `💸 Phí chiết khấu: <b>${feePercent}%</b>\n` +
            `💰 Tiền nhận được: <b>${receivedAmount.toLocaleString("vi-VN")}đ</b>\n` +
            `💳 Số dư mới: <b>${parseFloat(newBalance).toLocaleString("vi-VN")}đ</b>`,
            { parse_mode: "HTML" }
          );
          return;
        }

        // Non-zing: notify user and poll in background
        try { await this.bot.deleteMessage(chatId, waitMsg.message_id); } catch { /* ignore */ }
        await this.bot.sendMessage(chatId,
          `⏳ <b>THẺ ĐANG ĐƯỢC XỬ LÝ</b>\n\n` +
          `📱 Nhà mạng: <b>${TELCO_LABELS[telco]}</b>\n` +
          `💵 Mệnh giá khai báo: <b>${amount.toLocaleString("vi-VN")}đ</b>\n` +
          `🔔 Hệ thống sẽ tự động cộng tiền sau khi xử lý xong.\n` +
          `⏰ Thông thường trong 1–3 phút.`,
          { parse_mode: "HTML" }
        );

        // Background polling
        this.pollAndCreditCard68(chatId, userId, requestId, transactionId, telco, amount).catch(() => {});
      }
    } catch (err) {
      try { await this.bot.deleteMessage(chatId, waitMsg.message_id); } catch { /* ignore */ }
      await this.bot.sendMessage(chatId, "❌ Lỗi kết nối hệ thống nạp thẻ. Vui lòng thử lại sau hoặc liên hệ admin!", { parse_mode: "HTML" });
    }
  }

  private async pollAndCreditCard68(chatId: number, userId: string, requestId: string, transactionId: string, telco: SC68Telco, declaredAmount: number) {
    if (!this.bot) return;
    const pollResult = await pollCard68Result(transactionId);

    if (!pollResult) {
      await this.bot.sendMessage(chatId,
        `⚠️ <b>HẾT THỜI GIAN CHỜ</b>\n\n` +
        `📱 Nhà mạng: <b>${TELCO_LABELS[telco]}</b>\n` +
        `💵 Mệnh giá khai báo: <b>${declaredAmount.toLocaleString("vi-VN")}đ</b>\n` +
        `Vui lòng liên hệ admin để kiểm tra giao dịch: <code>${transactionId}</code>`,
        { parse_mode: "HTML" }
      );
      return;
    }

    if (pollResult.price > 0) {
      const feePercent = await getCardFeePercent(telco);
      const receivedAmount = Math.floor(pollResult.price * (1 - feePercent / 100));
      const user = await storage.getBotUser(userId);
      const currentBalance = parseFloat(user?.balance ?? "0");
      const newBalance = (currentBalance + receivedAmount).toFixed(2);
      await storage.updateBotUser(userId, { balance: newBalance });
      await storage.createTransaction({
        userId, type: "deposit", amount: receivedAmount.toString(), status: "completed", method: "card",
        metadata: { telco, declaredAmount, realAmount: pollResult.price, receivedAmount, feePercent, transactionId, requestId },
      });
      await storage.updateCardSubmission(requestId, { status: 1, realAmount: pollResult.price, receivedAmount, message: "Thẻ đúng", credited: true });
      await this.bot.sendMessage(chatId,
        `✅ <b>NẠP THẺ THÀNH CÔNG!</b>\n\n` +
        `📱 Nhà mạng: <b>${TELCO_LABELS[telco]}</b>\n` +
        `💵 Mệnh giá khai báo: <b>${declaredAmount.toLocaleString("vi-VN")}đ</b>\n` +
        `💸 Phí chiết khấu: <b>${feePercent}%</b>\n` +
        `💰 Tiền nhận được: <b>${receivedAmount.toLocaleString("vi-VN")}đ</b>\n` +
        `💳 Số dư mới: <b>${parseFloat(newBalance).toLocaleString("vi-VN")}đ</b>`,
        { parse_mode: "HTML" }
      );
      // Notify group about card success
      try {
        const MAIN_GROUP = -1003132451812;
        const maskedId = `****${userId.slice(-5)}`;
        await this.bot.sendMessage(MAIN_GROUP,
          `🎉🧧 [BOT] Người chơi ID: ${maskedId}\n- Đổi thẻ cào thành công: ${receivedAmount.toLocaleString('vi-VN')}đ`
        );
      } catch { /* ignore */ }
    } else {
      await storage.updateCardSubmission(requestId, { status: 3, message: pollResult.message });
      await this.bot.sendMessage(chatId,
        `❌ <b>NẠP THẺ THẤT BẠI!</b>\n\n` +
        `📱 Nhà mạng: <b>${TELCO_LABELS[telco]}</b>\n` +
        `💵 Mệnh giá: <b>${declaredAmount.toLocaleString("vi-VN")}đ</b>\n` +
        `📋 Lý do: <b>${pollResult.message ?? "Thẻ sai hoặc đã sử dụng"}</b>`,
        { parse_mode: "HTML" }
      );
    }
  }

  private async showCardHistory(chatId: number, userId: string, messageId?: number) {
    if (!this.bot) return;
    const history = await storage.getCardSubmissionsByUser(userId, 10);
    const keyboard = { inline_keyboard: [[{ text: "↩️ Quay Lại", callback_data: "nap_card" }]] };
    if (history.length === 0) {
      await this.sendOrEditMessage(chatId, "📋 <b>Lịch Sử Nạp Thẻ</b>\n\nChưa có lịch sử nạp thẻ.", keyboard, "HTML", messageId);
      return;
    }
    const statusEmoji: Record<number, string> = { 1: "✅", 2: "⚠️", 3: "❌", 4: "🔧", 99: "⏳" };
    const lines = history.map(h => {
      const emoji = statusEmoji[h.status] ?? "❓";
      const telcoLabel = TELCO_LABELS[h.telco as SC68Telco] ?? h.telco;
      const date = new Date(h.createdAt).toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" });
      const received = h.receivedAmount ? `+${h.receivedAmount.toLocaleString("vi-VN")}đ` : "";
      return `${emoji} ${telcoLabel} ${h.declaredAmount.toLocaleString("vi-VN")}đ ${received} — ${date}`;
    });
    const msg = `📋 <b>LỊCH SỬ NẠP THẺ (10 gần nhất)</b>\n\n${lines.join("\n")}`;
    await this.sendOrEditMessage(chatId, msg, keyboard, "HTML", messageId);
  }

  public async sendNotification(tgId: string, msg: string): Promise<void> {
    if (!this.bot) return;
    try {
      await this.bot.sendMessage(tgId, msg, { parse_mode: "HTML" });
    } catch (err) {
      logger.error({ err }, "sendNotification failed");
    }
  }

  public async notifyCardResult(chatId: number, result: {
    status: number;
    telco: string;
    declaredAmount: number;
    realAmount: number;
    receivedAmount: number;
    balance: string | null;
  }) {
    if (!this.bot) return;
    const telcoLabel = TELCO_LABELS[result.telco as SC68Telco] ?? result.telco;
    try {
      if (result.status === 1 || result.status === 2) {
        const statusText = result.status === 1 ? "✅ <b>NẠP THẺ THÀNH CÔNG!</b>" : "⚠️ <b>THẺ SAI MỆNH GIÁ — ĐÃ CỘNG TIỀN</b>";
        await this.bot.sendMessage(
          chatId,
          `${statusText}\n\n` +
          `📱 Nhà mạng: <b>${telcoLabel}</b>\n` +
          `💵 Mệnh giá khai báo: <b>${result.declaredAmount.toLocaleString("vi-VN")}đ</b>\n` +
          (result.realAmount ? `💵 Mệnh giá thực: <b>${result.realAmount.toLocaleString("vi-VN")}đ</b>\n` : "") +
          `💰 Tiền nhận được: <b>${result.receivedAmount.toLocaleString("vi-VN")}đ</b>\n` +
          (result.balance ? `💳 Số dư mới: <b>${parseFloat(result.balance).toLocaleString("vi-VN")}đ</b>` : ""),
          { parse_mode: "HTML" }
        );
      } else if (result.status === 3) {
        await this.bot.sendMessage(
          chatId,
          `❌ <b>NẠP THẺ THẤT BẠI!</b>\n\n` +
          `📱 Nhà mạng: <b>${telcoLabel}</b>\n` +
          `💵 Mệnh giá: <b>${result.declaredAmount.toLocaleString("vi-VN")}đ</b>\n` +
          `📋 Lý do: Thẻ sai hoặc đã sử dụng.`,
          { parse_mode: "HTML" }
        );
      } else if (result.status === 4) {
        await this.bot.sendMessage(
          chatId,
          `🔧 <b>HỆ THỐNG BẢO TRÌ</b>\n\nThẻ của bạn sẽ được xử lý lại sau. Vui lòng chờ thông báo.`,
          { parse_mode: "HTML" }
        );
      }
    } catch { /* silently fail if user blocked bot */ }
  }


  private async sendAmountSelection(chatId: number, gameType: string, messageId?: number) {
    if (!this.bot) return;

    const keyboard = {
      inline_keyboard: [
        [
          { text: "5K", callback_data: "amount_5000" },
          { text: "10K", callback_data: "amount_10000" },
          { text: "20K", callback_data: "amount_20000" }
        ],
        [
          { text: "30K", callback_data: "amount_30000" },
          { text: "50K", callback_data: "amount_50000" },
          { text: "100K", callback_data: "amount_100000" }
        ],
        [
          { text: "💰 Số khác", callback_data: "amount_custom" }
        ]
      ]
    };

    const displayName = gameType.toUpperCase();
    await this.bot.sendMessage(chatId, `💰 Chọn số tiền cược cho <b>${displayName}</b>:`, {
      reply_markup: keyboard,
      parse_mode: "HTML"
    });
  }

  // Game display name utility
  private getGameDisplayName(gameType: string): string {
    const gameNames: { [key: string]: string } = {
      'taixiu': 'TÀI XỈU',
      'taixiu_md5': 'TÀI XỈU MD5',
      'taixiu_room': 'TÀI XỈU ROOM',
      'quaythuong': 'QUAY THƯỞNG'
    };
    return gameNames[gameType] || gameType.toUpperCase();
  }

  // Game session management
  private createGameSession(userId: string, gameType: string) {
    const session: GameSession = {
      userId,
      gameType,
      status: "betting",
      timestamp: Date.now()
    };
    this.gameSessions.set(userId, session);
    return session;
  }

  private clearGameSession(userId: string) {
    this.gameSessions.delete(userId);
  }

  // Game betting options
  private async sendGameBettingOptions(chatId: number, gameType: string, messageId?: number) {
    if (!this.bot) return;

    let keyboard;
    // Use HTML formatting to avoid Markdown parsing issues
    const displayName = this.getGameDisplayName(gameType);
    let message = `🎮 <b>${displayName}</b>\n\nChọn cửa cược:`;

    switch (gameType) {
      case "taixiu":
        keyboard = {
          inline_keyboard: [
            [
              { text: "🎲 TÀI (11-18)", callback_data: "bet_tai" },
              { text: "🎲 XỈU (3-10)", callback_data: "bet_xiu" }
            ]
          ]
        };
        message += "\n\n• TÀI: Tổng 3 xúc xắc từ 11-18\n• XỈU: Tổng 3 xúc xắc từ 3-10\n• Tỷ lệ: x1.95";
        break;
        
      case "taixiu_md5":
        keyboard = undefined;
        message =
                  `💥 <b>TÀI XỈU MD5 ROOM</b>\n` +
                  `🏛 Nhóm chơi: https://t.me/TXCLHARU88\n\n` +
                  `📋 BOT tạo KEY → mã hóa MD5 → công bố sau phiên\n` +
                  `🔍 Kiểm tra tại md5.cz\n\n` +
                  `💚 <b>BẢNG TỶ LỆ CƯỢC</b>\n` +
                  `MC  |  Số cuối 0,2,4,6,8  |  x1.9\n` +
                  `ML  |  Số cuối 1,3,5,7,9  |  x1.9\n` +
                  `MT  |  Số cuối 5,6,7,8,9  |  x1.9\n` +
                  `MX  |  Số cuối 0,1,2,3,4  |  x1.9\n\n` +
                  `💚 <b>CÁCH ĐẶT CƯỢC</b>\n` +
                  `• Tối thiểu: 1.000đ | Tối đa: 1.000.000đ\n` +
                  `• Cách chơi: Cửa cược [dấu cách] số tiền\n` +
                  `• VD: MT 20000\n` +
                  `• Cược tất tay: MT max`;
        break;
        
      case "taixiu_room":
        keyboard = {
          inline_keyboard: [
            [
              { text: "🎲 Dự Đoán Xúc Xắc", callback_data: "bet_du_doan_xuc_xac" }
            ],
            [
              { text: "🔮 Dự Đoán Tổng", callback_data: "bet_du_doan_tong" }
            ],
            [
              { text: "🎯 Đoán Xiên", callback_data: "bet_doan_xien" }
            ]
          ]
        };
        message =
          `💥 <b>GAME TÀI XỈU SĂN HŨ</b> 💥\n` +
          `🏛 Tham gia Room chơi game: https://t.me/TXCLHARU88\n\n` +
          `<blockquote>Game T X C L tại Room\n` +
          `- T: Tổng 3 viên XX từ 11 - 18 Tài.\n` +
          `- X: Tổng 3 viên XX từ 3 - 10 Xỉu.\n` +
          `- C: Tổng 3 viên XX là Chẵn.\n` +
          `- L: Tổng 3 viên XX là Lẻ.\n\n` +
          `• Tỷ lệ trả thưởng 1.95\n` +
          `• Nổ hũ khi 3 viên xúc xắc giống nhau đều là 1 hoặc 6 ở game TXCL.</blockquote>\n\n` +
          `<blockquote>Lệnh cược: [T/X/C/L] [tiền chơi]\n` +
          `VD: T 20000\n` +
          `- Cược ẩn danh: TT/XX/CC/LL [tiền chơi]\n` +
          `- Cược tất tay: T max hoặc C max</blockquote>`;
        break;
        
      case "chanle":
        keyboard = {
          inline_keyboard: [
            [
              { text: "🎯 CHẴN (2,4,6)", callback_data: "bet_chan" },
              { text: "🎯 LẺ (1,3,5)", callback_data: "bet_le" }
            ]
          ]
        };
        message += "\n\n• CHẴN: Xúc xắc ra số chẵn (2,4,6)\n• LẺ: Xúc xắc ra số lẻ (1,3,5)\n• Tỷ lệ: x1.95";
        break;
        
      case "quaythuong":
        keyboard = {
          inline_keyboard: [
            [
              { text: "💰 Quay Ngay", callback_data: "bet_quay" }
            ]
          ]
        };
        message = "🎰 <b>QUAY THƯỞNG</b>\n\nChọn quay để thử vận may!\n\n🎁 <b>Giải thưởng:</b>\n• 🍒🍒🍒 x10.0\n• 🍋🍋🍋 x5.0\n• 🍊🍊🍊 x3.0\n• ⭐⭐⭐ x2.5\n• 🔔🔔🔔 x2.0";
        break;
        
      case "solo_dice":
        keyboard = undefined;
        message = "⚔️ <b>SOLO XÚC XẮC — GAME XX</b>\n\n" +
                  "Thách đấu 1 vs 1 — ai tổng 3 xúc xắc cao hơn THẮNG!\n" +
                  "💰 Người thắng nhận toàn bộ tiền cược x1.9\n\n" +
                  "━━━━━━━━━━━━━━━━━━━━\n" +
                  "📋 <b>LỆNH SỬ DỤNG:</b>\n" +
                  "  <code>/solo [số tiền]</code>\n" +
                  "  → Mở phòng & đăng nhóm tìm đối thủ\n\n" +
                  "  <code>/mophong [số tiền]</code>\n" +
                  "  → Mở phòng RIÊNG TƯ (chỉ bạn bè có mã)\n\n" +
                  "  <code>/phong</code>\n" +
                  "  → Xem danh sách phòng đang mở\n\n" +
                  "  <code>/vao HARU88-XXXXXX</code>\n" +
                  "  → Vào phòng theo mã\n\n" +
                  "  <code>/huy HARU88-XXXXXX</code>\n" +
                  "  → Hủy phòng do mình tạo\n\n" +
                  "━━━━━━━━━━━━━━━━━━━━\n" +
                  "💡 VD: <code>/solo 50000</code> hoặc <code>/mophong 100000</code>";
        break;
        
      case "xucxac_trenduoi":
        keyboard = {
          inline_keyboard: [
            [
              { text: "🔺 TRÊN (4-6)", callback_data: "bet_tren" },
              { text: "🔻 DƯỚI (1-3)", callback_data: "bet_duoi" }
            ]
          ]
        };
        message = "🎲 <b>XÚC XẮC TRÊN DƯỚI</b>\n\n" +
                  "🔺 TRÊN: Xúc xắc ra 4, 5 hoặc 6\n" +
                  "🔻 DƯỚI: Xúc xắc ra 1, 2 hoặc 3\n\n" +
                  "💰 Tỷ lệ: x1.95\n" +
                  "🎯 Chọn cửa cược của bạn!";
        break;
        
      case "xucxac":
        keyboard = {
          inline_keyboard: [
            [
              { text: "🤖 BOT TUNG", callback_data: "bet_bottung" },
              { text: "👤 NGƯỜI TUNG", callback_data: "bet_nguoitung" }
            ]
          ]
        };
        message = "🎲 <b>XÚC XẮC</b>\n\n" +
                  "🤖 BOT TUNG: Bot tung 3 xúc xắc liên tiếp\n" +
                  "👤 NGƯỜI TUNG: Bạn tung 3 xúc xắc liên tiếp\n\n" +
                  "🎯 Đoán Tài/Xỉu từ tổng 3 xúc xắc\n" +
                  "💰 Tỷ lệ: x1.95";
        break;
        
        
      case "lode":
        keyboard = undefined;
        message = "🎰 <b>LÔ ĐỀ XSMB</b> 🎰\n\n" +
                  "📡 Kết quả theo xổ số miền Bắc hàng ngày, cập nhật tự động\n\n" +
                  "━━━━━━━━━━━━━━━━━━━━━━\n" +
                  "🔵 <b>LÔ</b> — 2 số cuối xuất hiện trong BẤT KỲ giải nào\n" +
                  "    Lệnh: <code>LO [số] [tiền]</code>\n" +
                  "    Trả thưởng: <b>x70</b>\n\n" +
                  "🔴 <b>ĐỀ</b> — 2 số cuối của giải ĐẶC BIỆT\n" +
                  "    Lệnh: <code>DE [số] [tiền]</code>\n" +
                  "    Trả thưởng: <b>x80</b>\n" +
                  "━━━━━━━━━━━━━━━━━━━━━━\n\n" +
                  "📌 <b>1 điểm = 27,000đ</b>\n" +
                  "⚡ Tối thiểu: 1 điểm | Tối đa: 1,000 điểm\n" +
                  "⏰ Hết hạn cược: <b>trước khi kết quả ra</b>\n\n" +
                  "💡 <b>Ví dụ:</b>\n" +
                  "• <code>LO 79 1</code> — Lô số 79, 1 điểm (27,000đ)\n" +
                  "• <code>LO 23,45,67 2</code> — Lô 3 số, mỗi số 2 điểm\n" +
                  "• <code>DE 45 5</code> — Đề số 45, 5 điểm (135,000đ)\n\n" +
                  "📊 Gõ <code>XSMB</code> để xem kết quả hôm nay\n" +
                  "📋 Gõ <code>CUOCLO</code> để xem cược đang chờ";
        break;
        
      case "xocdia": {
        const xocDiaUrl = `${this.getPublicUrl()}/api/games/xoc-dia?tgid=${chatId}`;
        keyboard = {
          inline_keyboard: [
            [
              { text: "🎮 Chơi Xóc Đĩa", web_app: { url: xocDiaUrl } }
            ]
          ]
        };
        message = "🎯 <b>XÓC ĐĨA</b>\n\n" +
                  "🪙 Game xóc đĩa truyền thống nhiều người!\n" +
                  "🎲 Đặt cược trước khi hết giờ đếm ngược\n\n" +
                  "⚪ Chẵn: tổng số mặt trắng là số chẵn\n" +
                  "⚫ Lẻ: tổng số mặt trắng là số lẻ\n\n" +
                  "💰 Tỷ lệ: x1.95\n" +
                  "✨ Nhấn nút bên dưới để vào game!";
        break;
      }

      case "quaythu": {
        const quayThuUrl = `${this.getPublicUrl()}/api/games/quay-thu?tgid=${chatId}`;
        keyboard = {
          inline_keyboard: [
            [
              { text: "🎳 Chơi Quay Thú", web_app: { url: quayThuUrl } }
            ]
          ]
        };
        message = "🎳 <b>QUAY THÚ</b>\n\n" +
                  "🐾 Chọn con thú may mắn để đặt cược!\n" +
                  "🎲 Server tự động quay kết quả mỗi phiên\n\n" +
                  "🎯 Nhiều con thú với tỷ lệ thưởng khác nhau\n" +
                  "🦈 Cá Mập Vàng: x100 | 🦅 Đại Bàng: x50\n\n" +
                  "✨ Nhấn nút bên dưới để vào game!";
        break;
      }

      case "baucua":
        const bauCuaUrl = `${this.getPublicUrl()}/api/games/bau-cua?tgid=${chatId}`;
        keyboard = {
          inline_keyboard: [
            [
              { text: "🎮 Chơi Bầu Cua", web_app: { url: bauCuaUrl } }
            ]
          ]
        };
        message = "🦀 <b>BẦU CUA</b>\n\n" +
                  "🎲 Game Bầu Cua truyền thống!\n" +
                  "🎯 Chọn con vật may mắn:\n\n" +
                  "🦐 Tôm | 🦀 Cua | 🐟 Cá\n" +
                  "🦌 Nai | 🐓 Gà | 🎃 Bầu\n\n" +
                  "💰 Tỷ lệ: x1.95\n" +
                  "✨ Nhấn nút bên dưới để chơi!";
        break;
        
      case "football":
        keyboard = undefined;
        message = "⚽ <b>BÓNG ĐÁ — DICE KICK</b>\n\n" +
                  "Đặt cược rồi tung bóng — vào lưới là THẮNG!\n\n" +
                  "━━━━━━━━━━━━━━━━━━━━━━\n" +
                  "📋 <b>CÁCH CHƠI:</b>\n" +
                  "  Gõ: <code>BD [số tiền]</code>\n" +
                  "  VD: <code>BD 50000</code>\n\n" +
                  "🎯 <b>KẾT QUẢ:</b>\n" +
                  "  ⚽ VÀO LƯỚI → Thắng x2.3\n" +
                  "  ❌ RA NGOÀI → Thua\n\n" +
                  "━━━━━━━━━━━━━━━━━━━━━━\n" +
                  "💰 Mức cược: 1,000đ – 300,000đ";
        break;

      case "basketball":
        keyboard = undefined;
        message = "🏀 <b>BÓNG RỔ — DICE SHOT</b>\n\n" +
                  "Đặt cược rồi ném bóng — vào rổ là THẮNG!\n\n" +
                  "━━━━━━━━━━━━━━━━━━━━━━\n" +
                  "📋 <b>CÁCH CHƠI:</b>\n" +
                  "  Gõ: <code>BR [số tiền]</code>\n" +
                  "  VD: <code>BR 50000</code>\n\n" +
                  "🎯 <b>KẾT QUẢ:</b>\n" +
                  "  🏀 VÀO RỔ → Thắng x2.3\n" +
                  "  ❌ TRƯỢT RỔ → Thua\n\n" +
                  "━━━━━━━━━━━━━━━━━━━━━━\n" +
                  "💰 Mức cược: 1,000đ – 300,000đ";
        break;

      case "bowling":
        keyboard = undefined;
        message = "🎳 <b>BOWLING — DICE ROLL</b>\n\n" +
                  "Chọn cửa cược rồi tung bowling!\n\n" +
                  "━━━━━━━━━━━━━━━━━━━━━━\n" +
                  "📋 <b>CÁC CỬA CƯỢC:</b>\n" +
                  "  <code>BC [tiền]</code> — CHẴN (tổng xúc xắc chẵn) x1.9\n" +
                  "  <code>BL [tiền]</code> — LẺ (tổng xúc xắc lẻ) x1.9\n" +
                  "  <code>BX [tiền]</code> — XỈU (tổng ≤ 10) x1.9\n" +
                  "  <code>BT [tiền]</code> — TÀI (tổng ≥ 11) x1.9\n\n" +
                  "💡 <b>VD:</b> <code>BC 50000</code>\n\n" +
                  "━━━━━━━━━━━━━━━━━━━━━━\n" +
                  "💰 Mức cược: 1,000đ – 300,000đ";
        break;

      default:
        keyboard = undefined;
        message = "❓ Game đang phát triển...";
    }

    await this.sendOrEditMessage(chatId, message, keyboard, "HTML", messageId);
  }

  // Game algorithms and logic
  private async processGameBet(chatId: number, userId: string, session: GameSession, amount: number) {
    if (!this.bot) return;

    try {
      const user = await storage.getBotUser(userId);
      if (!user) {
        await this.bot.sendMessage(chatId, "❌ Không tìm thấy thông tin người dùng!");
        return;
      }

      if (parseFloat(user.balance || "0") < amount) {
        await this.bot.sendMessage(chatId, "⛔ Số dư không đủ để cược!");
        this.clearGameSession(userId);
        return;
      }

      // Handle MD5 games differently - use provably fair system
      if (session.gameType === "taixiu_md5") {
        await this.processMD5GameBet(chatId, userId, session, amount, user);
        return;
      }

      // Handle room games differently - use room system
      if (session.gameType === "taixiu_room") {
        await this.joinTaiXiuRoom(session.betType!, amount, chatId, user.username || undefined);
        this.clearGameSession(userId);
        return;
      }

      // Deduct balance
      const newBalance = (parseFloat(user.balance || "0") - amount).toString();
      await storage.updateBotUser(userId, { 
        balance: newBalance,
        totalGames: (user.totalGames || 0) + 1 
      });

      // Create game session record
      const gameSession = await storage.createGameSession({
        userId,
        gameType: session.gameType,
        betType: session.betType!,
        betAmount: amount.toString(),
        status: "pending"
      });

      // Track betting stats for rankings
      try {
        const now = this.nowVN();
        const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
        const weekNumber = this.getWeekNumber(now);
        const weekYearStr = `${now.getFullYear()}-W${String(weekNumber).padStart(2, '0')}`;
        await storage.createOrUpdateBettingStats(userId, dateStr, weekYearStr, amount);
        console.log(`📊 Tracking bet: ${userId}, ${amount}, ${dateStr}`);
      } catch (error) {
        console.error('Error tracking betting stats:', error);
        // Don't throw - continue with game even if stats tracking fails
      }

      // If player throw mode for xucxac, pause and wait for player click
      if (session.gameType === "xucxac" && session.throwMode === "player") {
        session.pendingGameSessionId = gameSession.id;
        session.pendingBetAmount = amount;
        session.pendingNewBalance = newBalance;
        session.status = "waiting_player_roll";
        this.playerDiceCollector.delete(userId); // Reset collector
        this.gameSessions.set(userId, session);
        await this.bot.sendMessage(chatId,
          `🎲 <b>XÚC XẮC - NGƯỜI TUNG</b>\n\n` +
          `💰 Cược: <b>${amount.toLocaleString()}đ</b> → ${this.getBetName(session.betType!)}\n\n` +
          `👇 Hãy tung <b>3 xúc xắc</b> vào đây!\n\n` +
          `<i>Cách gửi xúc xắc trong Telegram:\n` +
          `• Nhấn biểu tượng 📎 (đính kèm)\n` +
          `• Chọn mục <b>Dice</b> hoặc <b>🎲</b>\n` +
          `• Gửi 3 lần liên tiếp</i>`,
          { parse_mode: 'HTML' }
        );
        return;
      }

      // Send confirmation
      await this.bot.sendMessage(
        chatId,
        `🎲 Đặt cược: ${amount.toLocaleString()}đ vào ${this.getBetName(session.betType!)}\n` +
        `⏳ Đang xử lý...`
      );

      // Execute game logic
      const result = await this.executeGame(session.gameType, session.betType!, chatId);
      
      // Process result
      let winAmount = 0;
      let resultText = result.resultText;
      
      if (result.won === true) {
        // Use specific multiplier from game result if provided, otherwise derive from house_edge
        const houseEdgeGs = await getSettingNumber('house_edge', 2.5);
        const defaultMult = parseFloat((2 * (1 - houseEdgeGs / 100)).toFixed(4));
        const multiplier = result.payoutMultiplier || defaultMult;
        winAmount = Math.floor(amount * multiplier);
        const profit = winAmount - amount;
        
        // Update user balance with winnings
        const finalBalance = (parseFloat(newBalance) + winAmount).toString();
        await storage.updateBotUser(userId, { balance: finalBalance });
        
        resultText += `✅ THẮNG CUỘC\n`;
        resultText += `💵 Tiền thưởng: +${winAmount.toLocaleString()}đ\n`;
        resultText += `📈 Lợi nhuận: +${profit.toLocaleString()}đ\n`;
        resultText += `💰 Số dư: ${parseFloat(finalBalance).toLocaleString()}đ`;
        
        // Update game session
        await storage.updateGameSession(gameSession.id, {
          status: "completed",
          winAmount: winAmount.toString(),
          result: result.result,
          completedAt: new Date()
        });
        
        // Create win transaction
        await storage.createTransaction({
          userId,
          type: "win",
          amount: winAmount.toString(),
          status: "completed",
          method: "game_win",
          metadata: { gameType: session.gameType, gameSessionId: gameSession.id }
        });
        
      } else if (result.won === null) {
        // Tie - refund
        const refundBalance = (parseFloat(newBalance) + amount).toString();
        await storage.updateBotUser(userId, { balance: refundBalance });
        
        resultText += `🤝 HÒA — Hoàn tiền\n`;
        resultText += `💰 Số dư: ${parseFloat(refundBalance).toLocaleString()}đ`;
        
        await storage.updateGameSession(gameSession.id, {
          status: "completed",
          winAmount: amount.toString(),
          result: result.result,
          completedAt: new Date()
        });
        
      } else {
        // Loss
        resultText += `❌ THUA CUỘC\n`;
        resultText += `💸 Đã trừ: -${amount.toLocaleString()}đ\n`;
        resultText += `💰 Số dư: ${parseFloat(newBalance).toLocaleString()}đ`;
        
        await storage.updateGameSession(gameSession.id, {
          status: "completed",
          winAmount: "0",
          result: result.result,
          completedAt: new Date()
        });
      }

      // Create bet transaction
      await storage.createTransaction({
        userId,
        type: "bet",
        amount: amount.toString(),
        status: "completed",
        method: "game_bet",
        metadata: { gameType: session.gameType, gameSessionId: gameSession.id }
      });

      // Track TX streaks (taixiu_md5 or taixiu) for bets >= 10K
      if ((session.gameType === "taixiu_md5" || session.gameType === "taixiu") && amount >= 10000 && result.won !== null) {
        const displayName = user.firstName || user.username || userId;
        const streak = this.txStreaks.get(userId) || { wins: 0, losses: 0, name: displayName };
        streak.name = displayName; // always update to latest known name
        if (result.won === true) {
          streak.wins++;
          streak.losses = 0;
        } else {
          streak.losses++;
          streak.wins = 0;
        }
        this.txStreaks.set(userId, streak);
      }

      // Award commission to referrer if user was referred
      const userForCommission = await storage.getBotUser(userId);
      if (userForCommission && userForCommission.referredBy) {
        await this.awardReferralCommission(userForCommission.referredBy, amount, 'game');
      }

      // Send game result
      await this.bot.sendMessage(chatId, resultText, {
        parse_mode: 'HTML'
      });

      // For xucxac_trenduoi: show continuation buttons when player wins
      if (session.gameType === "xucxac_trenduoi" && result.won === true) {
        session.lastDice1 = result.result.dice as number;
        session.amount = amount;
        session.betType = undefined;
        session.status = "waiting_trenduoi_continue";
        this.gameSessions.set(userId, session);
        await this.bot.sendMessage(chatId,
          `🎲 <b>CƯỢC TIẾP!</b> Kết quả vừa rồi: <b>${result.result.dice}</b>\n` +
          `💰 Cược: ${amount.toLocaleString()}đ — Chọn cửa tiếp theo:`,
          {
            parse_mode: 'HTML',
            reply_markup: { inline_keyboard: [[
              { text: "🔺 TRÊN", callback_data: "bet_tren" },
              { text: "🎯 ĐÚNG", callback_data: "bet_dung" },
              { text: "🔻 DƯỚI", callback_data: "bet_duoi" }
            ]] }
          }
        );
        return;
      }

      // Keep session for potential play again, but reset bet type
      session.betType = undefined;
      session.status = "completed";
      this.gameSessions.set(userId, session);
      
      // Notify admin via websocket
      this.notifyAdminGameResult(userId, session.gameType, amount, result.won);

    } catch (error) {
      console.error("Error in processGameBet:", error);
      await this.bot.sendMessage(chatId, "⚠️ Có lỗi xảy ra trong game. Vui lòng thử lại!");
      this.clearGameSession(userId);
    }
  }

  // Complete an xucxac bet after the player has clicked "Tung Xúc Xắc!"
  // Called when player sends 3 dice emoji — uses their actual dice values
  private async completePendingXucXacBetWithValues(chatId: number, userId: string, session: GameSession, diceValues: number[]) {
    if (!this.bot) return;
    try {
      const betType = session.betType!;
      const amount = session.pendingBetAmount!;
      const newBalance = session.pendingNewBalance!;
      const gameSessionId = session.pendingGameSessionId!;

      const total = diceValues.reduce((s, v) => s + v, 0);
      const diceEmojis = ['⚀','⚁','⚂','⚃','⚄','⚅'];

      let won = false;
      if (betType === "xxc" && total % 2 === 0) won = true;
      if (betType === "xxl" && total % 2 === 1) won = true;
      if (betType === "xxt" && total >= 11) won = true;
      if (betType === "xxx" && total <= 10) won = true;

      let resultType = "";
      if (betType === "xxc" || betType === "xxl") {
        resultType = total % 2 === 0 ? "CHẴN" : "LẺ";
      } else {
        resultType = total >= 11 ? "TÀI" : "XỈU";
      }

      let resultText = `🎲 <b>KẾT QUẢ XÚC XẮC (NGƯỜI TUNG):</b>\n` +
        `${diceEmojis[diceValues[0]-1]} ${diceEmojis[diceValues[1]-1]} ${diceEmojis[diceValues[2]-1]}\n` +
        `📊 Tổng: <b>${total}</b> điểm (${resultType})\n`;

      let winAmount = 0;
      if (won) {
        const multiplier = this.gameMultipliers["xucxac"] ?? 1.93;
        winAmount = Math.floor(amount * multiplier);
        const profit = winAmount - amount;
        const finalBalance = (parseFloat(newBalance) + winAmount).toString();
        await storage.updateBotUser(userId, { balance: finalBalance });
        resultText += `✅ THẮNG CUỘC\n💵 Tiền thưởng: +${winAmount.toLocaleString()}đ\n📈 Lợi nhuận: +${profit.toLocaleString()}đ\n💰 Số dư: ${parseFloat(finalBalance).toLocaleString()}đ`;
        await storage.updateGameSession(gameSessionId, { status: "completed", winAmount: winAmount.toString(), result: { dice: diceValues, total }, completedAt: new Date() });
        await storage.createTransaction({ userId, type: "win", amount: winAmount.toString(), status: "completed", method: "game_win", metadata: { gameType: "xucxac", gameSessionId } });
      } else {
        resultText += `❌ THUA CUỘC\n💸 Đã trừ: -${amount.toLocaleString()}đ\n💰 Số dư: ${parseFloat(newBalance).toLocaleString()}đ`;
        await storage.updateGameSession(gameSessionId, { status: "completed", winAmount: "0", result: { dice: diceValues, total }, completedAt: new Date() });
      }

      await storage.createTransaction({ userId, type: "bet", amount: amount.toString(), status: "completed", method: "game_bet", metadata: { gameType: "xucxac", gameSessionId } });
      await this.bot.sendMessage(chatId, resultText, { parse_mode: 'HTML' });

      session.status = "completed";
      session.betType = undefined;
      session.throwMode = undefined;
      session.pendingGameSessionId = undefined;
      session.pendingBetAmount = undefined;
      session.pendingNewBalance = undefined;
      this.gameSessions.set(userId, session);
    } catch (error) {
      console.error("Error completing xucxac bet with player values:", error);
      await this.bot.sendMessage(chatId, "⚠️ Có lỗi xảy ra khi xử lý cược!");
    }
  }

  private async completePendingXucXacBet(chatId: number, userId: string, session: GameSession) {
    if (!this.bot) return;
    try {
      await this.bot.sendMessage(chatId, "🎲 Đang tung xúc xắc...");
      const result = await this.executeXucXac(session.betType!, chatId);
      const amount = session.pendingBetAmount!;
      const newBalance = session.pendingNewBalance!;
      const gameSessionId = session.pendingGameSessionId!;

      let winAmount = 0;
      let resultText = result.resultText;

      if (result.won === true) {
        const multiplier = this.gameMultipliers["xucxac"] ?? 1.93;
        winAmount = Math.floor(amount * multiplier);
        const profit = winAmount - amount;
        const finalBalance = (parseFloat(newBalance) + winAmount).toString();
        await storage.updateBotUser(userId, { balance: finalBalance });
        resultText += `✅ THẮNG CUỘC\n💵 Tiền thưởng: +${winAmount.toLocaleString()}đ\n📈 Lợi nhuận: +${profit.toLocaleString()}đ\n💰 Số dư: ${parseFloat(finalBalance).toLocaleString()}đ`;
        await storage.updateGameSession(gameSessionId, { status: "completed", winAmount: winAmount.toString(), result: result.result, completedAt: new Date() });
        await storage.createTransaction({ userId, type: "win", amount: winAmount.toString(), status: "completed", method: "game_win", metadata: { gameType: "xucxac", gameSessionId } });
      } else if (result.won === null) {
        const refundBalance = (parseFloat(newBalance) + amount).toString();
        await storage.updateBotUser(userId, { balance: refundBalance });
        resultText += `🤝 HÒA — Hoàn tiền\n💰 Số dư: ${parseFloat(refundBalance).toLocaleString()}đ`;
        await storage.updateGameSession(gameSessionId, { status: "completed", winAmount: amount.toString(), result: result.result, completedAt: new Date() });
      } else {
        resultText += `❌ THUA CUỘC\n💸 Đã trừ: -${amount.toLocaleString()}đ\n💰 Số dư: ${parseFloat(newBalance).toLocaleString()}đ`;
        await storage.updateGameSession(gameSessionId, { status: "completed", winAmount: "0", result: result.result, completedAt: new Date() });
      }

      await storage.createTransaction({ userId, type: "bet", amount: amount.toString(), status: "completed", method: "game_bet", metadata: { gameType: "xucxac", gameSessionId } });
      await this.bot.sendMessage(chatId, resultText, { parse_mode: 'HTML' });

      session.status = "completed";
      session.betType = undefined;
      session.throwMode = undefined;
      session.pendingGameSessionId = undefined;
      session.pendingBetAmount = undefined;
      session.pendingNewBalance = undefined;
      this.gameSessions.set(userId, session);
    } catch (error) {
      console.error("Error completing pending xucxac bet:", error);
      await this.bot.sendMessage(chatId, "⚠️ Có lỗi xảy ra khi xử lý cược!");
    }
  }

  // Join a solo dice room — shared logic used by /vao command and deep-link /start join_CODE
  private async handleJoinSoloDiceRoom(chatId: number, userId: string, roomCode: string) {
    if (!this.bot) return;
    const room = this.soloDiceRooms.get(roomCode);
    if (!room) {
      const openRooms = [...this.soloDiceRooms.values()].filter((r: any) => r.status === "waiting");
      let msg = `❌ Phòng <code>${roomCode}</code> không tìm thấy (có thể đã kết thúc hoặc bot khởi động lại).\n\n`;
      if (openRooms.length > 0) {
        msg += `📋 Các phòng đang mở:\n` + openRooms.map((r: any) =>
          `• <code>${r.code}</code> — ${r.betAmount.toLocaleString()}đ`
        ).join('\n');
      } else {
        msg += `💡 Tạo phòng mới: <code>/solo [số tiền]</code>`;
      }
      await this.bot.sendMessage(chatId, msg, { parse_mode: 'HTML' });
      return;
    }
    if (room.status !== "waiting") {
      await this.bot.sendMessage(chatId, "❌ Phòng đã bắt đầu hoặc đã kết thúc!");
      return;
    }
    if (room.players.length >= 2) {
      await this.bot.sendMessage(chatId, "❌ Phòng đã đủ người chơi!");
      return;
    }
    if (room.players.some((p: any) => p.userId === userId)) {
      await this.bot.sendMessage(chatId, "❌ Bạn đã ở trong phòng này rồi!");
      return;
    }

    const joinerData = await storage.getBotUser(userId);
    if (!joinerData) {
      await this.bot.sendMessage(chatId, "❌ Không tìm thấy thông tin tài khoản.");
      return;
    }
    if (parseFloat(joinerData.balance || "0") < room.betAmount) {
      await this.bot.sendMessage(chatId, `❌ Số dư không đủ! Cần <b>${room.betAmount.toLocaleString()}đ</b>\n💳 Số dư hiện tại: <b>${parseFloat(joinerData.balance || "0").toLocaleString()}đ</b>`, { parse_mode: 'HTML' });
      return;
    }

    // Deduct balance
    const newBal = (parseFloat(joinerData.balance || "0") - room.betAmount).toString();
    await storage.updateBotUser(userId, { balance: newBal });

    room.players.push({ userId, chatId, rolled: false, total: 0 });
    room.status = "rolling";
    this.soloDiceRooms.set(roomCode, room);

    // Xoá tin đăng trên nhóm vì đã có người vào
    if (room.groupMessageId && room.groupChatId) {
      try {
        await this.bot.deleteMessage(room.groupChatId, room.groupMessageId);
      } catch { /* ignore if already deleted */ }
    }

    await this.bot.sendMessage(chatId,
      `🎲 <b>VÀO PHÒNG THÀNH CÔNG!</b>\n\n` +
      `🔑 Mã: <code>${roomCode}</code>\n` +
      `💰 Cược: <b>${room.betAmount.toLocaleString()}đ</b>\n\n` +
      `👇 Nhấn nút để tung xúc xắc của bạn:`,
      {
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [[
          { text: "🎲 Tung Xúc Xắc!", callback_data: `solo_roll_${roomCode}` }
        ]] }
      }
    );

    // Notify creator
    await this.bot.sendMessage(room.creatorChatId,
      `🎲 <b>CÓ NGƯỜI VÀO PHÒNG!</b>\n\n` +
      `🔑 Phòng: <code>${roomCode}</code>\n` +
      `👥 Người chơi: 2/2\n\n` +
      `👇 Nhấn nút để tung xúc xắc của bạn:`,
      {
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [[
          { text: "🎲 Tung Xúc Xắc!", callback_data: `solo_roll_${roomCode}` }
        ]] }
      }
    );
  }

  // Process solo dice roll — called when player taps "🎲 Tung Xúc Xắc!" in a solo room
  private async processSoloDiceRoll(chatId: number, userId: string, roomCode: string) {
    if (!this.bot) return;
    const room = this.soloDiceRooms.get(roomCode);
    if (!room) {
      await this.bot.sendMessage(chatId, "❌ Không tìm thấy phòng!");
      return;
    }
    const player = room.players.find((p: any) => p.userId === userId);
    if (!player) {
      await this.bot.sendMessage(chatId, "❌ Bạn không ở trong phòng này!");
      return;
    }
    if (player.rolled) {
      await this.bot.sendMessage(chatId, "✅ Bạn đã tung rồi, đang chờ đối thủ...");
      return;
    }

    // Roll 3 dice for this player
    const diceResults = await this.sendAnimatedDice(chatId, 3, "🎲");
    const total = diceResults.reduce((s: number, v: number) => s + v, 0);
    player.rolled = true;
    player.total = total;
    const diceEmojis = ['⚀','⚁','⚂','⚃','⚄','⚅'];
    await this.bot.sendMessage(chatId,
      `🎲 Kết quả: ${diceEmojis[diceResults[0]-1]} ${diceEmojis[diceResults[1]-1]} ${diceEmojis[diceResults[2]-1]}\n📊 Tổng: <b>${total}</b>`,
      { parse_mode: 'HTML' }
    );

    this.soloDiceRooms.set(roomCode, room);

    // Check if all players have rolled
    const allRolled = room.players.every((p: any) => p.rolled);
    if (!allRolled) {
      await this.bot.sendMessage(chatId, "⏳ Đang chờ đối thủ tung...");
      return;
    }

    // Determine winner
    const p1 = room.players[0];
    const p2 = room.players[1];
    const isTie = p1.total === p2.total;
    const winnerPlayer = isTie ? null : (p1.total > p2.total ? p1 : p2);
    const loserPlayer = isTie ? null : (p1.total > p2.total ? p2 : p1);

    const prize = Math.floor(room.betAmount * 2 * 0.95); // x1.9 total pool

    // Pay winner
    if (winnerPlayer) {
      const winnerData = await storage.getBotUser(winnerPlayer.userId);
      if (winnerData) {
        const newBal = (parseFloat(winnerData.balance || "0") + prize).toString();
        await storage.updateBotUser(winnerPlayer.userId, { balance: newBal });
      }
    } else {
      // Tie: refund both
      for (const p of room.players) {
        const pData = await storage.getBotUser(p.userId);
        if (pData) {
          const refundBal = (parseFloat(pData.balance || "0") + room.betAmount).toString();
          await storage.updateBotUser(p.userId, { balance: refundBal });
        }
      }
    }

    // Send result to each player
    for (const p of room.players) {
      const isWinner = winnerPlayer && p.userId === winnerPlayer.userId;
      const resultMsg = isTie
        ? `🤝 <b>HÒA!</b> Hoàn tiền ${room.betAmount.toLocaleString()}đ`
        : isWinner
          ? `🎉 <b>BẠN THẮNG!</b> +${prize.toLocaleString()}đ`
          : `😢 <b>BẠN THUA!</b> -${room.betAmount.toLocaleString()}đ`;

      await this.bot.sendMessage(p.chatId,
        `🎲 <b>KẾT QUẢ SOLO XÚC XẮC</b>\n\n` +
        `👤 Người chơi 1: <b>${p1.total}</b> điểm\n` +
        `👤 Người chơi 2: <b>${p2.total}</b> điểm\n\n` +
        `${resultMsg}`,
        { parse_mode: 'HTML' }
      );
    }

    room.status = "done";
    this.soloDiceRooms.set(roomCode, room);
    // Clean up after 5 min
    setTimeout(() => this.soloDiceRooms.delete(roomCode), 300000);
  }

  private async sendAnimatedDice(chatId: number, count: number = 1, emoji: string = "🎲"): Promise<number[]> {
    const results: number[] = [];
    
    for (let i = 0; i < count; i++) {
      try {
        // Send dice emoji using Telegram's built-in dice animation
        const message = await this.bot!.sendDice(chatId, { emoji });
        results.push(message.dice!.value);
        
        // Add delay between dice (except for the last one)
        if (i < count - 1) {
          await new Promise(resolve => setTimeout(resolve, 800)); // 0.8 second delay
        }
      } catch (error) {
        console.error("Error sending dice:", error);
        // Fallback to random number if sendDice fails
        results.push(Math.floor(Math.random() * 6) + 1);
      }
    }
    
    return results;
  }

  private async executeGame(gameType: string, betType: string, chatId: number): Promise<GameResult> {
    switch (gameType) {
      case "taixiu":
      case "taixiu_md5":
        return this.executeTaiXiu(betType, chatId, gameType === "taixiu_md5");
      case "taixiu_room":
        return this.executeTaiXiuRoom(betType, chatId);
      case "chanle":
        return this.executeChanLe(betType, chatId);
      case "xucxac":
        return this.executeXucXac(betType, chatId);
      case "xucxac_trenduoi":
        return this.executeXucXacTrenDuoi(betType, chatId);
      case "phitieu":
        return this.executePhiTieu(betType, chatId);
      case "quaythuong":
        return this.executeQuayThuong(betType, chatId);
      default:
        throw new Error(`Unknown game type: ${gameType}`);
    }
  }

  private async executeTaiXiu(betType: string, chatId: number, isMD5: boolean = false): Promise<GameResult> {
    if (isMD5) {
      return this.executeTaiXiuMD5(betType, chatId);
    }
    
    // Send 3 dice one by one with animation
    const diceResults = await this.sendAnimatedDice(chatId, 3, "🎲");
    const total = diceResults.reduce((sum, dice) => sum + dice, 0);
    
    let won = false;
    if (betType === "tai" && total >= 11) won = true;
    if (betType === "xiu" && total <= 10) won = true;
    
    // Use actual dice emojis for display
    const diceEmojis = ['⚀', '⚁', '⚂', '⚃', '⚄', '⚅'];
    const resultText = `🎲 <b>KẾT QUẢ TÀI XỈU:</b>\n` +
                      `${diceEmojis[diceResults[0]-1]} ${diceEmojis[diceResults[1]-1]} ${diceEmojis[diceResults[2]-1]}\n` +
                      `📊 Tổng: <b>${total}</b> điểm (${total >= 11 ? "TÀI" : "XỈU"})\n`;
    
    // Save result for stats display
    try {
      const resultCode = total >= 11 ? 'T' : 'X';
      const recentStr = await storage.getSetting('recent_taixiu');
      const recent: string[] = recentStr ? JSON.parse(recentStr) : [];
      recent.push(resultCode);
      if (recent.length > 20) recent.shift();
      await storage.setSetting('recent_taixiu', JSON.stringify(recent));
    } catch { /* ignore */ }

    return {
      won,
      result: { dice: diceResults, total },
      resultText
    };
  }

  private async executeTaiXiuMD5(betType: string, chatId: number): Promise<GameResult> {
    // Generate predefined dice results (1-6)
    const diceResults = [
      Math.floor(Math.random() * 6) + 1,
      Math.floor(Math.random() * 6) + 1,
      Math.floor(Math.random() * 6) + 1
    ];
    
    // Generate random session ID and salt
    const sessionId = Math.floor(Math.random() * 10000000);
    const salt = Math.random().toString(36).substring(2, 12);
    
    // Create hidden code with dice results embedded
    const hiddenCode = `${sessionId}:${salt}{${diceResults[0]}-${diceResults[1]}-${diceResults[2]}}${Math.random().toString(36).substring(2, 12)}`;
    
    // Generate MD5 hash
    const md5Hash = crypto.createHash('md5').update(hiddenCode).digest('hex');
    
    // Show MD5 hash first (provably fair)
    await this.bot!.sendMessage(chatId, 
      `🔐 <b>MÃ MD5 CÔNG BẰNG:</b>\n` +
      `<code>${md5Hash}</code>\n\n` +
      `⏳ Đang chuẩn bị kết quả...`,
      { parse_mode: 'HTML' }
    );

    // Wait 3 seconds for drama
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    // Reveal original code
    await this.bot!.sendMessage(chatId,
      `🔓 <b>MÃ GỐC:</b>\n` +
      `<code>${hiddenCode}</code>\n\n` +
      `🎲 Kết quả từ mã: {${diceResults[0]}-${diceResults[1]}-${diceResults[2]}}`,
      { parse_mode: 'HTML' }
    );

    // Send visual dice animation (showing predetermined results)
    await this.sendPredeterminedDice(chatId, diceResults);
    
    const total = diceResults.reduce((sum, dice) => sum + dice, 0);
    
    let won = false;
    if (betType === "tai" && total >= 11) won = true;
    if (betType === "xiu" && total <= 10) won = true;
    
    // Use actual dice emojis for display
    const diceEmojis = ['⚀', '⚁', '⚂', '⚃', '⚄', '⚅'];
    const resultText = `🎲 <b>KẾT QUẢ TÀI XỈU MD5:</b>\n` +
                      `${diceEmojis[diceResults[0]-1]} ${diceEmojis[diceResults[1]-1]} ${diceEmojis[diceResults[2]-1]}\n` +
                      `📊 Tổng: <b>${total}</b> điểm (${total >= 11 ? "TÀI" : "XỈU"})\n` +
                      `🔐 Mã MD5: <code>${md5Hash}</code>\n` +
                      `🔓 Mã gốc: <code>${hiddenCode}</code>\n`;
    
    return {
      won,
      result: { dice: diceResults, total, md5Hash, hiddenCode },
      resultText
    };
  }

  // Method to send predetermined dice results with visual animation
  // Tài xỉu room functionality - now handled by Bot2
  // Keeping minimal state for compatibility
  private taixiuRoomState = {
    isActive: false,
    participants: new Map<string, { betType: string, amount: number, userId: string, chatId: number, username?: string }>(),
    roomResult: null as { dice: number[], total: number } | null,
    timer: null as NodeJS.Timeout | null,
    roundId: 0
  };

  private async executeTaiXiuRoom(betType: string, chatId: number): Promise<GameResult> {
    // Return error - room bets should not use this path
    throw new Error('Tài xỉu room bets must be processed through the room system');
  }

  private async joinTaiXiuRoom(betType: string, betAmount: number, chatId: number, username?: string): Promise<void> {
    const userId = chatId.toString();
    
    try {
      // Get user data and check balance using storage
      const userData = await storage.getBotUser(userId);
      if (!userData) {
        throw new Error('User not found');
      }
      
      const currentBalance = parseFloat(userData.balance || "0");
      if (currentBalance < betAmount) {
        throw new Error(`Không đủ tiền! Số dư: ${currentBalance.toLocaleString()}đ`);
      }

      // Deduct balance from user account
      const newBalance = (currentBalance - betAmount).toString();
      await storage.updateBotUser(userId, { balance: newBalance });
      
      // Send bet to Bot2 instead of handling locally
      const success = await this.sendBetToBot2(userId, betType.toUpperCase(), betAmount);
      
      if (!success) {
        // If failed to send to Bot2, refund the user
        await storage.updateBotUser(userId, { balance: currentBalance.toString() });
        throw new Error('Không thể kết nối đến phòng tài xỉu. Vui lòng thử lại sau.');
      }
      
      // Send confirmation to user
      await this.bot!.sendMessage(chatId,
        `🎯 <b>ĐÃ GỬI CƯỢC ĐẾN PHÒNG TÀI XỈU</b>\n\n` +
        `💰 Cược: ${betAmount.toLocaleString()}đ (${betType.toUpperCase()})\n` +
        `💎 Số dư còn lại: ${parseFloat(newBalance).toLocaleString()}đ\n\n` +
        `🏛️ Cược đã được gửi đến phòng tài xỉu (ẩn danh)\n` +
        `⏳ Đợi kết quả từ phòng...`,
        { parse_mode: 'HTML' }
      );
      
    } catch (error) {
      console.error('Error in joinTaiXiuRoom:', error);
      throw error;
    }
  }

  // Admin command to set room results - now delegates to Bot2
  private async setRoomResults(diceResults: number[]): Promise<void> {
    try {
      if (diceResults.length !== 3 || diceResults.some(d => d < 1 || d > 6)) {
        throw new Error('Kết quả xúc xắc không hợp lệ (phải là 3 số từ 1-6)');
      }

      // Import bot2 service and set results there
      const { telegramBot2Service } = await import('./telegramBot2');
      
      // Set results in Bot2 - Bot2 will handle processing and notify this bot
      await telegramBot2Service.setDiceResults(diceResults);
      
      console.log(`✅ Dice results ${diceResults.join(', ')} sent to Bot2`);
      
    } catch (error) {
      console.error('Error setting room results:', error);
      throw error;
    }
  }

  private async sendPredeterminedDice(chatId: number, predeterminedResults: number[]): Promise<void> {
    for (let i = 0; i < predeterminedResults.length; i++) {
      try {
        // Send a text message showing which die result will appear
        await this.bot!.sendMessage(chatId, 
          `🎲 Xúc xắc ${i + 1}: ${predeterminedResults[i]}`,
          { parse_mode: 'HTML' }
        );
        
        // Add delay between dice
        if (i < predeterminedResults.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 1500));
        }
      } catch (error) {
        console.error("Error sending predetermined dice:", error);
      }
    }
  }

  // Provably Fair MD5 Game Processing
  private async processMD5GameBet(chatId: number, userId: string, session: GameSession, amount: number, user: any) {
    if (!this.bot) return;

    try {
      // Generate predefined dice results (1-6)
      const diceResults = [
        Math.floor(Math.random() * 6) + 1,
        Math.floor(Math.random() * 6) + 1,
        Math.floor(Math.random() * 6) + 1
      ];
      
      // Generate random session ID and salt
      const sessionId = Math.floor(Math.random() * 10000000);
      const salt = Math.random().toString(36).substring(2, 12);
      
      // Create hidden code with dice results embedded (format exactly as user requested)
      const hiddenCode = `${sessionId}:${salt}{${diceResults[0]}-${diceResults[1]}-${diceResults[2]}}${Math.random().toString(36).substring(2, 12)}`;
      
      // Generate MD5 hash
      const md5Hash = crypto.createHash('md5').update(hiddenCode).digest('hex');
      
      // Show MD5 hash first (commit phase)
      await this.bot.sendMessage(chatId, 
        `🔐 <b>MÃ MD5 CÔNG BẰNG:</b>\n` +
        `<code>${md5Hash}</code>\n\n` +
        `⚔️ Đây là mã bảo mật để đảm bảo tính công bằng!\n` +
        `🎯 Đã cược ${amount.toLocaleString()}đ vào ${this.getBetName(session.betType!)}\n` +
        `⏳ Đang chuẩn bị kết quả...`,
        { parse_mode: 'HTML' }
      );

      // Deduct balance
      const newBalance = (parseFloat(user.balance || "0") - amount).toString();
      await storage.updateBotUser(userId, { 
        balance: newBalance,
        totalGames: (user.totalGames || 0) + 1 
      });

      // Track betting stats for rankings
      try {
        const now = this.nowVN();
        const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
        const weekNumber = this.getWeekNumber(now);
        const weekYearStr = `${now.getFullYear()}-W${String(weekNumber).padStart(2, '0')}`;
        await storage.createOrUpdateBettingStats(userId, dateStr, weekYearStr, amount);
        console.log(`📊 Tracking bet: ${userId}, ${amount}, ${dateStr}`);
      } catch (error) {
        console.error('Error tracking betting stats:', error);
        // Don't throw - continue with game even if stats tracking fails
      }

      // Create game session record with MD5 data
      const gameSession = await storage.createGameSession({
        userId,
        gameType: session.gameType,
        betType: session.betType!,
        betAmount: amount.toString(),
        status: "pending",
        result: {
          md5Hash,
          hiddenCode,
          dice: diceResults,
          isProvablyFair: true
        }
      });

      // Wait 3 seconds for suspense
      await new Promise(resolve => setTimeout(resolve, 3000));
      
      // Reveal original code (reveal phase)
      await this.bot.sendMessage(chatId,
        `🔓 <b>CÔNG BỐ MÃ GỐC:</b>\n` +
        `<code>${hiddenCode}</code>\n\n` +
        `🎲 Kết quả từ mã: {${diceResults[0]}-${diceResults[1]}-${diceResults[2]}}`,
        { parse_mode: 'HTML' }
      );

      // Send visual dice animation with predetermined results
      await this.sendPredeterminedDice(chatId, diceResults);
      
      const total = diceResults.reduce((sum, dice) => sum + dice, 0);
      
      let won = false;
      if (session.betType === "tai" && total >= 11) won = true;
      if (session.betType === "xiu" && total <= 10) won = true;
      
      // Use actual dice emojis for display
      const diceEmojis = ['⚀', '⚁', '⚂', '⚃', '⚄', '⚅'];
      let resultText = `🎲 <b>KẾT QUẢ TÀI XỈU MD5:</b>\n` +
                       `${diceEmojis[diceResults[0]-1]} ${diceEmojis[diceResults[1]-1]} ${diceEmojis[diceResults[2]-1]}\n` +
                       `📊 Tổng: <b>${total}</b> điểm (${total >= 11 ? "TÀI" : "XỈU"})\n` +
                       `🔐 MD5: <code>${md5Hash}</code>\n` +
                       `🔓 Mã gốc: <code>${hiddenCode}</code>\n\n`;

      // Calculate winnings and update balance
      let winAmount = 0;
      if (won) {
        const multiplier = this.gameMultipliers[session.gameType] || 1.95;
        winAmount = Math.floor(amount * multiplier);
        const profit = winAmount - amount;
        
        // Update user balance with winnings
        const finalBalance = (parseFloat(newBalance) + winAmount).toString();
        await storage.updateBotUser(userId, { balance: finalBalance });
        
        resultText += `✅ THẮNG CUỘC\n`;
        resultText += `💵 Tiền thưởng: +${winAmount.toLocaleString()}đ\n`;
        resultText += `📈 Lợi nhuận: +${profit.toLocaleString()}đ\n`;
        resultText += `💰 Số dư: ${parseFloat(finalBalance).toLocaleString()}đ\n\n`;
        resultText += `🔍 <b>CÁCH KIỂM TRA MÃ MD5:</b>\n`;
        resultText += `1️⃣ Copy mã gốc: <code>${hiddenCode}</code>\n`;
        resultText += `2️⃣ Truy cập: md5hashgenerator.com\n`;
        resultText += `3️⃣ Dán mã gốc và tạo MD5\n`;
        resultText += `4️⃣ So sánh với mã đã công bố: <code>${md5Hash}</code>\n`;
        resultText += `✅ Nếu giống nhau = 100% công bằng!`;
        
        // Update game session
        await storage.updateGameSession(gameSession.id, {
          status: "completed",
          winAmount: winAmount.toString(),
          result: {
            md5Hash,
            hiddenCode,
            dice: diceResults,
            total,
            won: true,
            finalResult: "win",
            isProvablyFair: true
          },
          completedAt: new Date()
        });
        
        // Create win transaction
        await storage.createTransaction({
          userId,
          type: "win",
          amount: winAmount.toString(),
          status: "completed",
          method: "game_win",
          metadata: { gameType: session.gameType, gameSessionId: gameSession.id, md5Hash, hiddenCode }
        });
        
      } else {
        // Loss
        resultText += `❌ THUA CUỘC\n`;
        resultText += `💸 Đã trừ: -${amount.toLocaleString()}đ\n`;
        resultText += `💰 Số dư: ${parseFloat(newBalance).toLocaleString()}đ\n\n`;
        resultText += `🔍 <b>CÁCH KIỂM TRA MÃ MD5:</b>\n`;
        resultText += `1️⃣ Copy mã gốc: <code>${hiddenCode}</code>\n`;
        resultText += `2️⃣ Truy cập: md5hashgenerator.com\n`;
        resultText += `3️⃣ Dán mã gốc và tạo MD5\n`;
        resultText += `4️⃣ So sánh với mã đã công bố: <code>${md5Hash}</code>\n`;
        resultText += `✅ Nếu giống nhau = 100% công bằng!`;
        
        await storage.updateGameSession(gameSession.id, {
          status: "completed",
          winAmount: "0",
          result: {
            md5Hash,
            hiddenCode,
            dice: diceResults,
            total,
            won: false,
            finalResult: "loss",
            isProvablyFair: true
          },
          completedAt: new Date()
        });
      }

      // Create bet transaction
      await storage.createTransaction({
        userId,
        type: "bet",
        amount: amount.toString(),
        status: "completed",
        method: "game_bet",
        metadata: { gameType: session.gameType, gameSessionId: gameSession.id, md5Hash, hiddenCode }
      });

      // Award commission to referrer if user was referred
      const userForCommission = await storage.getBotUser(userId);
      if (userForCommission && userForCommission.referredBy) {
        await this.awardReferralCommission(userForCommission.referredBy, amount, 'game');
      }

      // Send MD5 game result (text only, no images)
      await this.bot.sendMessage(chatId, resultText, {
        parse_mode: 'HTML'
      });

      // Keep session for potential play again, but reset bet type
      session.betType = undefined;
      session.status = "completed";
      this.gameSessions.set(userId, session);
      
      // Notify admin via websocket
      this.notifyAdminGameResult(userId, session.gameType, amount, won);

    } catch (error) {
      console.error("Error in processMD5GameBet:", error);
      await this.bot.sendMessage(chatId, "⚠️ Có lỗi xảy ra trong game MD5. Vui lòng thử lại!");
      this.clearGameSession(userId);
    }
  }

  private async executeChanLe(betType: string, chatId: number): Promise<GameResult> {
    // Send 1 dice with animation
    const diceResults = await this.sendAnimatedDice(chatId, 1, "🎲");
    const dice = diceResults[0];
    
    let won = false;
    if (betType === "chan" && dice % 2 === 0) won = true;
    if (betType === "le" && dice % 2 === 1) won = true;
    
    // Use actual dice emojis
    const diceEmojis = ['⚀', '⚁', '⚂', '⚃', '⚄', '⚅'];
    const resultText = `🎲 <b>KẾT QUẢ CHẴN LẺ:</b>\n` +
                      `${diceEmojis[dice-1]}\n` +
                      `📊 Kết quả: <b>${dice}</b> (${dice % 2 === 0 ? "CHẴN" : "LẺ"})\n`;
    
    return {
      won,
      result: { dice },
      resultText
    };
  }

  private async executeXucXacTrenDuoi(betType: string, chatId: number): Promise<GameResult> {
    // Send 1 dice with animation for top/bottom game
    const diceResults = await this.sendAnimatedDice(chatId, 1, "🎲");
    const dice = diceResults[0];
    
    let won = false;
    let payoutMultiplier = 1.95;
    const isTop = dice >= 4; // 4,5,6 = TRÊN
    const isBottom = dice <= 3; // 1,2,3 = DƯỚI
    
    if (betType === "tren" && isTop) won = true;
    if (betType === "duoi" && isBottom) won = true;
    // ĐÚNG: exact number match — betType format: "dung_{targetNumber}"
    if (betType.startsWith("dung_")) {
      const target = parseInt(betType.split("_")[1]);
      if (dice === target) {
        won = true;
        payoutMultiplier = 4.0; // Higher payout for exact match
      }
    }
    
    const diceEmojis = ['⚀', '⚁', '⚂', '⚃', '⚄', '⚅'];
    let sideLabel = isTop ? "🔺 TRÊN" : "🔻 DƯỚI";
    const resultText = `🎲 <b>KẾT QUẢ XÚC XẮC TRÊN DƯỚI:</b>\n` +
                      `${diceEmojis[dice-1]}\n` +
                      `📊 Kết quả: <b>${dice}</b> (${sideLabel})\n`;
    
    return {
      won,
      result: { dice },
      resultText,
      payoutMultiplier
    };
  }

  private async executeXucXac(betType: string, chatId: number): Promise<GameResult> {
    // Send 3 dice one by one for Xúc Xắc game
    const diceResults = await this.sendAnimatedDice(chatId, 3, "🎲");
    const total = diceResults.reduce((sum, dice) => sum + dice, 0);
    
    let won = false;
    if (betType === "xxc" && total % 2 === 0) won = true;
    if (betType === "xxl" && total % 2 === 1) won = true;
    if (betType === "xxt" && total >= 11) won = true;
    if (betType === "xxx" && total <= 10) won = true;
    
    // Sử dụng emoji dice thật của Telegram
    const diceEmojis = ['⚀', '⚁', '⚂', '⚃', '⚄', '⚅'];
    let resultType = "";
    if (betType === "xxc" || betType === "xxl") {
      resultType = total % 2 === 0 ? "CHẴN" : "LẺ";
    } else {
      resultType = total >= 11 ? "TÀI" : "XỈU";
    }
    
    const resultText = `🎲 <b>KẾT QUẢ XÚC XẮC:</b>\n` +
                      `${diceEmojis[diceResults[0]-1]} ${diceEmojis[diceResults[1]-1]} ${diceEmojis[diceResults[2]-1]}\n` +
                      `📊 Tổng: <b>${total}</b> điểm (${resultType})\n`;
    
    return {
      won,
      result: { dice: diceResults, total },
      resultText
    };
  }


  private async executePhiTieu(betType: string, chatId: number): Promise<GameResult> {
    // Send darts emoji 🎯
    const results = await this.sendAnimatedDice(chatId, 1, "🎯");
    const diceResult = results[0]; // 1-6
    
    let won: boolean | null = false;
    let multiplier = 1.8;
    let targetArea = "";
    let resultEmoji = "";
    
    // Map dice results to dart areas:
    // 1-2: White areas (Vòng trắng và ra ngoài)
    // 3-4: Border - Draw (Nửa đỏ nửa trắng)
    // 5-6: Red areas and center (Vòng đỏ và tâm)
    
    if (diceResult <= 2) {
      // White areas
      targetArea = "⚪ Vòng trắng/Ra ngoài";
      resultEmoji = "⚪";
      won = (betType === "trang");
    } else if (diceResult >= 5) {
      // Red areas and center
      targetArea = diceResult === 6 ? "🔴 Hồng tâm" : "🔴 Vòng đỏ";
      resultEmoji = "🔴";
      won = (betType === "do");
    } else {
      // Border (3-4) - Draw, refund
      targetArea = "🟡 Nửa đỏ nửa trắng (Biên)";
      resultEmoji = "🟡";
      won = null; // null indicates draw/refund
      multiplier = 1.0; // Refund - return original bet
    }
    
    let resultText = `🎯 <b>KẾT QUẢ PHI TIÊU:</b>\n`;
    resultText += `${resultEmoji} ${targetArea}\n`;
    
    if (won === null) {
      resultText += `🤝 <b>HÒA!</b> Hoàn tiền (Trúng biên)\n`;
    } else if (won) {
      resultText += `🎉 <b>THẮNG!</b> Ăn x${multiplier}\n`;
    } else {
      resultText += `💔 <b>THUA!</b>\n`;
    }
    
    return {
      won: won === null ? null : won,
      result: { diceResult, targetArea, multiplier },
      resultText,
      payoutMultiplier: won === true ? multiplier : (won === null ? 1.0 : undefined)
    };
  }

  private async executeQuayThuong(betType: string, chatId: number): Promise<GameResult> {
    // Send slot machine emoji 🎰
    const results = await this.sendAnimatedDice(chatId, 1, "🎰");
    
    // Generate 3 slot symbols based on dice result
    const symbols = ['🍒', '🍋', '🍊', '⭐', '🔔', '💎', '7️⃣'];
    const slot1 = symbols[crypto.randomInt(0, symbols.length)];
    const slot2 = symbols[crypto.randomInt(0, symbols.length)];
    const slot3 = symbols[crypto.randomInt(0, symbols.length)];
    
    let won = false;
    let multiplier = 0;
    
    // Check for 3 same symbols = x15
    if (slot1 === slot2 && slot2 === slot3) {
      won = true;
      multiplier = 15.0; // As requested by user
    }
    // Check for 2 same symbols = x1.5  
    else if (slot1 === slot2 || slot2 === slot3 || slot1 === slot3) {
      won = true;
      multiplier = 1.5; // As requested by user
    }
    // 3 different = lose (won = false, multiplier = 0)
    
    const resultText = `🎰 <b>KẾT QUẢ QUAY THƯỞNG:</b>\n` +
                      `${slot1} | ${slot2} | ${slot3}\n` +
                      (won ? `🎉 JACKPOT! Thắng x${multiplier}!\n` : `💔 3 khác nhau - Thua hết!\n`);
    
    return {
      won,
      result: { slots: [slot1, slot2, slot3], multiplier },
      resultText,
      payoutMultiplier: won ? multiplier : undefined
    };
  }

  private getDiceEmojiForGame(gameType: string): string | null {
    const diceEmojiMap: { [key: string]: string } = {
      "phitieu": "🎯",
      "chanle": "🎲",
      "xucxac": "🎲",
      "taixiu": "🎲",
      "taixiu_md5": "🎲",
      "taixiu_room": "🎲",
      "quaythuong": "🎰"
    };
    return diceEmojiMap[gameType] || null;
  }

  private needsDiceEmojiButton(gameType: string): boolean {
    // Games that need user to manually trigger dice roll
    const gamesNeedingButton = ["xucxac", "chanle", "phitieu"];
    return gamesNeedingButton.includes(gameType);
  }

  private async showDiceEmojiKeyboard(chatId: number, gameType: string) {
    if (!this.bot) return;

    const diceEmoji = this.getDiceEmojiForGame(gameType);
    if (!diceEmoji) return;

    // Create reply keyboard with the dice emoji button
    const keyboard = {
      keyboard: [
        [{ text: diceEmoji }]
      ],
      resize_keyboard: true,
      one_time_keyboard: true
    };

    const gameNames: { [key: string]: string } = {
      "xucxac": "🎲 XÚC XẮC",
      "chanle": "🎲 CHẴN LẺ",
      "phitieu": "🎯 PHI TIÊU"
    };

    const gameName = gameNames[gameType] || gameType.toUpperCase();
    
    await this.bot.sendMessage(chatId, 
      `🎮 ${gameName}\n\n` +
      `✨ Bấm nút ${diceEmoji} bên dưới để tung!\n` +
      `🎯 Chúc bạn may mắn!`,
      {
        reply_markup: keyboard,
        parse_mode: "HTML"
      }
    );
  }

  private getBetName(betType: string): string {
    const betNames: { [key: string]: string } = {
      "tai": "TÀI", "xiu": "XỈU", "chan": "CHẴN", "le": "LẺ",
      "xxc": "CHẴN", "xxl": "LẺ", "xxx": "XỈU", "xxt": "TÀI",
      "do": "🔴 ĐỎ", "trang": "⚪ TRẮNG", "quay": "QUAY"
    };
    return betNames[betType] || betType.toUpperCase();
  }

  async notifyPaymentSuccess(userId: string, amount: number, transactionId: string) {
    if (!this.bot) return;

    try {
      const user = await storage.getBotUser(userId);
      if (!user) return;

      // Check if this user was referred by someone and award commission
      if (user.referredBy) {
        await this.awardReferralCommission(user.referredBy, amount, 'deposit');
      }

      const caption = `✅ *Nạp thành công ${amount.toLocaleString()}đ*\n` +
                     `💰 Số dư: ${Number(user.balance).toLocaleString()}đ`;

      await this.bot.sendMessage(parseInt(userId), caption, {
        parse_mode: "Markdown"
      });

      // Group notification for bank deposit if enabled
      try {
        const notifyEnabled = await storage.getSetting('bank_deposit_notify');
        if (notifyEnabled === '1') {
          const MAIN_GROUP = -1003132451812;
          const maskedId = `****${userId.slice(-5)}`;
          await this.bot.sendMessage(MAIN_GROUP,
            `🎉🧧 [BOT] Người chơi ID: ${maskedId}\n- Nạp Bank thành công: ${amount.toLocaleString('vi-VN')}đ`
          );
        }
      } catch { /* ignore */ }

      // Broadcast to admin dashboard if websocket available
      if (this.websocketServer && this.websocketServer.clients) {
        const notification = {
          type: "payment_success",
          data: {
            userId,
            amount,
            transactionId,
            timestamp: new Date().toISOString()
          }
        };

        this.websocketServer.clients.forEach((client) => {
          if (client.readyState === 1) { // WebSocket.OPEN
            client.send(JSON.stringify(notification));
          }
        });
      }

    } catch (error) {
      console.error("Error sending payment notification:", error);
    }
  }

  private notifyAdminGameResult(userId: string, gameType: string, amount: number, won: boolean | null) {
    if (this.websocketServer && this.websocketServer.clients) {
      const notification = {
        type: "game_result",
        data: {
          userId,
          gameType,
          amount,
          won,
          timestamp: new Date().toISOString()
        }
      };

      this.websocketServer.clients.forEach((client) => {
        if (client.readyState === 1) {
          client.send(JSON.stringify(notification));
        }
      });
    }
  }

  // Award commission to referrer
  private async awardReferralCommission(referralCode: string, amount: number, type: 'deposit' | 'game') {
    try {
      // Find referrer by referralCode field OR by user ID (backward compat with old links that stored userId)
      const allUsers = await storage.getAllBotUsers();
      const referrer = allUsers.find(u =>
        (u.referralCode && u.referralCode === referralCode) ||
        u.id === referralCode
      );
      
      if (!referrer) return;
      
      // Calculate commission: read rates from admin settings (commission_deposit_rate and commission_game_rate, stored as %)
      const depositPct = await getSettingNumber('commission_deposit_rate', 5);
      const gamePct = await getSettingNumber('commission_game_rate', 1);
      const commissionRate = type === 'deposit' ? depositPct / 100 : gamePct / 100;
      const commissionAmount = Math.floor(amount * commissionRate);
      
      // Update referrer's commission
      const newCommission = (parseFloat(referrer.commission || "0") + commissionAmount).toString();
      await storage.updateBotUser(referrer.id, { commission: newCommission });
      
      // Create commission transaction
      await storage.createTransaction({
        userId: referrer.id,
        type: "commission",
        amount: commissionAmount.toString(),
        status: "completed",
        method: "referral_" + type,
        metadata: { 
          referralType: type,
          originalAmount: amount,
          commissionRate: commissionRate
        }
      });
      
      // Notify referrer
      if (this.bot) {
        const typeText = type === 'deposit' ? 'nạp tiền' : 'chơi game';
        await this.bot.sendMessage(
          parseInt(referrer.id),
          `🌸 **HOA HỒNG KAWAII!**\n\n` +
          `💰 Bạn nhận được ${commissionAmount.toLocaleString()}đ hoa hồng từ ${typeText}!\n` +
          `🌱 Tổng hoa hồng: ${parseFloat(newCommission).toLocaleString()}đ`,
          { parse_mode: "Markdown" }
        );
      }
    } catch (error) {
      console.error("Error awarding referral commission:", error);
    }
  }

  async updateBotToken(newToken: string) {
    await this.initialize(newToken, this.websocketServer);
  }

  isActive(): boolean {
    return this.bot !== null;
  }

  // Message queue processing system
  private startMessageQueueProcessor() {
    if (this.isProcessingQueue) return;
    
    this.isProcessingQueue = true;
    this.processMessageQueue();
  }

  private async processMessageQueue() {
    while (this.isProcessingQueue && this.bot) {
      if (this.messageQueue.length === 0) {
        await new Promise(resolve => setTimeout(resolve, 5)); // Ultra-fast processing for maximum responsiveness
        continue;
      }

      // Process larger batches for better throughput
      const batchSize = Math.min(10, this.messageQueue.length); // Larger batch size for faster processing
      const batch = [];
      
      // Sort queue by priority (high, normal, low) first
      this.messageQueue.sort((a, b) => {
        const priorityOrder = { high: 0, normal: 1, low: 2 };
        return priorityOrder[a.priority] - priorityOrder[b.priority];
      });

      // Get batch of messages to send, filter duplicates
      for (let i = 0; i < batchSize; i++) {
        const message = this.messageQueue.shift();
        if (message) {
          // Improved duplicate message prevention
          const messageKey = `${message.chatId}_${message.content.substring(0, 100)}`; // Longer hash for better detection
          const lastSent = this.messageCache.get(messageKey) || 0;
          if (Date.now() - lastSent > 3000) { // Increased to 3 seconds to prevent duplicates
            batch.push(message);
            this.messageCache.set(messageKey, Date.now());
          } else {
            console.log(`🚫 Blocked duplicate message: ${messageKey}`);
          }
        }
      }

      // Send messages with optimized rate limiting
      const promises = batch.map(async (message, index) => {
        try {
          // Optimized per-chat rate limiting (even faster)
          const lastChatMessage = this.lastChatMessages.get(message.chatId) || 0;
          const timeSinceLastMessage = Date.now() - lastChatMessage;
          if (timeSinceLastMessage < 200) { // Reduced to 200ms for faster delivery
            await new Promise(resolve => setTimeout(resolve, 200 - timeSinceLastMessage));
          }

          // Optimized global rate limiting with ultra-fast stagger timing
          if (index > 0) {
            await new Promise(resolve => setTimeout(resolve, (1000 / this.messageRateLimit) * index * 0.2)); // Ultra-fast timing
          }

          // Send message
          if (message.type === 'message') {
            await this.bot!.sendMessage(message.chatId, message.content, message.options);
          } else if (message.type === 'photo') {
            // Photos disabled to reduce lag - send caption as text instead
            if (message.options && message.options.caption) {
              await this.bot!.sendMessage(message.chatId, message.options.caption, { 
                parse_mode: message.options.parse_mode || 'HTML', 
                reply_markup: message.options.reply_markup 
              });
            }
          }

          // Update timing trackers
          this.lastMessageTime = Date.now();
          this.lastChatMessages.set(message.chatId, Date.now());
        } catch (error) {
          console.error("Error sending queued message:", error);
          
          // Retry logic - add back to queue with reduced retries to prevent duplicates
          if (message.retries < 2) { // Reduced from 3 to 2 to prevent duplicate messages
            message.retries++;
            message.priority = 'low';
            this.messageQueue.push(message);
          }
        }
      });

      // Wait for batch to complete
      await Promise.allSettled(promises);
    }
  }

  private queueMessage(chatId: number, type: 'message' | 'photo', content: string, options?: any, priority: 'high' | 'normal' | 'low' = 'normal') {
    const message: QueuedMessage = {
      id: `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      chatId,
      type,
      content,
      options,
      priority,
      retries: 0,
      timestamp: Date.now()
    };

    this.messageQueue.push(message);
    
    // Start queue processing immediately for faster delivery
    if (!this.isProcessingQueue) {
      this.startMessageQueueProcessor();
    }
  }

  // Public methods để các service khác có thể sử dụng (now uses queue)
  async sendMessage(chatId: string, text: string, options?: any): Promise<void> {
    if (!this.bot) {
      throw new Error("Bot not initialized");
    }
    if (!chatId || chatId === 'undefined') {
      console.error("Invalid chatId provided to sendMessage:", chatId);
      return;
    }
    const parsedChatId = parseInt(chatId);
    if (isNaN(parsedChatId)) {
      console.error("Invalid chatId - not a number:", chatId);
      return;
    }
    this.queueMessage(parsedChatId, 'message', text, options, 'normal');
  }

  async sendPhoto(chatId: string | number, photoUrl: string, caption?: string, options?: any): Promise<void> {
    if (!this.bot) return;
    const parsedChatId = typeof chatId === 'string' ? parseInt(chatId) : chatId;
    if (isNaN(parsedChatId)) return;
    try {
      await this.bot.sendPhoto(parsedChatId, photoUrl, {
        caption,
        parse_mode: "HTML",
        ...options,
      });
    } catch (err) {
      console.error("sendPhoto error:", err);
    }
  }

  // Called by bankMonitorService when auto deposit is confirmed
  async notifyDepositSuccess(userId: string, amount: number, newBalance: string): Promise<void> {
    // Sync balance to bot2 cache immediately (real-time)
    void this.syncBalanceWithBot2(userId, newBalance);

    if (!this.bot) return;
    const chatId = parseInt(userId);
    if (isNaN(chatId)) return;
    try {
      await this.bot.sendMessage(
        chatId,
        `✅ <b>Nạp tiền thành công!</b>\n\n` +
        `💰 Số tiền: <b>+${amount.toLocaleString('vi-VN')}đ</b>\n` +
        `💎 Số dư hiện tại: <b>${parseFloat(newBalance).toLocaleString('vi-VN')}đ</b>\n\n` +
        `🎮 Chúc bạn chơi vui vẻ!`,
        { parse_mode: 'HTML' }
      );
    } catch (err) {
      logger.error({ err }, 'Failed to notify deposit success');
    }
  }


  // High priority message sending (bypasses queue for urgent messages)
  async sendMessageImmediate(chatId: number, text: string, options?: any): Promise<void> {
    if (!this.bot) {
      throw new Error("Bot not initialized");
    }
    try {
      await this.bot.sendMessage(chatId, text, options);
    } catch (error) {
      console.error("Error sending immediate message:", error);
      // Fallback to queue with high priority
      this.queueMessage(chatId, 'message', text, options, 'high');
    }
  }

  // High priority message sending (photos disabled to reduce lag)
  async sendPhotoImmediate(chatId: number, photo: string, options?: any): Promise<void> {
    if (!this.bot) {
      throw new Error("Bot not initialized");
    }
    // Photos are disabled to reduce lag - send text message instead
    if (options && options.caption) {
      try {
        await this.bot.sendMessage(chatId, options.caption, { parse_mode: options.parse_mode || 'HTML', reply_markup: options.reply_markup });
      } catch (error) {
        console.error("Error sending immediate message:", error);
        this.queueMessage(chatId, 'message', options.caption, { parse_mode: options.parse_mode || 'HTML', reply_markup: options.reply_markup }, 'high');
      }
    }
  }

  // Method for sending payment notifications (QR images disabled to reduce lag)
  async sendPaymentQRImmediate(chatId: number, photo: string, caption: string): Promise<void> {
    try {
      // QR images disabled to reduce lag - send text message instead
      await this.bot!.sendMessage(chatId, caption, {
        parse_mode: "HTML"
      });
    } catch (error) {
      console.error("Error sending payment message:", error);
      this.queueMessage(chatId, 'message', caption, {
        parse_mode: "HTML"
      }, 'high');
    }
  }


  // Referral system
  private async showReferralInfo(chatId: number, userId: string) {
    if (!this.bot) return;

    try {
      const user = await storage.getBotUser(userId);
      if (!user) return;
      
      const stats = await storage.getReferralStats(userId);
      // Use referralCode in link so processReferral can find the referrer correctly
      const referralLink = user.referralCode
        ? `https://t.me/Haru88gamebot?start=${user.referralCode}`
        : `https://t.me/Haru88gamebot?start=${userId}`;
      
      const todayCommission = 0;
      const totalCommission = stats.totalEarnings || 0;
      const referralCount = stats.referralCount || 0;
      
      const keyboard = {
        inline_keyboard: [
        ]
      };
      
      const message =
        `🔗 <b>Link mời bạn bè của bạn:</b>\n<code>${referralLink}</code>\n👆 Copy link và gửi cho bạn bè!\n\n` +
        `<blockquote>💚 <b>THÔNG TIN HOA HỒNG</b>\n` +
        `🌺 Nhận ngay <b>HOA HỒNG</b> bằng 2% số tiền cược thua từ người chơi bạn giới thiệu.\n\n` +
        `💰 <b>Tổng Hoa Hồng:</b> ${totalCommission.toLocaleString('vi-VN')}đ\n` +
        `🌱 <b>Từ Nạp Tiền (5%):</b> ${todayCommission.toLocaleString('vi-VN')}đ\n` +
        `🎮 <b>Từ Chơi Game (1%):</b> 0đ\n` +
        `👥 <b>Người Giới Thiệu:</b> ${referralCount} người</blockquote>`;

      await this.bot.sendMessage(chatId, message, {
        parse_mode: 'HTML',
        reply_markup: keyboard
      });
    } catch (error) {
      console.error("Error showing referral info:", error);
    }
  }

  // History functions
  private async showDepositHistory(chatId: number, userId: string, messageId?: number) {
    if (!this.bot) return;

    try {
      const transactions = await storage.getTransactionsByUser(userId, 10);
      const deposits = transactions.filter(t => t.type === "deposit");
      
      if (deposits.length === 0) {
        await this.bot.sendMessage(chatId, "📋 Chưa có giao dịch nạp tiền nào!");
        return;
      }
      
      let message = "📋 **LỊCH SỚ NẠP TIỀN**\n\n";
      
      deposits.slice(0, 10).forEach((transaction, index) => {
        const status = transaction.status === "completed" ? "✅" : "⏳";
        const date = transaction.createdAt ? new Date(transaction.createdAt).toLocaleDateString("vi-VN") : "N/A";
        message += `${index + 1}. ${status} ${parseFloat(transaction.amount).toLocaleString()}đ - ${date}\n`;
      });
      
      await this.bot.sendMessage(chatId, message, {
        parse_mode: "Markdown"
      });
    } catch (error) {
      console.error("Error showing deposit history:", error);
    }
  }

  private async showWithdrawHistory(chatId: number, userId: string, messageId?: number) {
    if (!this.bot) return;

    try {
      const transactions = await storage.getTransactionsByUser(userId, 10);
      const withdrawals = transactions.filter(t => t.type === "withdrawal");
      
      if (withdrawals.length === 0) {
        await this.bot.sendMessage(chatId, "📋 Chưa có giao dịch rút tiền nào!");
        return;
      }
      
      let message = "📋 **LỊCH SỚ RÚT TIỀN**\n\n";
      
      withdrawals.slice(0, 10).forEach((transaction, index) => {
        const status = transaction.status === "completed" ? "✅" : 
                      transaction.status === "pending" ? "⏳" : "❌";
        const date = transaction.createdAt ? new Date(transaction.createdAt).toLocaleDateString("vi-VN") : "N/A";
        message += `${index + 1}. ${status} ${parseFloat(transaction.amount).toLocaleString()}đ - ${date}\n`;
      });
      
      await this.bot.sendMessage(chatId, message, {
        parse_mode: "Markdown"
      });
    } catch (error) {
      console.error("Error showing withdraw history:", error);
    }
  }

  // Bank withdrawal handler (auto via PayOS)
  private async handleBankWithdrawal(chatId: number, userId: string, params: string) {
    if (!this.bot) return;

    try {
      // Parse parameters: amount bankCode accountNumber accountHolderName
      const parts = params.trim().split(/\s+/);
      if (parts.length < 4) {
        await this.bot.sendMessage(chatId,
          "❌ <b>Thông tin không đủ!</b>\n\n" +
          "<b>Sử dụng:</b> /rutbank [số tiền] [mã ngân hàng] [số tài khoản] [tên chủ tài khoản]\n\n" +
          "<b>Ví dụ:</b> /rutbank 100000 VCB 01234567890 NGUYEN VAN A",
          { parse_mode: "HTML" }
        );
        return;
      }

      const amount = parseInt(parts[0].replace(/[^\d]/g, ""));
      const bankCode = parts[1].toUpperCase();
      const bankAccount = parts[2];
      const accountHolderName = parts.slice(3).join(" ").toUpperCase();

      // Validate amount
      {
        const minWithdraw = await getSettingNumber('min_withdraw', 100000);
        const maxWithdraw = await getSettingNumber('max_withdraw', 50000000);
        if (isNaN(amount) || amount < minWithdraw) {
          await this.bot.sendMessage(chatId, `❌ Số tiền rút tối thiểu là ${minWithdraw.toLocaleString('vi-VN')}đ!`);
          return;
        }
        if (amount > maxWithdraw) {
          await this.bot.sendMessage(chatId, `❌ Số tiền rút tối đa là ${maxWithdraw.toLocaleString('vi-VN')}đ!`);
          return;
        }
      }

      // Validate bank code
      const validBankCodes = ["ACB", "BIDV", "MBB", "MSB", "TCB", "TPB", "VCB", "VIB", "VPB", "VTB", "SHIB", "ABB", "AGR", "VCCB", "BVB", "DAB", "EIB", "GPB", "HDB", "KLB", "NAB", "NCB", "OCB", "OJB", "PGB", "PVB", "STB", "SGB", "SCB", "SAB", "SHB"];
      if (!validBankCodes.includes(bankCode)) {
        await this.bot.sendMessage(chatId,
          "❌ <b>Mã ngân hàng không hợp lệ!</b>\n\n" +
          "Vui lòng sử dụng mã ngân hàng được hỗ trợ:\n" +
          "📌 ACB, BIDV, MBB, MSB, TCB, TPB\n" +
          "📌 VCB, VIB, VPB, VTB, SHIB, ABB\n" +
          "📌 AGR, VCCB, BVB, DAB, EIB, GPB\n" +
          "📌 HDB, KLB, NAB, NCB, OCB, OJB\n" +
          "📌 PGB, PVB, STB, SGB, SCB, SAB, SHB",
          { parse_mode: "HTML" }
        );
        return;
      }

      // Validate account number
      if (bankAccount.length < 6 || bankAccount.length > 20 || !/^\d+$/.test(bankAccount)) {
        await this.bot.sendMessage(chatId, "❌ Số tài khoản không hợp lệ! (6-20 chữ số)");
        return;
      }

      // Validate account holder name
      if (accountHolderName.length < 2 || accountHolderName.length > 100) {
        await this.bot.sendMessage(chatId, "❌ Tên chủ tài khoản không hợp lệ! (2-100 ký tự)");
        return;
      }

      // Check user balance
      const user = await storage.getBotUser(userId);
      if (!user) {
        await this.bot.sendMessage(chatId, "❌ Không tìm thấy thông tin người dùng!");
        return;
      }

      const currentBalance = parseFloat(user.balance || "0");
      if (currentBalance < amount) {
        await this.bot.sendMessage(chatId,
          `❌ <b>Số dư không đủ!</b>\n\n` +
          `• Số dư hiện tại: ${currentBalance.toLocaleString()}đ\n` +
          `• Số tiền muốn rút: ${amount.toLocaleString()}đ\n` +
          `• Thiếu: ${(amount - currentBalance).toLocaleString()}đ`,
          { parse_mode: "HTML" }
        );
        return;
      }

      // Get bank name
      const bankNames: Record<string, string> = {
        "ACB": "ACB - NH TMCP A CHÂU",
        "BIDV": "BIDV - NH ĐẦU TƯ VÀ PHÁT TRIỂN VN",
        "MBB": "MB - NH TMCP QUÂN ĐỘI",
        "MSB": "MSB - NH TMCP HÀNG HẢI",
        "TCB": "TECHCOMBANK - NH TMCP KỸ THƯƠNG VN",
        "TPB": "TPBANK - NH TMCP TIÊN PHONG",
        "VCB": "VIETCOMBANK - NH TMCP NGOẠI THƯƠNG VN",
        "VIB": "VIB - NH TMCP QUỐC TẾ VN",
        "VPB": "VPBANK - NH TMCP VIỆT NAM THỊNH VƯỢNG",
        "VTB": "VIETINBANK - NH TMCP CÔNG THƯƠNG VN",
        "SHIB": "SHINHANBANK - NH TNHH SHINHAN VN",
        "ABB": "ABBANK - NH TMCP AN BÌNH",
        "AGR": "AGRIBANK - NH NN & PTNT VN",
        "VCCB": "BANVIET - NH TMCP BẢN VIỆT",
        "BVB": "BAOVIETBANK - NH TMCP BẢO VIỆT",
        "DAB": "DONGABANK - NH TMCP ĐÔNG Á",
        "EIB": "EXIMBANK - NH TMCP XUẤT NHẬP KHẨU VN",
        "GPB": "GPBANK - NH TMCP DẦU KHÍ TOÀN CẦU",
        "HDB": "HDBANK - NH TMCP PHÁT TRIỂN TP.HCM",
        "KLB": "KIENLONGBANK - NH TMCP KIÊN LONG",
        "NAB": "NAMABANK - NH TMCP NAM Á",
        "NCB": "NCB - NH TMCP QUỐC DÂN",
        "OCB": "OCB - NH TMCP PHƯƠNG ĐÔNG",
        "OJB": "OCEANBANK - NH TMCP ĐẠI DƯƠNG",
        "PGB": "PGBANK - NH TMCP XĂNG DẦU PETROLIMEX",
        "PVB": "PVCOMBANK - NH TMCP ĐẠI CHÚNG VN",
        "STB": "SACOMBANK - NH TMCP SÀI GÒN THƯƠNG TÍN",
        "SGB": "SAIGONBANK - NH TMCP SÀI GÒN CÔNG THƯƠNG",
        "SCB": "SCB - NH TMCP SÀI GÒN",
        "SAB": "SEABANK - NH TMCP ĐÔNG NAM Á",
        "SHB": "SHB - NH TMCP SÀI GÒN HÀ NỘI",
      };
      const bankName = bankNames[bankCode] || bankCode;

      // Deduct balance first, refund if PayOS fails
      const newBalance = (currentBalance - amount).toString();
      await storage.updateBotUser(userId, { balance: newBalance });

      // Create withdrawal record
      const withdrawRequest = await storage.createWithdrawRequest({
        userId,
        amount: amount.toString(),
        method: "bank_payos",
        bankCode,
        bankAccount,
        accountHolderName,
      });

      // Notify user we are processing
      const processingMsg = await this.bot.sendMessage(chatId,
        `⏳ <b>ĐANG XỬ LÝ RÚT TIỀN QUA PAYOS...</b>\n\n` +
        `💰 Số tiền: ${amount.toLocaleString()}đ\n` +
        `🏦 Ngân hàng: ${bankName}\n` +
        `💳 Tài khoản: ${bankAccount}\n` +
        `👤 Chủ TK: ${accountHolderName}\n\n` +
        `⏱️ Vui lòng chờ trong giây lát...`,
        { parse_mode: "HTML" }
      );

      // Call PayOS auto-transfer
      let payosOk = false;
      let payosError = "";
      let payosPayoutId: string | undefined;

      if (await isPayOSConfigured()) {
        const result = await createBankPayout({
          referenceId: withdrawRequest.id,
          amount,
          bankCode,
          accountNumber: bankAccount,
          description: `Rut ${withdrawRequest.id}`.slice(0, 25),
        });
        payosOk = result.success;
        payosPayoutId = result.payoutId;
        payosError = result.errorMessage || "";
      } else {
        payosError = "PayOS chưa được cấu hình";
      }

      if (payosOk) {
        // Success
        await storage.updateWithdrawalStatus(withdrawRequest.id, "completed", payosPayoutId);
        await this.bot.editMessageText(
          `✅ <b>RÚT TIỀN THÀNH CÔNG!</b>\n\n` +
          `🆔 Mã GD: <code>${withdrawRequest.id}</code>\n` +
          `💰 Số tiền: <b>${amount.toLocaleString()}đ</b>\n` +
          `🏦 Ngân hàng: ${bankName}\n` +
          `💳 Tài khoản: ${bankAccount}\n` +
          `👤 Chủ TK: ${accountHolderName}\n` +
          `💳 Số dư còn lại: ${parseFloat(newBalance).toLocaleString()}đ\n` +
          `⏰ Thời gian: ${new Date().toLocaleString("vi-VN")}\n\n` +
          `✅ Tiền đã được chuyển vào tài khoản ngân hàng của bạn!`,
          { chat_id: chatId, message_id: processingMsg.message_id, parse_mode: "HTML" }
        );
        // Group notification for bank withdrawal if enabled
        try {
          const notifyEnabled = await storage.getSetting('bank_withdraw_notify');
          const MAIN_GROUP = -1003132451812;
          const maskedId = `****${userId.slice(-5)}`;
          if (notifyEnabled === '1') {
            await this.bot.sendMessage(MAIN_GROUP,
              `🎉🧧 [BOT] Người chơi ID: ${maskedId}\n- Rút Bank thành công: ${amount.toLocaleString('vi-VN')}đ`
            );
          }
        } catch { /* ignore */ }
      } else {
        // Failed — refund balance
        await storage.updateBotUser(userId, { balance: currentBalance.toString() });
        await storage.updateWithdrawalStatus(withdrawRequest.id, "failed");
        await this.bot.editMessageText(
          `❌ <b>RÚT TIỀN THẤT BẠI!</b>\n\n` +
          `🆔 Mã GD: <code>${withdrawRequest.id}</code>\n` +
          `💰 Số tiền: ${amount.toLocaleString()}đ\n` +
          `❗ Lý do: ${payosError || "Lỗi không xác định"}\n\n` +
          `🔄 Số dư đã được hoàn lại: ${currentBalance.toLocaleString()}đ\n\n` +
          `Vui lòng thử lại hoặc liên hệ admin!`,
          { chat_id: chatId, message_id: processingMsg.message_id, parse_mode: "HTML" }
        );
      }

    } catch (error) {
      console.error("Error handling bank withdrawal:", error);
      await this.bot.sendMessage(chatId, "❌ Có lỗi xảy ra khi rút tiền. Vui lòng thử lại sau!");
    }
  }

  private async processTransferMoney(chatId: number, senderId: string, params: string) {
    if (!this.bot) return;

    try {
      // Parse parameters: receiverId amount
      const parts = params.trim().split(/\s+/);
      if (parts.length < 2) {
        await this.bot.sendMessage(chatId, 
          "❌ **Thông tin không đủ!**\n\n" +
          "**Sử dụng:** /chuyen [ID người nhận] [số tiền]\n\n" +
          "**Ví dụ:** /chuyen 123456789 50000",
          { parse_mode: "Markdown" }
        );
        return;
      }

      const receiverId = parts[0];
      const amount = parseInt(parts[1].replace(/[^\d]/g, ""));

      // Validate amount
      {
        const minTransfer = await getSettingNumber('min_transfer', 10000);
        const maxTransfer = await getSettingNumber('max_withdraw', 50000000);
        if (isNaN(amount) || amount < minTransfer) {
          await this.bot.sendMessage(chatId, `❌ Số tiền chuyển tối thiểu là ${minTransfer.toLocaleString('vi-VN')}đ!`);
          return;
        }
        if (amount > maxTransfer) {
          await this.bot.sendMessage(chatId, `❌ Số tiền chuyển tối đa là ${maxTransfer.toLocaleString('vi-VN')}đ!`);
          return;
        }
      }

      // Check if sender is trying to transfer to themselves
      if (senderId === receiverId) {
        await this.bot.sendMessage(chatId, "❌ Không thể chuyển tiền cho chính mình!");
        return;
      }

      // Check sender balance
      const sender = await storage.getBotUser(senderId);
      if (!sender) {
        await this.bot.sendMessage(chatId, "❌ Không tìm thấy thông tin người gửi!");
        return;
      }

      const senderBalance = parseFloat(sender.balance || "0");
      if (senderBalance < amount) {
        await this.bot.sendMessage(chatId, 
          `❌ **Số dư không đủ!**\n\n` +
          `💰 Số dư hiện tại: ${senderBalance.toLocaleString()}đ\n` +
          `💸 Số tiền muốn chuyển: ${amount.toLocaleString()}đ\n` +
          `📊 Thiếu: ${(amount - senderBalance).toLocaleString()}đ`,
          { parse_mode: "Markdown" }
        );
        return;
      }

      // Check if receiver exists
      const receiver = await storage.getBotUser(receiverId);
      if (!receiver) {
        await this.bot.sendMessage(chatId, 
          `❌ **Người nhận không tồn tại!**\n\n` +
          `🔍 ID: ${receiverId}\n\n` +
          `⚠️ Vui lòng kiểm tra lại ID người nhận.`,
          { parse_mode: "Markdown" }
        );
        return;
      }

      // Deduct from sender
      const newSenderBalance = (senderBalance - amount).toFixed(2);
      await storage.updateBotUser(senderId, { balance: newSenderBalance });

      // Add to receiver
      const receiverBalance = parseFloat(receiver.balance || "0");
      const newReceiverBalance = (receiverBalance + amount).toFixed(2);
      await storage.updateBotUser(receiverId, { balance: newReceiverBalance });

      // Create transaction records
      await storage.createTransaction({
        userId: senderId,
        type: "transfer_out",
        amount: amount.toString(),
        status: "completed",
        method: "transfer",
        metadata: { 
          receiverId,
          receiverName: receiver.firstName || receiver.username || `User ${receiverId}`
        }
      });

      await storage.createTransaction({
        userId: receiverId,
        type: "transfer_in",
        amount: amount.toString(),
        status: "completed",
        method: "transfer",
        metadata: { 
          senderId,
          senderName: sender.firstName || sender.username || `User ${senderId}`
        }
      });

      // Notify sender
      await this.bot.sendMessage(chatId, 
        `✅ **CHUYỂN TIỀN THÀNH CÔNG!**\n\n` +
        `💸 Số tiền: ${amount.toLocaleString()}đ\n` +
        `👤 Người nhận: ${receiver.firstName || receiver.username || `User ${receiverId}`}\n` +
        `🆔 ID người nhận: ${receiverId}\n` +
        `💰 Số dư còn lại: ${parseFloat(newSenderBalance).toLocaleString()}đ\n` +
        `⏰ Thời gian: ${new Date().toLocaleString("vi-VN")}`,
        { parse_mode: "Markdown" }
      );

      // Notify receiver
      try {
        await this.bot.sendMessage(
          parseInt(receiverId),
          `💰 **BẠN VỪA NHẬN ĐƯỢC TIỀN!**\n\n` +
          `💸 Số tiền: ${amount.toLocaleString()}đ\n` +
          `👤 Từ: ${sender.firstName || sender.username || `User ${senderId}`}\n` +
          `🆔 ID người gửi: ${senderId}\n` +
          `💎 Số dư mới: ${parseFloat(newReceiverBalance).toLocaleString()}đ\n` +
          `⏰ Thời gian: ${new Date().toLocaleString("vi-VN")}`,
          { parse_mode: "Markdown" }
        );
      } catch (error) {
        console.log(`Could not notify receiver ${receiverId}:`, error);
        // Don't throw error if we can't notify receiver - transfer already completed
      }

    } catch (error) {
      console.error("Error processing transfer:", error);
      await this.bot.sendMessage(chatId, "❌ Có lỗi xảy ra khi chuyển tiền. Vui lòng thử lại sau!");
    }
  }

  private async showGameHistory(chatId: number, userId: string, messageId?: number) {
    if (!this.bot) return;

    try {
      const gameSessions = await storage.getGameSessionsByUser(userId);
      
      if (gameSessions.length === 0) {
        await this.bot.sendMessage(chatId, "📋 Chưa có lịch sử cược nào!");
        return;
      }
      
      let message = "📋 LỊCH SỬ CƯỢC\n\n";
      
      gameSessions.forEach((session, index) => {
        const betAmount = parseFloat(session.betAmount ?? "0");
        const winAmount = parseFloat(session.winAmount ?? "0");
        
        let emoji = "😢";
        let status = "Thua";
        if (winAmount > betAmount) {
          emoji = "🎉";
          status = "Thắng";
        } else if (winAmount === betAmount) {
          emoji = "🤝";
          status = "Hòa";
        }
        
        const date = session.createdAt ? new Date(session.createdAt).toLocaleDateString("vi-VN") : "N/A";
        const gameType = session.gameType.toUpperCase();
        
        message += `${index + 1}. ${emoji} ${gameType} - ${betAmount.toLocaleString()}đ - ${status} - ${date}\n`;
      });
      
      await this.bot.sendMessage(chatId, message);
    } catch (error) {
      console.error("Error showing game history:", error);
    }
  }

  // Play again functionality
  private async handlePlayAgain(chatId: number, userId: string) {
    if (!this.bot) return;

    try {
      // Check if there's an existing session first (user just finished a game)
      const existingSession = this.gameSessions.get(userId);
      if (existingSession && existingSession.gameType) {
        // Reuse the same game type from current session
        existingSession.status = "betting";
        existingSession.betType = undefined;
        existingSession.timestamp = Date.now();
        this.gameSessions.set(userId, existingSession);
        await this.sendGameBettingOptions(chatId, existingSession.gameType);
        return;
      }

      // If no current session, get last played game from database
      const gameSessions = await storage.getGameSessionsByUser(userId, 1);
      
      if (gameSessions.length === 0) {
        await this.showGamesMenu(chatId);
        return;
      }
      
      const lastGame = gameSessions[0].gameType;
      this.createGameSession(userId, lastGame);
      await this.sendGameBettingOptions(chatId, lastGame);
    } catch (error) {
      console.error("Error handling play again:", error);
      await this.showGamesMenu(chatId);
    }
  }

  // Withdrawal handling
  private async handleWithdraw(chatId: number, userId: string) {
    if (!this.bot) return;

    try {
      // Removed deposit requirement check - users can withdraw without depositing first
      
      const keyboard = {
        inline_keyboard: [
          [
            { text: "🏦 Ngân hàng", callback_data: "rut_bank" },
            { text: "🎫 Thẻ cào", callback_data: "rut_card" }
          ]
        ]
      };

      await this.bot.sendMessage(
        chatId,
        "💸 **CHỌN PHƯƠNG THỨC RÚT TIỀN**\n\n" +
        "Chọn phương thức bạn muốn rút tiền:",
        {
          reply_markup: keyboard,
          parse_mode: "Markdown"
        }
      );
    } catch (error) {
      console.error("Error handling withdraw:", error);
    }
  }

  private async handleTransferMoney(chatId: number, userId: string, messageId?: number) {
    if (!this.bot) return;

    await this.bot.sendMessage(
      chatId,
      "💸 **CHUYỂN TIỀN** 💸\n\n" +
      "🎯 Để chuyển tiền cho người chơi khác, vui lòng nhập theo cú pháp:\n\n" +
      "📝 /chuyen [ID người nhận] [Số tiền]\n\n" +
      "💡 **Ví dụ:** /chuyen 123456789 50000\n\n" +
      "⚠️ **Lưu ý:**\n" +
      "• Kiểm tra kỹ ID người nhận\n" +
      "• Số tiền chuyển tối thiểu: 10,000đ\n" +
      "• Không hoàn lại nếu chuyển sai ID",
      { parse_mode: "Markdown" }
    );
  }

  // Leaderboard with time periods
  private async showLeaderboard(chatId: number, messageId?: number) {
    if (!this.bot) return;

    const keyboard = {
      inline_keyboard: [
        [
          { text: "📅 Top Ngày", callback_data: "leaderboard_daily" },
          { text: "📅 Top Tuần", callback_data: "leaderboard_weekly" }
        ]
      ]
    };

    const message = `🏆 **BẢNG XẾP HẠNG**\n\n` +
                   `Chọn khoảng thời gian để xem:\n\n` +
                   `▸ Top người cược nhiều nhất`;

    await this.bot.sendMessage(chatId, message, {
      reply_markup: keyboard,
      parse_mode: "Markdown"
    });
  }

  private async showLeaderboardDaily(chatId: number, userId?: string) {
    if (!this.bot) return;

    try {
      const today = this.nowVN();
      
      const topBettors = await storage.getTopBettingUsers('day', 10);
      
      if (topBettors.length === 0) {
        await this.bot.sendMessage(chatId,
          `🔥 Top cược ngày hôm nay ${today.getDate()}/${today.getMonth() + 1}! 🔥\n\n` +
          `⚠️ Chưa có dữ liệu cược hôm nay!\n\n` +
          `🎯 PHẦN THƯỞNG NGÀY:\n` +
          `🥇 Top 1: 30,000đ\n` +
          `🥈 Top 2: 15,000đ\n` +
          `🥉 Top 3: 10,000đ\n` +
          `🗓️ Phát lúc 00:00 HẰNG NGÀY vào 🧧 LÌ XÌ!`,
          { parse_mode: "HTML" }
        );
        return;
      }

      let message = `🔥 Top cược ngày hôm nay ${today.getDate()}/${today.getMonth() + 1}! 🔥\n\n`;
      
      for (let i = 0; i < topBettors.length; i++) {
        const bettor = topBettors[i];
        const maskedId = `****${bettor.userId.slice(-3)}`;
        const amountNum = Number(bettor.totalBetAmount);
        const amountK = Math.floor(amountNum / 1000);
        
        message += ` Top ${i + 1}: ${maskedId}| ${amountK} k\n`;
      }

      message += `\n`;
      
      if (userId) {
        const userRank = topBettors.findIndex(b => b.userId === userId);
        if (userRank >= 0) {
          message += `Thứ hạng của bạn: Top ${userRank + 1}`;
        } else {
          message += `Bạn chưa có trong bảng xếp hạng`;
        }
      }

      await this.bot.sendMessage(chatId, message, { parse_mode: "HTML" });
    } catch (error) {
      console.error("Error showing daily leaderboard:", error);
      await this.bot.sendMessage(chatId, "❌ Có lỗi xảy ra khi tải bảng xếp hạng!");
    }
  }

  private async showLeaderboardWeekly(chatId: number, userId?: string) {
    if (!this.bot) return;

    try {
      const today = this.nowVN();
      
      const topBettors = await storage.getTopBettingUsers('week', 10);
      
      if (topBettors.length === 0) {
        await this.bot.sendMessage(chatId,
          `🔥 Top cược tuần này! 🔥\n\n` +
          `⚠️ Chưa có dữ liệu cược tuần này!\n\n` +
          `🏆 PHẦN THƯỞNG TUẦN:\n` +
          `🥇 Top 1: 50,000đ\n` +
          `🥈 Top 2: 25,000đ\n` +
          `🥉 Top 3: 15,000đ\n` +
          `🗓️ Phát lúc 00:00 thứ 2 HẰNG TUẦN vào 🧧 LÌ XÌ!`,
          { parse_mode: "HTML" }
        );
        return;
      }

      let message = `🔥 Top cược tuần này! 🔥\n\n`;
      
      for (let i = 0; i < topBettors.length; i++) {
        const bettor = topBettors[i];
        const maskedId = `****${bettor.userId.slice(-3)}`;
        const amountNum = Number(bettor.totalBetAmount);
        const amountK = Math.floor(amountNum / 1000);
        
        message += ` Top ${i + 1}: ${maskedId}| ${amountK} k\n`;
      }

      message += `\n`;
      
      if (userId) {
        const userRank = topBettors.findIndex(b => b.userId === userId);
        if (userRank >= 0) {
          message += `Thứ hạng của bạn: Top ${userRank + 1}`;
        } else {
          message += `Bạn chưa có trong bảng xếp hạng`;
        }
      }

      await this.bot.sendMessage(chatId, message, { parse_mode: "HTML" });
    } catch (error) {
      console.error("Error showing weekly leaderboard:", error);
      await this.bot.sendMessage(chatId, "❌ Có lỗi xảy ra khi tải bảng xếp hạng!");
    }
  }

  /**
   * Helper method to delete previous message and send new one
   * This prevents message clutter when users navigate through menus
   */
  private async sendMessageWithDeletion(chatId: number, userId: string, message: string, options?: any): Promise<void> {
    if (!this.bot) return;
    
    try {
      // Delete previous message if exists
      const lastMessageId = this.lastMessageIds.get(userId);
      if (lastMessageId) {
        try {
          await this.bot.deleteMessage(chatId, lastMessageId);
        } catch (error) {
          // Ignore errors (message might be too old or already deleted)
          console.log(`Could not delete message ${lastMessageId} for user ${userId}`);
        }
      }
      
      // Send new message and store its ID
      const sentMessage = await this.bot.sendMessage(chatId, message, options);
      this.lastMessageIds.set(userId, sentMessage.message_id);
    } catch (error) {
      console.error("Error in sendMessageWithDeletion:", error);
      // Fallback to regular send if deletion fails
      await this.bot.sendMessage(chatId, message, options);
    }
  }

  /**
   * Display daily betting rankings - shows top 10 users by bet amount today
   */
  private async showDailyBettingRankings(chatId: number, messageId?: number) {
    if (!this.bot) return;

    try {
      const topBettors = await storage.getTopBettingUsers('day', 10);
      
      const today = this.nowVN();
      const dateStr = today.toLocaleDateString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
      
      if (topBettors.length === 0) {
        const keyboard = {
          inline_keyboard: [
          ]
        };

        await this.bot.sendMessage(chatId,
          `🏆 TOP CƯỢC NGÀY 🏆\n\n` +
          `📅 Ngày: ${dateStr}\n\n` +
          `⚠️ Chưa có dữ liệu cược hôm nay!\n\n` +
          `💪 Hãy bắt đầu cược để leo lên bảng xếp hạng!\n` +
          `🎁 Top 10 sẽ nhận thưởng hấp dẫn!`,
          {
            reply_markup: keyboard
          }
        );
        return;
      }

      let message = `🏆 TOP CƯỢC NGÀY 🏆\n\n`;
      message += `📅 Ngày: ${dateStr}\n\n`;
      
      topBettors.forEach((bettor, index) => {
        const rank = index + 1;
        const name = bettor.user?.firstName || bettor.user?.username || `Player${bettor.userId.slice(-4)}`;
        const amount = Number(bettor.totalBetAmount).toLocaleString('vi-VN');
        const vipInfo = this.getVipInfo(Number(bettor.user?.vipLevel ?? 0));
        
        if (rank <= 3) {
          const medals = ["🥇", "🥈", "🥉"];
          message += `${medals[rank - 1]} ${vipInfo.emoji} ${name}\n`;
        } else {
          message += `${rank}. ${vipInfo.emoji} ${name}\n`;
        }
        message += `   💰 ${amount}đ (${bettor.gameCount} games)\n\n`;
      });

      message += `\n💎 Cược càng nhiều - Cơ hội nhận thưởng càng lớn!`;

      const keyboard = {
        inline_keyboard: [
          [
            { text: "📊 Top Tuần", callback_data: "top_cuoc_tuan" }
          ]
        ]
      };
      
      await this.bot.sendMessage(chatId, message, {
        reply_markup: keyboard
      });
    } catch (error) {
      console.error("Error showing daily betting rankings:", error);
      await this.bot.sendMessage(chatId, "❌ Có lỗi xảy ra khi tải bảng xếp hạng!");
    }
  }

  /**
   * Display weekly betting rankings - shows top 10 users by bet amount this week
   */
  private async showWeeklyBettingRankings(chatId: number, messageId?: number) {
    if (!this.bot) return;

    try {
      const topBettors = await storage.getTopBettingUsers('week', 10);
      
      const today = this.nowVN();
      const weekStr = `Tuần ${this.getWeekNumber(today)}`;
      
      if (topBettors.length === 0) {
        const keyboard = {
          inline_keyboard: [
          ]
        };

        await this.bot.sendMessage(chatId,
          `🏆 TOP CƯỢC TUẦN 🏆\n\n` +
          `📅 ${weekStr}\n\n` +
          `⚠️ Chưa có dữ liệu cược tuần này!\n\n` +
          `💪 Hãy bắt đầu cược để leo lên bảng xếp hạng!\n` +
          `🎁 Top 10 sẽ nhận thưởng hấp dẫn!`,
          {
            reply_markup: keyboard
          }
        );
        return;
      }

      let message = `🏆 TOP CƯỢC TUẦN 🏆\n\n`;
      message += `📅 ${weekStr}\n\n`;
      
      topBettors.forEach((bettor, index) => {
        const rank = index + 1;
        const name = bettor.user?.firstName || bettor.user?.username || `Player${bettor.userId.slice(-4)}`;
        const amount = Number(bettor.totalBetAmount).toLocaleString('vi-VN');
        const vipInfo = this.getVipInfo(Number(bettor.user?.vipLevel ?? 0));
        
        if (rank <= 3) {
          const medals = ["🥇", "🥈", "🥉"];
          message += `${medals[rank - 1]} ${vipInfo.emoji} ${name}\n`;
        } else {
          message += `${rank}. ${vipInfo.emoji} ${name}\n`;
        }
        message += `   💰 ${amount}đ (${bettor.gameCount} games)\n\n`;
      });

      message += `\n💎 Phần thưởng sẽ được trao vào mỗi sáng thứ 2!`;

      const keyboard = {
        inline_keyboard: [
          [
            { text: "📊 Top Ngày", callback_data: "top_cuoc_ngay" }
          ]
        ]
      };
      
      await this.bot.sendMessage(chatId, message, {
        reply_markup: keyboard
      });
    } catch (error) {
      console.error("Error showing weekly betting rankings:", error);
      await this.bot.sendMessage(chatId, "❌ Có lỗi xảy ra khi tải bảng xếp hạng!");
    }
  }

  /**
   * Get week number for a date
   */
  private getWeekNumber(date: Date): number {
    const firstDayOfYear = new Date(date.getFullYear(), 0, 1);
    const pastDaysOfYear = (date.getTime() - firstDayOfYear.getTime()) / 86400000;
    return Math.ceil((pastDaysOfYear + firstDayOfYear.getDay() + 1) / 7);
  }

  private async showWeeklyReward(chatId: number, userId: string) {
    if (!this.bot) return;

    try {
      const user = await storage.getBotUser(userId);
      if (!user) {
        await this.bot.sendMessage(chatId, "❌ Không tìm thấy thông tin tài khoản!");
        return;
      }

      const currentWeek = this.getWeekYear();
      
      const weeklyReward = await storage.getWeeklyReward(userId, currentWeek);
      
      if (!weeklyReward) {
        await this.bot.sendMessage(chatId,
          "🏆 PHẦN THƯỞNG TUẦN\n\n" +
          "⚠️ Bạn chưa có phần thưởng tuần này!\n\n" +
          "💪 Hãy cố gắng cược nhiều hơn để lọt top và nhận thưởng mỗi sáng thứ 2!"
        );
        return;
      }

      const rankNames = {
        1: "Top 1",
        2: "Top 2",
        3: "Top 3"
      };

      const keyboard = {
        inline_keyboard: [
          [
            { text: "💰 Nhận Tiền", callback_data: "claim_weekly_reward" }
          ]
        ]
      };

      const message = "🏆 PHẦN THƯỞNG TUẦN\n\n" +
                     "🎉 Trả thưởng tuần cho người chơi!\n\n" +
                     `🏆 Bạn đã đạt: ${rankNames[weeklyReward.rank as keyof typeof rankNames] || `Top ${weeklyReward.rank}`}\n` +
                     `🆔 ID tài khoản: ${user.id}\n` +
                     `👤 Tên tài khoản: ${user.firstName || user.username || 'Player'}\n` +
                     `💰 Phần thưởng: ${Number(weeklyReward.rewardAmount).toLocaleString('vi-VN')}đ\n\n` +
                     (weeklyReward.claimed 
                       ? "✅ Bạn đã nhận phần thưởng này rồi!\n\n"
                       : "🎁 Chúc mừng bạn! Hãy nhận phần thưởng của mình!\n\n") +
                     "🌟 Chúc bạn chơi game vui vẻ và may mắn!";

      await this.bot.sendMessage(chatId, message, {
        reply_markup: weeklyReward.claimed ? undefined : keyboard
      });
    } catch (error) {
      console.error("Error showing weekly reward:", error);
      await this.bot.sendMessage(chatId, "❌ Có lỗi xảy ra khi tải thông tin phần thưởng!");
    }
  }

  private async handleClaimWeeklyReward(chatId: number, userId: string) {
    if (!this.bot) return;

    try {
      const user = await storage.getBotUser(userId);
      if (!user) {
        await this.bot.sendMessage(chatId, "❌ Không tìm thấy thông tin tài khoản!");
        return;
      }

      const currentWeek = this.getWeekYear();
      
      const weeklyReward = await storage.getWeeklyReward(userId, currentWeek);
      
      if (!weeklyReward) {
        await this.bot.sendMessage(chatId, "❌ Bạn không có phần thưởng tuần nào để nhận!");
        return;
      }

      if (weeklyReward.claimed) {
        await this.bot.sendMessage(chatId, "⚠️ Bạn đã nhận phần thưởng tuần này rồi!");
        return;
      }

      const rewardAmount = Number(weeklyReward.rewardAmount);

      await storage.processBotReward(userId, rewardAmount, "weekly_reward");
      await storage.claimWeeklyReward(weeklyReward.id);

      await storage.createTransaction({
        userId,
        type: "win",
        amount: rewardAmount.toString(),
        status: "completed",
        method: "weekly_reward",
        metadata: { 
          weekYear: currentWeek,
          rank: weeklyReward.rank
        }
      });

      const newBalance = await storage.getTotalBalance(userId);

      await this.bot.sendMessage(chatId,
        "✅ Quý khách đã nhận tiền thành công!\n\n" +
        `💰 Số tiền nhận (Tuần): ${rewardAmount.toLocaleString('vi-VN')}đ\n` +
        `💎 Số dư quý khách là: ${newBalance.toLocaleString('vi-VN')}đ\n\n` +
        "🎉 Chúc mừng và chúc bạn chơi game vui vẻ!"
      );
    } catch (error) {
      console.error("Error claiming weekly reward:", error);
      await this.bot.sendMessage(chatId, "❌ Có lỗi xảy ra khi nhận thưởng!");
    }
  }

  private async handleClaimDailyReward(chatId: number, userId: string) {
    if (!this.bot) return;

    try {
      const user = await storage.getBotUser(userId);
      if (!user) {
        await this.bot.sendMessage(chatId, "❌ Không tìm thấy thông tin tài khoản!");
        return;
      }

      const todayString = this.getDateString();
      
      const dailyReward = await storage.getDailyReward(userId, todayString);
      
      if (!dailyReward) {
        await this.bot.sendMessage(chatId, "❌ Bạn không có phần thưởng ngày nào để nhận!");
        return;
      }

      if (dailyReward.claimed) {
        await this.bot.sendMessage(chatId, "⚠️ Bạn đã nhận phần thưởng ngày này rồi!");
        return;
      }

      const rewardAmount = Number(dailyReward.rewardAmount);

      await storage.processBotReward(userId, rewardAmount, "daily_reward");
      await storage.claimDailyReward(dailyReward.id);

      await storage.createTransaction({
        userId,
        type: "win",
        amount: rewardAmount.toString(),
        status: "completed",
        method: "daily_reward",
        metadata: { 
          date: todayString,
          rank: dailyReward.rank
        }
      });

      const newBalance = await storage.getTotalBalance(userId);

      await this.bot.sendMessage(chatId,
        "✅ Quý khách đã nhận tiền thành công!\n\n" +
        `💰 Số tiền nhận (Ngày): ${rewardAmount.toLocaleString('vi-VN')}đ\n` +
        `💎 Số dư quý khách là: ${newBalance.toLocaleString('vi-VN')}đ\n\n` +
        "🎉 Chúc mừng và chúc bạn chơi game vui vẻ!"
      );
    } catch (error) {
      console.error("Error claiming daily reward:", error);
      await this.bot.sendMessage(chatId, "❌ Có lỗi xảy ra khi nhận thưởng!");
    }
  }

  private async handleClaimAllGifts(chatId: number, userId: string) {
    if (!this.bot) return;

    try {
      const user = await storage.getBotUser(userId);
      if (!user) {
        await this.bot.sendMessage(chatId, "❌ Không tìm thấy thông tin tài khoản!");
        return;
      }

      const unclaimedRewards = await storage.getUnclaimedRewards(userId);

      if (unclaimedRewards.length === 0) {
        await this.bot.sendMessage(chatId, "⚠️ Bạn không có quà nào để nhận!");
        return;
      }

      let totalAmount = 0;

      for (const reward of unclaimedRewards) {
        const amount = Number(reward.rewardAmount);
        const method = reward.type === "weekly" ? "weekly_reward" : "daily_reward";
        await storage.processBotReward(userId, amount, method);
        await db
          .update(rewardsTable)
          .set({ claimed: true, claimedAt: new Date() })
          .where(eq(rewardsTable.id, reward.id));
        await storage.createTransaction({
          userId,
          type: "win",
          amount: amount.toString(),
          status: "completed",
          method,
          metadata: {
            date: reward.date ?? undefined,
            weekYear: reward.weekYear ?? undefined,
            rank: reward.rank
          }
        });
        totalAmount += amount;
      }

      await this.bot.sendMessage(chatId,
        `🎉 Bạn đã nhận quà thành công!\n` +
        `🎁 Số quà: ${unclaimedRewards.length} phần\n` +
        `-Trị giá: ${totalAmount.toLocaleString('vi-VN')}đ\n` +
        `💰 Số dư tài khoản: +${totalAmount.toLocaleString('vi-VN')}đ`
      );
    } catch (error) {
      console.error("Error claiming all gifts:", error);
      await this.bot.sendMessage(chatId, "❌ Có lỗi xảy ra khi nhận quà!");
    }
  }

  private async handleOnePieceTreasure(chatId: number, userId: string, messageId?: number) {
    if (!this.bot) return;

    try {
      const user = await storage.getBotUser(userId);
      if (!user) {
        await this.bot.sendMessage(chatId, "❌ Không tìm thấy thông tin tài khoản!");
        return;
      }

      // Get ALL unclaimed rewards regardless of date/week
      const unclaimedRewards = await storage.getUnclaimedRewards(userId);
      const totalGifts = unclaimedRewards.length;
      const totalValue = unclaimedRewards.reduce((sum, r) => sum + Number(r.rewardAmount), 0);

      // Build message
      let message = `🧧 LÌ XÌ CỦA BẠN 🧧\n\n`;
      message += `👤 Tên tài khoản: ${user.firstName || user.username || 'Player'}\n`;
      message += `🆔 ID: ${userId}\n\n`;
      message += `-Quý khách đã có: ${totalGifts} phần quà`;
      if (totalGifts > 0) {
        message += ` (trị giá: ${totalValue.toLocaleString('vi-VN')}đ)`;
        // List each reward briefly
        message += `\n\n`;
        for (const r of unclaimedRewards) {
          const typeLabel = r.type === "weekly" ? "🏆 Tuần" : "🎯 Ngày";
          const dateLabel = r.type === "weekly" ? (r.weekYear ?? "") : (r.date ?? "");
          message += `${typeLabel} ${dateLabel} — Top ${r.rank} — ${Number(r.rewardAmount).toLocaleString('vi-VN')}đ\n`;
        }
      }

      const buttons: any[] = [];
      if (totalGifts > 0) {
        buttons.push([{ text: `🎁 Nhận tất cả (${totalGifts} quà)`, callback_data: "claim_all_gifts" }]);
      }

      await this.bot.sendMessage(chatId, message, {
        reply_markup: { inline_keyboard: buttons }
      });
    } catch (error) {
      console.error("Error in handleOnePieceTreasure:", error);
      await this.bot.sendMessage(chatId, "❌ Có lỗi xảy ra khi tải LÌ XÌ!");
    }
  }

  // Events
  private async showEvents(chatId: number) {
    if (!this.bot) return;

    const keyboard = {
      inline_keyboard: [
        [
          { text: "🔥 SỰ KIỆN x125% TIỀN NẠP LẦN ĐẦU 🔥", callback_data: "event_first_deposit" }
        ],
        [
          { text: "🏆 GIỚI THIỆU BẠN BÈ NHẬN QUÀ LIỀN TAY 🏆", callback_data: "event_referral" }
        ],
        [
          { text: "🏆 TOP CƯỢC NGÀY 🏆", callback_data: "event_daily_top" }
        ],
        [
          { text: "🏆 TOP CƯỢC TUẦN 🏆", callback_data: "event_weekly_top" }
        ],
        [
          { text: "🖼 EVENT TREO ẢNH / ĐIỂM DANH", callback_data: "event_attendance" }
        ],
        [
          { text: "🎗 ĐU DÂY", callback_data: "event_du_day" },
          { text: "📣 TÍCH LUỸ NẠP", callback_data: "event_tich_luy_nap" }
        ]
      ]
    };

    const message = "🔥Rất nhiều sự kiện hấp dẫn đang chờ bạn, mời bạn hãy chọn theo Menu ở bên dưới nhé 👇👇";
    
    await this.bot.sendMessage(chatId, message, {
      reply_markup: keyboard
    });
  }

  private async showEventFirstDeposit(chatId: number) {
    if (!this.bot) return;

    const keyboard = {
      inline_keyboard: [
        [
          { text: "Nạp", callback_data: "event_first_deposit_nap" }
        ]
      ]
    };

    const message = "🎁Sự kiện X125% Nạp Lần Đầu tại Haru88🏆\n\n-Nạp 1 nhận 125% – Nhận thưởng cực khủng ngay lần đầu tiên!";
    
    await this.bot.sendMessage(chatId, message, {
      reply_markup: keyboard
    });
  }

  private async showEventReferral(chatId: number) {
    if (!this.bot) return;

    const message = "🔹 Thêm bạn – Thêm may mắn, Quà tặng liền tay! 🎁\n\n" +
                   "💰 Nhận ngay 2% hoa hồng từ tổng số tiền cược của họ!\n" +
                   "🔥 Càng giới thiệu nhiều, càng nhận thưởng lớn!\n" +
                   "⚠️ Lưu ý:\n" +
                   "🚀Chỉ áp dụng cho tài khoản chơi game trên bot.\n" +
                   "🚀 Lấy link giới thiệu trong mục giới thiệu bạn bè.";
    
    await this.bot.sendMessage(chatId, message);
  }

  private async showEventDailyTop(chatId: number) {
    if (!this.bot) return;

    const message = "🎯 PHẦN THƯỞNG NGÀY:\n" +
                   "🥇 Top 1: 30,000đ\n" +
                   "🥈 Top 2: 15,000đ\n" +
                   "🥉 Top 3: 10,000đ\n" +
                   "🗓️ Phát lúc 00:00 HẰNG NGÀY vào 🧧 LÌ XÌ!\n" +
                   "🎁 Nhận thưởng tại: /homqua";
    
    await this.bot.sendMessage(chatId, message);
  }

  private async showEventWeeklyTop(chatId: number) {
    if (!this.bot) return;

    const message = "🏆 PHẦN THƯỞNG TUẦN:\n" +
                   "🥇 Top 1: 50,000đ\n" +
                   "🥈 Top 2: 25,000đ\n" +
                   "🥉 Top 3: 15,000đ\n" +
                   "🗓️ Phát lúc 00:00 thứ 2 HẰNG TUẦN vào 🧧 LÌ XÌ!\n" +
                   "🎁 Nhận thưởng tại: /homqua";
    
    await this.bot.sendMessage(chatId, message);
  }

  private async showEventAttendance(chatId: number, userId: string) {
    if (!this.bot) return;

    const attKey = `att_${userId}`;
    const attDataStr = await storage.getSetting(attKey);
    const attData: { dates: string[] } = attDataStr ? JSON.parse(attDataStr) : { dates: [] };

    const now = this.nowVN();
    const today = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
    const checkedToday = attData.dates.includes(today);

    const sortedDates = [...attData.dates].sort();
    let consecutiveDays = 0;
    if (sortedDates.length > 0) {
      consecutiveDays = 1;
      for (let i = sortedDates.length - 1; i > 0; i--) {
        const curr = new Date(sortedDates[i]!);
        const prev = new Date(sortedDates[i-1]!);
        const diff = Math.round((curr.getTime() - prev.getTime()) / 86400000);
        if (diff === 1) { consecutiveDays++; } else { break; }
      }
      if (sortedDates[sortedDates.length - 1] !== today && !checkedToday) {
        const lastDate = new Date(sortedDates[sortedDates.length - 1]!);
        const diff = Math.round((now.getTime() - lastDate.getTime()) / 86400000);
        if (diff > 1) consecutiveDays = 0;
      }
    }

    const checkinBtn = checkedToday
      ? [{ text: "✅ Đã điểm danh hôm nay", callback_data: "attendance_checkin" }]
      : [{ text: "✅ Điểm danh ngay", callback_data: "attendance_checkin" }];

    const keyboard = {
      inline_keyboard: [
        checkinBtn,
        [{ text: "📜 Điều kiện tham gia", callback_data: "attendance_rules" }]
      ]
    };

    const progressBar = "🟩".repeat(Math.min(consecutiveDays, 7)) + "⬜".repeat(Math.max(0, 7 - consecutiveDays));

    const message =
      `🖼 <b>EVENT TREO ẢNH / ĐIỂM DANH</b>\n\n` +
      `🏆 <b>Phần thưởng:</b> 35,000đ sau 7 ngày điểm danh liên tiếp\n\n` +
      `📊 <b>Tiến độ của bạn:</b>\n` +
      `${progressBar}\n` +
      `🔥 Chuỗi hiện tại: <b>${consecutiveDays}/7 ngày</b>\n\n` +
      `📋 <b>Điều kiện:</b>\n` +
      `• Tên Telegram phải chứa <b>HARU88 FAN</b>\n` +
      `• Có nạp tiền trong 7 ngày gần nhất\n` +
      `• Điểm danh mỗi ngày 1 lần\n` +
      `• Đủ 7 ngày liên tiếp nhận 35,000đ vào 🧧 LÌ XÌ\n\n` +
      (checkedToday ? `✅ <i>Bạn đã điểm danh hôm nay rồi!</i>` : `👇 Bấm nút bên dưới để điểm danh!`);

    await this.bot.sendMessage(chatId, message, {
      parse_mode: 'HTML',
      reply_markup: keyboard
    });
  }

  private async handleAttendanceCheckIn(chatId: number, userId: string) {
    if (!this.bot) return;

    try {
      const user = await storage.getBotUser(userId);
      if (!user) {
        await this.bot.sendMessage(chatId, "❌ Không tìm thấy tài khoản!");
        return;
      }

      const fullName = `${user.firstName || ''} ${user.lastName || ''}`.trim();
      if (!fullName.toUpperCase().includes('HARU88 FAN')) {
        await this.bot.sendMessage(chatId,
          `❌ <b>Bạn chưa đặt tên đúng yêu cầu!</b>\n\n` +
          `Tên Telegram hiện tại: <b>${fullName || '(chưa cập nhật)'}</b>\n\n` +
          `Vui lòng đổi tên Telegram sao cho có chứa <b>HARU88 FAN</b>\n` +
          `Ví dụ: Nguyen Van A <b>(HARU88 FAN)</b>\n\n` +
          `Sau khi đổi tên xong, gửi lệnh /start để cập nhật, rồi bấm lại ✅ Điểm danh.`,
          { parse_mode: 'HTML' }
        );
        return;
      }

      const now = new Date();
      const today = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;

      const attKey = `att_${userId}`;
      const attDataStr = await storage.getSetting(attKey);
      const attData: { dates: string[] } = attDataStr ? JSON.parse(attDataStr) : { dates: [] };

      if (attData.dates.includes(today)) {
        await this.bot.sendMessage(chatId,
          `✅ <b>Bạn đã điểm danh hôm nay rồi!</b>\n\n` +
          `📅 Ngày điểm danh: ${today}\n` +
          `📊 Tổng số ngày đã điểm danh: ${attData.dates.length}\n\n` +
          `Hãy quay lại điểm danh vào ngày mai nhé!`,
          { parse_mode: 'HTML' }
        );
        return;
      }

      const transactions = await storage.getTransactionsByUser(userId, 200);
      const sevenDaysAgo = new Date(now);
      sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
      const hasRecentDeposit = transactions.some(t =>
        t.type === 'deposit' &&
        t.status === 'completed' &&
        new Date(t.createdAt).getTime() >= sevenDaysAgo.getTime()
      );

      if (!hasRecentDeposit) {
        await this.bot.sendMessage(chatId,
          `⚠️ <b>Bạn chưa có giao dịch nạp tiền trong 7 ngày gần nhất!</b>\n\n` +
          `Vui lòng nạp tiền trước rồi quay lại điểm danh.`,
          {
            parse_mode: 'HTML',
            reply_markup: { inline_keyboard: [[{ text: "🏦 Nạp Tiền", callback_data: "nap_tien" }]] }
          }
        );
        return;
      }

      attData.dates.push(today);
      attData.dates = attData.dates.slice(-30);
      await storage.setSetting(attKey, JSON.stringify(attData));

      const sortedDates = [...attData.dates].sort();
      let consecutiveDays = 1;
      for (let i = sortedDates.length - 1; i > 0; i--) {
        const curr = new Date(sortedDates[i]!);
        const prev = new Date(sortedDates[i-1]!);
        const diff = Math.round((curr.getTime() - prev.getTime()) / 86400000);
        if (diff === 1) { consecutiveDays++; } else { break; }
      }
      if (sortedDates[sortedDates.length - 1] !== today) consecutiveDays = 1;

      if (consecutiveDays >= 7) {
        const rewardKey = `att_rw_${userId}_${today}`;
        const alreadyRewarded = await storage.getSetting(rewardKey);

        if (!alreadyRewarded) {
          const REWARD_AMOUNT = 35000;
          await storage.processBonusCode(userId, REWARD_AMOUNT);
          await storage.createTransaction({
            userId,
            type: 'deposit',
            amount: REWARD_AMOUNT.toString(),
            status: 'completed',
            method: 'attendance_reward',
            metadata: { source: 'attendance_7_days', date: today }
          });
          await storage.setSetting(rewardKey, '1');

          attData.dates = [];
          await storage.setSetting(attKey, JSON.stringify(attData));

          await this.bot.sendMessage(chatId,
            `🎉 <b>ĐIỂM DANH THÀNH CÔNG - 7 NGÀY LIÊN TIẾP!</b>\n\n` +
            `📅 Ngày điểm danh: ${today}\n` +
            `🔥 Chuỗi hoàn thành: 7/7 ngày ✅\n\n` +
            `🎁 <b>PHẦN THƯỞNG: 35,000đ đã được gửi vào 🧧 LÌ XÌ!</b>\n\n` +
            `👉 Nhấn /homqua để nhận thưởng\n` +
            `🔄 Chuỗi điểm danh đã được reset, hãy tiếp tục!`,
            { parse_mode: 'HTML' }
          );
        } else {
          await this.bot.sendMessage(chatId,
            `✅ <b>ĐIỂM DANH THÀNH CÔNG!</b>\n\n` +
            `📅 Ngày: ${today}\n` +
            `🔥 Chuỗi ngày liên tiếp: ${consecutiveDays} ngày\n\n` +
            `ℹ️ Bạn đã nhận thưởng cho chuỗi này rồi. Chuỗi sẽ reset sau khi bỏ 1 ngày.`,
            { parse_mode: 'HTML' }
          );
        }
      } else {
        const remaining = 7 - consecutiveDays;
        const progressBar = "🟩".repeat(consecutiveDays) + "⬜".repeat(remaining);
        await this.bot.sendMessage(chatId,
          `✅ <b>ĐIỂM DANH THÀNH CÔNG!</b>\n\n` +
          `📅 Ngày: ${today}\n` +
          `${progressBar}\n` +
          `🔥 Chuỗi ngày liên tiếp: <b>${consecutiveDays}/7 ngày</b>\n` +
          `⏳ Còn <b>${remaining} ngày</b> nữa để nhận thưởng!\n\n` +
          `🎁 Phần thưởng: 35,000đ vào 🧧 LÌ XÌ sau 7 ngày\n` +
          `⚠️ Bỏ lỡ 1 ngày sẽ reset chuỗi!`,
          { parse_mode: 'HTML' }
        );
      }
    } catch (error) {
      console.error("Error in handleAttendanceCheckIn:", error);
      await this.bot.sendMessage(chatId, "❌ Có lỗi xảy ra khi điểm danh. Vui lòng thử lại!");
    }
  }

  private async showGiftGuide(chatId: number, messageId?: number) {
    if (!this.bot) return;

    const keyboard = {
      inline_keyboard: [
      ]
    };

    const message = "🎁 HƯỚNG DẪN NHẬN QUÀ\n\n" +
                   "Quý khách thoát ra và nhấn theo hướng dẫn sau:\n\n" +
                   "📍 BƯỚC 1: QUÝ KHÁCH BẤM THÔNG TIN TÀI KHOẢN\n\n" +
                   "📍 BƯỚC 2: QUÝ KHÁCH BẤM KHO BÁU ONE PIECE\n\n" +
                   "📍 BƯỚC 3: NHẤN NHẬN QUÀ!\n\n" +
                   "✨ Chúc bạn nhận quà thành công!";
    
    await this.bot.sendMessage(chatId, message, {
      reply_markup: keyboard
    });
  }

  // Commission info
  private async showCommissionInfo(chatId: number, userId: string) {
    if (!this.bot) return;

    try {
      const user = await storage.getBotUser(userId);
      if (!user) return;
      
      // Lấy tất cả người dùng được giới thiệu bởi user này
      const allUsers = await storage.getAllBotUsers();
      const referredUsers = allUsers.filter(u => u.referredBy === user.referralCode);
      
      // Tính tổng hoa hồng từ nạp tiền (5%) và chơi game (1%)
      let totalCommissionFromDeposits = 0;
      let totalCommissionFromGames = 0;
      
      for (const refUser of referredUsers) {
        // Hoa hồng từ nạp tiền (5%)
        const deposits = await storage.getTransactionsByUser(refUser.id);
        const completedDeposits = deposits.filter(t => t.type === "deposit" && t.status === "completed");
        const totalDeposits = completedDeposits.reduce((sum, t) => sum + parseFloat(t.amount), 0);
        totalCommissionFromDeposits += totalDeposits * 0.05;
        
        // Hoa hồng từ chơi game (1%)
        const gameSessions = await storage.getGameSessionsByUser(refUser.id);
        const totalGameBets = gameSessions.reduce((sum, g) => sum + parseFloat(g.betAmount ?? "0"), 0);
        totalCommissionFromGames += totalGameBets * 0.01;
      }
      
      const totalCommission = totalCommissionFromDeposits + totalCommissionFromGames;
      
      // Cập nhật commission cho user
      await storage.updateBotUser(userId, { commission: totalCommission.toString() });
      
      const commissionTransactions = await storage.getTransactionsByUser(userId);
      const commissionTxns = commissionTransactions.filter(t => t.type === "commission");
      
      let message =
        `<blockquote>💚 <b>THÔNG TIN HOA HỒNG</b>\n` +
        `💰 <b>Tổng Hoa Hồng:</b> ${totalCommission.toLocaleString()}đ\n` +
        `🌱 <b>Từ Nạp Tiền (5%):</b> ${totalCommissionFromDeposits.toLocaleString()}đ\n` +
        `🎮 <b>Từ Chơi Game (1%):</b> ${totalCommissionFromGames.toLocaleString()}đ\n` +
        `👥 <b>Người Giới Thiệu:</b> ${referredUsers.length} người</blockquote>\n\n` +
        `<blockquote>📊 <b>LỊCH SỬ HOA HỒNG</b>\n`;
      
      if (commissionTxns.length === 0) {
        message += "\n🌿 Chưa có giao dịch hoa hồng nào!";
      } else {
        commissionTxns.slice(0, 5).forEach((transaction, index) => {
          const date = transaction.createdAt ? new Date(transaction.createdAt).toLocaleDateString("vi-VN") : "N/A";
          message += `\n${index + 1}. 🌱 +${parseFloat(transaction.amount).toLocaleString()}đ — ${date}`;
        });
      }
      message += `</blockquote>`;
      
      await this.bot.sendMessage(chatId, message, {
        parse_mode: "HTML"
      });
    } catch (error) {
      console.error("Error showing commission info:", error);
    }
  }

  // Support
  private async showSupport(chatId: number) {
    if (!this.bot) return;

    const message = `🆘 <b>HỖ TRỢ KHÁCH HÀNG</b> 🆘\n\n` +
                   `ẤN CÁC NÚT BÊN DƯỚI ĐỂ NHẬN HỖ TRỢ!\n\n` +
                   `🕰 Hỗ trợ 24/7 - Tất cả các ngày trong tuần`;

    const keyboard = {
      inline_keyboard: [
        [
          { text: "📱 Telegram Hỗ Trợ", url: "https://t.me/Hotroharu88bot" }
        ],
        [
          { text: "💬 Live Chat 🔧", callback_data: "livechat_maintenance" }
        ]
      ]
    };

    await this.bot.sendMessage(chatId, message, {
      parse_mode: "HTML",
      reply_markup: keyboard
    });
  }

  // Process gift code purchase
  private async processBuyGiftCode(chatId: number, userId: string, qty: number, unitAmount: number) {
    if (!this.bot) return;

    try {
      const user = await storage.getBotUser(userId);
      if (!user) return;

      // Calculate total cost (5% service fee on total face value)
      const totalFaceValue = unitAmount * qty;
      const serviceFee = Math.round(totalFaceValue * 0.05);
      const totalCost = totalFaceValue + serviceFee;

      if (parseFloat(user.balance || "0") < totalCost) {
        await this.bot.sendMessage(
          chatId,
          `⚠️ <b>KHÔNG ĐỦ SỐ DƯ</b>\n\n` +
          `▫️ Số lượng: ${qty} code\n` +
          `▫️ Mệnh giá mỗi code: ${unitAmount.toLocaleString()}đ\n` +
          `▫️ Phí dịch vụ (5%): ${serviceFee.toLocaleString()}đ\n` +
          `▫️ Tổng cần: ${totalCost.toLocaleString()}đ\n` +
          `▫️ Số dư hiện tại: ${parseFloat(user.balance || "0").toLocaleString()}đ\n\n` +
          `Vui lòng nạp thêm tiền!`,
          { parse_mode: "HTML" }
        );
        return;
      }

      // Generate qty gift codes
      const codes: string[] = [];
      for (let i = 0; i < qty; i++) {
        const code = this.generateGiftCode();
        codes.push(code);
        await storage.createGiftCode({
          code,
          amount: unitAmount.toString(),
          maxUses: 1,
          isActive: true,
          createdBy: null
        });
      }

      // Deduct balance
      const newBalance = (parseFloat(user.balance || "0") - totalCost).toString();
      await storage.updateBotUser(userId, { balance: newBalance });

      // Create transaction record
      await storage.createTransaction({
        userId,
        type: "gift_code",
        amount: (-totalCost).toString(),
        status: "completed",
        method: "balance",
        metadata: { giftCodes: codes, qty, unitAmount, serviceFee }
      });

      // Build message showing all codes
      const codeLines = codes.map((c, i) => `  ${i + 1}. <code>${c}</code>`).join("\n");
      await this.bot.sendMessage(
        chatId,
        `🎉 <b>MUA GIFT CODE THÀNH CÔNG!</b>\n\n` +
        `📦 Số lượng: <b>${qty} code</b>\n` +
        `💰 Mệnh giá mỗi code: <b>${unitAmount.toLocaleString()}đ</b>\n` +
        `💵 Phí dịch vụ (5%): ${serviceFee.toLocaleString()}đ\n` +
        `💸 Tổng chi: ${totalCost.toLocaleString()}đ\n` +
        `💳 Số dư còn: ${parseFloat(newBalance).toLocaleString()}đ\n\n` +
        `🎁 <b>Mã gift code của bạn:</b>\n${codeLines}\n\n` +
        `📝 Người nhận nhập: <code>/code [mã code]</code>`,
        { parse_mode: "HTML" }
      );

      // Notify group
      try {
        const MAIN_GROUP = -1003132451812;
        const maskedId = `****${userId.slice(-5)}`;
        await this.bot.sendMessage(MAIN_GROUP,
          `❇️ Người chơi ${maskedId}\n` +
          `Đã mua thành công code |${qty}|${unitAmount.toLocaleString()}đ|`
        );
      } catch { /* ignore */ }

    } catch (error) {
      console.error("Error processing gift code purchase:", error);
      await this.bot.sendMessage(chatId, "❌ Có lỗi xảy ra khi mua gift code!");
    }
  }

  private generateGiftCode(): string {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let suffix = '';
    for (let i = 0; i < 6; i++) {
      suffix += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return `HARU88-${suffix}`;
  }

  // Buy gift code system — step 1: choose quantity
  private async showBuyGiftCodeOptions(chatId: number, userId: string, messageId?: number) {
    if (!this.bot) return;

    const keyboard = {
      inline_keyboard: [
        [
          { text: "1", callback_data: "buygift_qty_1" },
          { text: "2", callback_data: "buygift_qty_2" },
          { text: "3", callback_data: "buygift_qty_3" },
          { text: "4", callback_data: "buygift_qty_4" },
          { text: "5", callback_data: "buygift_qty_5" }
        ],
        [
          { text: "Khác", callback_data: "buygift_qty_custom" }
        ]
      ]
    };

    await this.sendOrEditMessage(
      chatId,
      "🎁 <b>MUA GIFT CODE</b>\n\n" +
      "Bước 1: Chọn <b>số lượng</b> code bạn muốn mua:\n" +
      "💡 Phí dịch vụ: 5%",
      keyboard,
      "HTML",
      messageId
    );
  }

  // Buy gift code — step 2: choose amount per code
  private async showBuyGiftCodeAmounts(chatId: number, userId: string, qty: number, messageId?: number) {
    if (!this.bot) return;

    const keyboard = {
      inline_keyboard: [
        [
          { text: "10.000đ", callback_data: `buygift_${qty}_10000` },
          { text: "20.000đ", callback_data: `buygift_${qty}_20000` }
        ],
        [
          { text: "50.000đ", callback_data: `buygift_${qty}_50000` },
          { text: "100.000đ", callback_data: `buygift_${qty}_100000` }
        ],
        [
          { text: "200.000đ", callback_data: `buygift_${qty}_200000` },
          { text: "500.000đ", callback_data: `buygift_${qty}_500000` }
        ],
        [
          { text: "💰 Nhập số khác", callback_data: `buygift_${qty}_custom` }
        ]
      ]
    };

    await this.sendOrEditMessage(
      chatId,
      `🎁 <b>MUA GIFT CODE</b>\n\n` +
      `✅ Số lượng: <b>${qty} code</b>\n\n` +
      `Bước 2: Chọn <b>mệnh giá</b> mỗi code:\n` +
      `💡 Phí dịch vụ: 5%`,
      keyboard,
      "HTML",
      messageId
    );
  }

  // Gift box system
  private async showGiftBox(chatId: number, userId: string) {
    if (!this.bot) return;

    await this.bot.sendMessage(
      chatId,
      "🧧 <b>LÌ XÌ</b>\n\n" +
      "✨ Tính năng đang phát triển!\n" +
      "Sắp có nhiều quà tặng hấp dẫn cho các thành viên thân thiết.\n\n" +
      "🔔 Theo dõi để không bỏ lỡ!",
      { parse_mode: "HTML" }
    );
  }

  // Withdrawal methods
  private async showWithdrawBank(chatId: number, userId: string, messageId?: number) {
    if (!this.bot) return;

    await this.bot.sendMessage(
      chatId,
      "🏧 Vui lòng thực hiện theo hướng dẫn sau:\n\n" +
      "👉 /rutbank [dấu cách] Số tiền muốn rút [dấu cách]  Mã ngân hàng [dấu cách] Số tài khoản [dấu cách] Tên chủ tài khoản\n" +
      "👉 VD:  Muốn rút 100k đến TK số 01234567890 tại Ngân hàng Vietcombank. Thực hiện theo cú pháp sau:\n\n" +
      "/rutbank 100000 VCB 01234567890 NGUYEN VAN A\n\n" +
      "⚠️ Lưu ý: Không hỗ trợ hoàn tiền nếu bạn nhập sai thông tin Tài khoản.\n" +
      "👉 Rút tối thiểu 100,000đ\n\n" +
      "MÃ NGÂN HÀNG - TÊN NGÂN HÀNG\n\n" +
      "📌 ACB ==> ACB - NH TMCP A CHAU\n" +
      "📌 BIDV ==> BIDV - NH DAU TU VA PHAT TRIEN VIET NAM\n" +
      "📌 MBB ==> MB - NH TMCP QUAN DOI\n" +
      "📌 MSB ==> MSB - NH TMCP HANG HAI\n" +
      "📌 TCB ==> TECHCOMBANK - NH TMCP KY THUONG VIET NAM\n" +
      "📌 TPB ==> TPBANK - NH TMCP TIEN PHONG\n" +
      "📌 VCB ==> VIETCOMBANK - NH TMCP NGOAI THUONG VIET NAM\n" +
      "📌 VIB ==> VIB - NH TMCP QUOC TE VIET NAM\n" +
      "📌 VPB ==> VPBANK - NH TMCP VIET NAM THINH VUONG\n" +
      "📌 VTB ==> VIETINBANK - NH TMCP CONG THUONG VIET NAM\n" +
      "📌 SHIB ==> SHINHANBANK - NH TNHH SHINHAN VIET NAM\n" +
      "📌 ABB ==> ABBANK - NH TMCP AN BINH\n" +
      "📌 AGR ==> AGRIBANK - NH NN & PTNT VIET NAM\n" +
      "📌 VCCB ==> BANVIET - NH TMCP BAN VIET\n" +
      "📌 BVB ==> BAOVIETBANK - NH TMCP BAO VIET (BVB)\n" +
      "📌 DAB ==> DONGABANK - NH TMCP DONG A\n" +
      "📌 EIB ==> EXIMBANK - NH TMCP XUAT NHAP KHAU VIET NAM\n" +
      "📌 GPB ==> GPBANK - NH TMCP DAU KHI TOAN CAU\n" +
      "📌 HDB ==> HDBANK - NH TMCP PHAT TRIEN TP.HCM\n" +
      "📌 KLB ==> KIENLONGBANK - NH TMCP KIEN LONG\n" +
      "📌 NAB ==> NAMABANK - NH TMCP NAM A\n" +
      "📌 NCB ==> NCB - NH TMCP QUOC DAN\n" +
      "📌 OCB ==> OCB - NH TMCP PHUONG DONG\n" +
      "📌 OJB ==> OCEANBANK - NH TMCP DAI DUONG (OJB)\n" +
      "📌 PGB ==> PGBANK - NH TMCP XANG DAU PETROLIMEX\n" +
      "📌 PVB ==> PVCOMBANK - NH TMCP DAI CHUNG VIET NAM\n" +
      "📌 STB ==> SACOMBANK - NH TMCP SAI GON THUONG TIN\n" +
      "📌 SGB ==> SAIGONBANK - NH TMCP SAI GON CONG THUONG\n" +
      "📌 SCB ==> SCB - NH TMCP SAI GON\n" +
      "📌 SAB ==> SEABANK - NH TMCP DONG NAM A\n" +
      "📌 SHB ==> SHB - NH TMCP SAI GON HA NOI"
    );
  }

  private async showWithdrawCard(chatId: number, userId: string, messageId?: number) {
    if (!this.bot) return;

    await this.bot.sendMessage(
      chatId,
      "🎫 **RÚT TIỀN THẺ CÀO**\n\n" +
      "📝 Để rút tiền bằng thẻ cào, vui lòng:\n\n" +
      "1️⃣ Liên hệ admin: @AdminUsername\n" +
      "2️⃣ Cung cấp thông tin:\n" +
      "• ID Telegram: `" + userId + "`\n" +
      "• Số tiền rút\n" +
      "• Loại thẻ (Viettel, Vinaphone, Mobifone)\n" +
      "• Mệnh giá mong muốn\n\n" +
      "⏰ **Thời gian xử lý:** 2-24 giờ\n" +
      "💰 **Phí rút:** 15%\n" +
      "💵 **Tối thiểu:** 50,000đ\n\n" +
      "⚠️ **Lưu ý:** Tỷ lệ quy đổi thấp hơn các phương thức khác",
      { parse_mode: "Markdown" }
    );
  }





  async stop() {
    if (this.bot) {
      await this.bot.close();
      this.bot = null;
      console.log("🛑 Telegram bot stopped");
    }
  }

  // Clear first deposit bonus flag for a user
  clearFirstDepositBonus(userId: string) {
    this.firstDepositBonusActive.delete(userId);
    console.log(`🧹 Cleared first deposit bonus flag for user ${userId}`);
  }

  // Store payment method for user
  private storePaymentMethod(userId: string, method: string) {
    this.paymentMethods.set(userId, method);
  }

  // Get stored payment method for user
  private getPaymentMethod(userId: string): string {
    return this.paymentMethods.get(userId) || 'bank';
  }

  // Handle copy callback
  private async handleCopyCallback(chatId: number, userId: string, type: string, orderCode: string) {
    if (!this.bot) return;

    try {
      // Get transaction details by externalId (order code)
      const transactions = await storage.getTransactionsByUser(userId, 100);
      const transaction = transactions.find(t => 
        t.externalId === orderCode
      );

      if (!transaction || !transaction.metadata) {
        await this.bot.sendMessage(chatId, "❌ Không tìm thấy thông tin giao dịch!");
        return;
      }

      const metadata = transaction.metadata as any;
      const paymentDetails = metadata.paymentDetails;
      
      if (!paymentDetails) {
        await this.bot.sendMessage(chatId, "❌ Không tìm thấy chi tiết thanh toán!");
        return;
      }

      let copyText = "";
      let successMessage = "";

      if (type === "acct") {
        copyText = paymentDetails.accountNumber || "";
        successMessage = "📋 Đã copy số tài khoản";
      } else if (type === "content") {
        copyText = paymentDetails.description || "";
        successMessage = "📝 Đã copy nội dung chuyển khoản";
      }

      if (copyText) {
        // Send the text in a copyable format for easy copying
        await this.bot.sendMessage(chatId, `${successMessage}:\n\`${copyText}\``, {
          parse_mode: "Markdown"
        });
      } else {
        await this.bot.sendMessage(chatId, "❌ Không tìm thấy thông tin cần copy!");
      }
    } catch (error) {
      console.error("Error handling copy callback:", error);
      await this.bot.sendMessage(chatId, "❌ Có lỗi xảy ra khi copy!");
    }
  }

  // Gift code redemption
  private async redeemGiftCode(chatId: number, userId: string, giftCode: string) {
    if (!this.bot) return;

    try {
      const result = await storage.redeemGiftCode(userId, giftCode);

      if (!result.success) {
        await this.bot.sendMessage(chatId, `❌ ${result.message || 'Mã code không hợp lệ!'}`);
        return;
      }

      const amountVND = result.amount!;
      const newBalance = await storage.getTotalBalance(userId);

      await this.bot.sendMessage(
        chatId,
        `🎁 <b>ĐỔI CODE THÀNH CÔNG!</b>\n\n` +
        `💰 Số tiền nhận: ${amountVND.toLocaleString('vi-VN')}đ\n` +
        `💳 Số dư mới: ${newBalance.toLocaleString('vi-VN')}đ\n\n` +
        `✅ Mã code <code>${giftCode}</code> đã được sử dụng thành công!`,
        { parse_mode: 'HTML' }
      );

      // Notify group about redemption
      try {
        const MAIN_GROUP = -1003132451812;
        const maskedId = `****${userId.slice(-5)}`;
        await this.bot.sendMessage(MAIN_GROUP,
          `❇️ Người chơi ${maskedId}\n` +
          `Nhận giftcode ${giftCode} thành công! Giá trị: ${amountVND.toLocaleString('vi-VN')}đ`
        );
      } catch { /* ignore */ }

    } catch (error) {
      console.error("Error redeeming gift code:", error);
      await this.bot.sendMessage(chatId, "❌ Có lỗi xảy ra khi đổi mã code. Vui lòng thử lại sau!");
    }
  }

  // ========== WEEKLY REWARDS AUTO-DISTRIBUTION ==========
  
  /** Trả về Date hiện tại theo giờ Việt Nam (UTC+7) */
  private nowVN(): Date {
    return new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Ho_Chi_Minh" }));
  }

  private getWeekYear(date: Date = this.nowVN()): string {
    // Get ISO week number and year (tính theo ngày VN)
    const tempDate = new Date(date);
    tempDate.setHours(0, 0, 0, 0);
    tempDate.setDate(tempDate.getDate() + 3 - (tempDate.getDay() + 6) % 7);
    const week1 = new Date(tempDate.getFullYear(), 0, 4);
    const weekNum = 1 + Math.round(((tempDate.getTime() - week1.getTime()) / 86400000 - 3 + (week1.getDay() + 6) % 7) / 7);
    return `${tempDate.getFullYear()}-W${weekNum.toString().padStart(2, '0')}`;
  }

  private async distributeWeeklyRewards(): Promise<void> {
    try {
      console.log('🏆 Starting weekly rewards distribution...');
      
      // Get last week's week-year in VN timezone
      const lastWeek = this.nowVN();
      lastWeek.setDate(lastWeek.getDate() - 7);
      const weekYear = this.getWeekYear(lastWeek);
      
      // Get top 3 bettors for last week
      const topBettors = await storage.getTopBettorsForWeek(weekYear, 3);
      
      if (topBettors.length === 0) {
        console.log('📊 No betting activity last week, skipping rewards distribution');
        return;
      }
      
      // Reward amounts in cents (VND)
      const rewards = [
        { rank: 1, amount: 50000, emoji: '🥇', title: 'NHẤT' },
        { rank: 2, amount: 25000, emoji: '🥈', title: 'NHÌ' },
        { rank: 3, amount: 15000, emoji: '🥉', title: 'BA' }
      ];
      
      // Distribute rewards
      for (const bettor of topBettors) {
        const rewardInfo = rewards.find(r => r.rank === bettor.rank);
        if (!rewardInfo) continue;
        
        try {
          // Check if reward already exists
          const existingReward = await storage.getWeeklyReward(bettor.userId, weekYear);
          if (existingReward) {
            console.log(`⏭️ Reward already exists for user ${bettor.userId} week ${weekYear}`);
            continue;
          }
          
          // Create weekly reward record
          await storage.createWeeklyReward({
            userId: bettor.userId,
            weekYear,
            rank: bettor.rank,
            rewardAmount: rewardInfo.amount.toString(),
            totalBetAmount: bettor.totalBetAmount.toString()
          });
          
          // Notify user about reward
          if (this.bot) {
            const message = 
              `🏆 <b>PHẦN THƯỞNG TUẦN ${weekYear}</b>\n\n` +
              `${rewardInfo.emoji} <b>TOP ${rewardInfo.title}</b>\n\n` +
              `💰 Tổng cược: ${bettor.totalBetAmount.toLocaleString()}đ\n` +
              `🎁 Phần thưởng: ${rewardInfo.amount.toLocaleString()}đ\n\n` +
              `✅ Phần thưởng đã được ghi nhận!\n` +
              `📲 Sử dụng lệnh /homqua để nhận thưởng!\n\n` +
              `🎉 Chúc mừng bạn đã vào top tuần này!`;
            
            try {
              await this.bot.sendMessage(bettor.userId, message, { parse_mode: 'HTML' });
            } catch (sendError) {
              console.error(`Failed to notify user ${bettor.userId}:`, sendError);
            }
          }
          
          console.log(`✅ Distributed ${rewardInfo.amount}đ to user ${bettor.userId} (Rank ${bettor.rank})`);
        } catch (error) {
          console.error(`❌ Failed to distribute reward to user ${bettor.userId}:`, error);
        }
      }
      
      console.log('🎉 Weekly rewards distribution completed!');
      
      // Reset old betting stats AFTER distributing rewards
      try {
        const currentWeekYear = this.getWeekYear();
        console.log(`🧹 Resetting old betting stats (keeping current week: ${currentWeekYear})...`);
        await storage.resetWeeklyBettingStats(currentWeekYear);
        console.log('✅ Old betting stats reset completed!');
      } catch (resetError) {
        console.error('❌ Error resetting weekly betting stats:', resetError);
      }
    } catch (error) {
      console.error('❌ Error in distributeWeeklyRewards:', error);
    }
  }

  private scheduleWeeklyRewards(): void {
    // Schedule to run every Monday at 9:00 AM
    const checkAndDistribute = () => {
      const now = new Date();
      const dayOfWeek = now.getDay(); // 0 = Sunday, 1 = Monday, ...
      const hour = now.getHours();
      const minute = now.getMinutes();
      
      // Run on Monday (1) at 00:00
      if (dayOfWeek === 1 && hour === 0 && minute === 0) {
        this.distributeWeeklyRewards();
      }
    };
    
    // Check every minute
    setInterval(checkAndDistribute, 60 * 1000);
    
    console.log('⏰ Weekly rewards scheduler initialized (runs every Monday at 00:00)');
  }

  // ========== END WEEKLY REWARDS AUTO-DISTRIBUTION ==========

  // ========== DAILY REWARDS AUTO-DISTRIBUTION ==========

  private getDateString(date: Date = this.nowVN()): string {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  private async distributeDailyRewards(): Promise<void> {
    try {
      console.log('🎯 Starting daily rewards distribution...');
      
      // Get yesterday's date in VN timezone
      const yesterday = this.nowVN();
      yesterday.setDate(yesterday.getDate() - 1);
      const dateString = this.getDateString(yesterday);
      
      // Get top 3 bettors for yesterday
      const topBettors = await storage.getTopBettorsForDay(dateString, 3);
      
      if (topBettors.length === 0) {
        console.log('📊 No betting activity yesterday, skipping daily rewards distribution');
        return;
      }
      
      // Reward amounts (VND)
      const rewards = [
        { rank: 1, amount: 30000, emoji: '🥇', title: 'NHẤT' },
        { rank: 2, amount: 15000, emoji: '🥈', title: 'NHÌ' },
        { rank: 3, amount: 10000, emoji: '🥉', title: 'BA' }
      ];
      
      // Distribute rewards
      for (const bettor of topBettors) {
        const rewardInfo = rewards.find(r => r.rank === bettor.rank);
        if (!rewardInfo) continue;
        
        try {
          // Check if reward already exists
          const existingReward = await storage.getDailyReward(bettor.userId, dateString);
          if (existingReward) {
            console.log(`⏭️ Daily reward already exists for user ${bettor.userId} date ${dateString}`);
            continue;
          }
          
          // Create daily reward record
          await storage.createDailyReward({
            userId: bettor.userId,
            date: dateString,
            rank: bettor.rank,
            rewardAmount: rewardInfo.amount.toString(),
            totalBetAmount: bettor.totalBetAmount.toString()
          });
          
          // Notify user about reward
          if (this.bot) {
            const message = 
              `🎯 <b>PHẦN THƯỞNG NGÀY</b> 🎯\n\n` +
              `${rewardInfo.emoji} <b>TOP ${rewardInfo.title} NGÀY ${dateString}</b>\n\n` +
              `💰 Tổng cược: ${bettor.totalBetAmount.toLocaleString()}đ\n` +
              `🎁 Phần thưởng: ${rewardInfo.amount.toLocaleString()}đ\n\n` +
              `🎁 Phần thưởng đã được gửi vào <b>🧧 LÌ XÌ</b> của bạn!\n` +
              `👉 Nhấn /homqua để mở 🧧 LÌ XÌ và nhận thưởng!\n\n` +
              `🎉 Chúc mừng người chơi ${bettor.userId}!`;
            
            try {
              await this.bot.sendMessage(bettor.userId, message, { parse_mode: 'HTML' });
            } catch (sendError) {
              console.error(`Failed to notify user ${bettor.userId}:`, sendError);
            }
          }
          
          console.log(`✅ Distributed ${rewardInfo.amount}đ daily reward to user ${bettor.userId} (Rank ${bettor.rank})`);
        } catch (error) {
          console.error(`❌ Failed to distribute daily reward to user ${bettor.userId}:`, error);
        }
      }
      
      console.log('🎉 Daily rewards distribution completed!');
    } catch (error) {
      console.error('❌ Error in distributeDailyRewards:', error);
    }
  }

  private scheduleDailyRewards(): void {
    // Schedule to run every day at 9:00 AM
    const checkAndDistribute = () => {
      const now = new Date();
      const hour = now.getHours();
      const minute = now.getMinutes();
      
      // Run at 00:00 every day
      if (hour === 0 && minute === 0) {
        this.distributeDailyRewards();
      }
    };
    
    // Check every minute
    setInterval(checkAndDistribute, 60 * 1000);
    
    console.log('⏰ Daily rewards scheduler initialized (runs every day at 00:00)');
  }

  // ========== END DAILY REWARDS AUTO-DISTRIBUTION ==========

  // ========== LÔ ĐỀ XSMB ==========

  private getTodayDateString(): string {
    const now = this.nowVN();
    const d = now.getDate().toString().padStart(2, '0');
    const m = (now.getMonth() + 1).toString().padStart(2, '0');
    const y = now.getFullYear();
    return `${d}-${m}-${y}`;
  }

  private async handleLodeBetMulti(
    chatId: number,
    userId: string,
    type: 'lo' | 'de',
    numbers: string[],
    amountPerNumber: number
  ) {
    if (!this.bot) return;

    const minDiem = 1;
    const maxDiem = 1000;
    const diemPerNumber = amountPerNumber; // tham số này là số điểm
    const vndPerNumber = diemPerNumber * DIEM_TO_VND;
    const typeName = type === 'lo' ? 'LÔ' : 'ĐỀ';
    const multiplier = type === 'lo' ? 70 : 80;
    const totalDiem = diemPerNumber * numbers.length;
    const totalVND = vndPerNumber * numbers.length;

    if (diemPerNumber < minDiem || diemPerNumber > maxDiem) {
      await this.bot.sendMessage(chatId,
        `❌ Số điểm cược mỗi số phải từ ${minDiem} đến ${maxDiem} điểm!\n` +
        `💡 1 điểm = ${DIEM_TO_VND.toLocaleString('vi-VN')}đ`
      );
      return;
    }

    try {
      const userData = await storage.getBotUser(userId);
      if (!userData) {
        await this.bot.sendMessage(chatId, "❌ Không tìm thấy thông tin tài khoản.");
        return;
      }

      const currentBalance = parseFloat(userData.balance || "0");
      if (totalVND > currentBalance) {
        await this.bot.sendMessage(chatId,
          `❌ Số dư không đủ!\n` +
          `💸 Cần: ${totalVND.toLocaleString('vi-VN')}đ (${numbers.length} số × ${diemPerNumber} điểm × ${DIEM_TO_VND.toLocaleString('vi-VN')}đ)\n` +
          `💰 Số dư: ${currentBalance.toLocaleString('vi-VN')}đ`
        );
        return;
      }

      const now = new Date();
      const today2 = this.getTodayDateString();
      if (this.lodeResultProcessed === today2) {
        await this.bot.sendMessage(chatId,
          `⏰ <b>Đã hết giờ cược hôm nay!</b>\n\n` +
          `Kết quả XSMB đã ra và được xử lý. Vui lòng đặt cược ngày mai.\n` +
          `💡 Gõ <code>XSMB</code> để xem kết quả hôm nay.`,
          { parse_mode: 'HTML' }
        );
        return;
      }
      const nowVNCutoff = this.nowVN();
      const cutoffH = nowVNCutoff.getHours();
      const cutoffM = nowVNCutoff.getMinutes();
      if (cutoffH > 18 || (cutoffH === 18 && cutoffM >= 25)) {
        await this.bot.sendMessage(chatId,
          `⏰ <b>Sắp hết giờ cược!</b>\n\n` +
          `Đang chờ kết quả XSMB. Không nhận cược mới sau 18:25.\n` +
          `💡 Gõ <code>XSMB</code> để kiểm tra kết quả.`,
          { parse_mode: 'HTML' }
        );
        return;
      }

      const today = this.getTodayDateString();

      // Deduct total VND at once
      const newBalance = (currentBalance - totalVND).toString();
      await storage.updateBotUser(userId, { balance: newBalance });

      // Save each bet (store both điểm and VND) — persist to DB for restart recovery
      for (const num of numbers) {
        let txId: number | undefined;
        try {
          const [inserted] = await db
            .insert(transactionsTable)
            .values({
              userId,
              type: 'lode_bet',
              amount: vndPerNumber.toString(),
              status: 'pending',
              method: 'lode',
              metadata: { number: num, betType: type, diem: diemPerNumber, date: today, chatId },
            })
            .returning({ id: transactionsTable.id });
          txId = inserted?.id;
        } catch (dbErr) {
          logger.warn({ dbErr }, '[LôĐề] Không thể lưu cược vào DB — vẫn lưu in-memory');
        }
        this.lodeBets.push({ userId, chatId, type, number: num, diem: diemPerNumber, amount: vndPerNumber, timestamp: Date.now(), date: today, txId });
      }

      // Build confirmation message
      const numList = numbers.map(n => `<code>${n}</code>`).join(', ');
      const winPerNum = (vndPerNumber * multiplier).toLocaleString('vi-VN');
      const winAll = (vndPerNumber * multiplier * numbers.length).toLocaleString('vi-VN');

      await this.bot.sendMessage(chatId,
        `✅ <b>ĐẶT CƯỢC ${typeName} THÀNH CÔNG!</b>\n\n` +
        `🔢 Số đã cược (${numbers.length} số): ${numList}\n` +
        `🎯 Mỗi số: <b>${diemPerNumber} điểm</b> (${vndPerNumber.toLocaleString('vi-VN')}đ)\n` +
        `💸 Tổng: ${totalDiem} điểm = ${totalVND.toLocaleString('vi-VN')}đ\n` +
        `🏆 Trúng 1 số: ${winPerNum}đ  |  Trúng tất cả: ${winAll}đ\n` +
        `📅 Kết quả XSMB hôm nay (${today})\n` +
        `💎 Số dư còn lại: ${parseFloat(newBalance).toLocaleString('vi-VN')}đ\n\n` +
        `💡 Gõ <code>CUOCLO</code> để xem cược đang chờ.`,
        { parse_mode: 'HTML' }
      );
    } catch (error) {
      console.error('Error handling multi lode bet:', error);
      await this.bot.sendMessage(chatId, "❌ Có lỗi xảy ra khi đặt cược. Vui lòng thử lại!");
    }
  }

  private async handleLodeBet(
    chatId: number,
    userId: string,
    type: 'lo' | 'de',
    number: string,
    amount: number
  ) {
    if (!this.bot) return;

    // Delegate to multi handler with single number
    await this.handleLodeBetMulti(chatId, userId, type, [number], amount);
  }

  private async fetchXSMBResults(_targetDate?: Date): Promise<XSMBResult | null> {
    const todayDate = new Date();
    const todayStr = `${todayDate.getDate().toString().padStart(2, '0')}-${(todayDate.getMonth() + 1).toString().padStart(2, '0')}-${todayDate.getFullYear()}`;

    // Helper: extract all numbers from a cell content string (splits on spaces, dashes, commas)
    const extractNums = (cell: string): string[] =>
      cell.split(/[\s\-,]+/).map(s => s.trim()).filter(s => /^\d{2,6}$/.test(s));

    // Helper: collect last-2-digits from prize values into allNumbers array
    const collectLast2 = (vals: string[], allNumbers: string[]) => {
      for (const v of vals) {
        if (v.length >= 2) {
          const last2 = v.slice(-2).padStart(2, '0');
          if (!allNumbers.includes(last2)) allNumbers.push(last2);
        }
      }
    };

    // Helper: parse date string dd/mm/yyyy or dd-mm-yyyy → dd-mm-yyyy
    const parseDate = (s: string): string | null => {
      const m = s.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);
      return m ? `${m[1].padStart(2,'0')}-${m[2].padStart(2,'0')}-${m[3]}` : null;
    };

    // ── Source 1: minhngoc.net.vn JSONP (confirmed working) ────────────────
    try {
      const url = `https://www.minhngoc.net.vn/getkqxs/mien-bac.js`;
      const resp = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
        signal: AbortSignal.timeout(12000),
      });
      if (!resp.ok) throw new Error(`minhngoc JSONP status ${resp.status}`);
      const js = await resp.text();

      // Parse date from "Ngày: 15/05/2026" in the embedded HTML
      let parsedDate = todayStr;
      const dMatch = js.match(/Ng[aà]y[:\s]*(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/i);
      if (dMatch) parsedDate = `${dMatch[1].padStart(2,'0')}-${dMatch[2].padStart(2,'0')}-${dMatch[3]}`;

      // Prize class map — order matters for display
      const prizeMap: Array<{ cls: string; name: string }> = [
        { cls: 'giaidb',  name: 'Giải Đặc Biệt' },
        { cls: 'giai1',   name: 'Giải Nhất' },
        { cls: 'giai2',   name: 'Giải Nhì' },
        { cls: 'giai3',   name: 'Giải Ba' },
        { cls: 'giai4',   name: 'Giải Tư' },
        { cls: 'giai5',   name: 'Giải Năm' },
        { cls: 'giai6',   name: 'Giải Sáu' },
        { cls: 'giai7',   name: 'Giải Bảy' },
      ];

      const prizes: { name: string; values: string[] }[] = [];
      const allNumbers: string[] = [];
      let specialPrize = '';

      for (const { cls, name } of prizeMap) {
        // Match class="giaidb">VALUE</td> — value may contain spaces & dashes for multiple numbers
        const re = new RegExp(`class="${cls}">([^<]+)<`, 'i');
        const m = js.match(re);
        if (!m) continue;
        const vals = extractNums(m[1]);
        if (vals.length === 0) continue;
        prizes.push({ name, values: vals });
        collectLast2(vals, allNumbers);
        if (!specialPrize && cls === 'giaidb') specialPrize = vals[0] || '';
      }

      if (allNumbers.length > 0) {
        console.log(`[LôĐề] minhngoc JSONP: kết quả ngày ${parsedDate}, ${allNumbers.length} số`);
        return { specialPrize, allNumbers, rawPrizes: prizes, date: parsedDate, isYesterday: parsedDate !== todayStr } as any;
      }
      throw new Error('minhngoc JSONP: no numbers parsed');
    } catch (err1) {
      console.error('[XSMB] Source 1 (minhngoc JSONP) failed:', err1);
    }

    // ── Source 2: xskt.com.vn /xsmb — scrape HTML table ───────────────────
    try {
      const url2 = `https://xskt.com.vn/xsmb`;
      const resp2 = await fetch(url2, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'text/html,application/xhtml+xml',
          'Accept-Language': 'vi-VN,vi;q=0.9',
        },
        signal: AbortSignal.timeout(15000),
      });
      if (!resp2.ok) throw new Error(`xskt.com.vn status ${resp2.status}`);
      const html2 = await resp2.text();

      let parsedDate2 = todayStr;
      const dMatch2 = html2.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);
      if (dMatch2) parsedDate2 = parseDate(dMatch2[0]) || todayStr;

      // Extract numbers: look for table cells with only digits
      const allNumbers2: string[] = [];
      const prizes2: { name: string; values: string[] }[] = [];
      let specialPrize2 = '';

      // Match <td ...>digits</td> patterns
      const tdRe = /class="([^"]*giai[^"]*)"[^>]*>([^<]+)</gi;
      let tdMatch;
      while ((tdMatch = tdRe.exec(html2)) !== null) {
        const cls = tdMatch[1];
        const vals = extractNums(tdMatch[2]);
        if (vals.length === 0) continue;
        let prizeName = 'Giải';
        if (/giaidb/i.test(cls)) prizeName = 'Giải Đặc Biệt';
        else if (/giai1/i.test(cls)) prizeName = 'Giải Nhất';
        else if (/giai2/i.test(cls)) prizeName = 'Giải Nhì';
        else if (/giai3/i.test(cls)) prizeName = 'Giải Ba';
        else if (/giai4/i.test(cls)) prizeName = 'Giải Tư';
        else if (/giai5/i.test(cls)) prizeName = 'Giải Năm';
        else if (/giai6/i.test(cls)) prizeName = 'Giải Sáu';
        else if (/giai7/i.test(cls)) prizeName = 'Giải Bảy';
        prizes2.push({ name: prizeName, values: vals });
        collectLast2(vals, allNumbers2);
        if (!specialPrize2 && /giaidb/i.test(cls)) specialPrize2 = vals[0] || '';
      }

      if (allNumbers2.length > 0) {
        console.log(`[LôĐề] xskt.com.vn HTML: kết quả ngày ${parsedDate2}, ${allNumbers2.length} số`);
        return { specialPrize: specialPrize2, allNumbers: allNumbers2, rawPrizes: prizes2, date: parsedDate2, isYesterday: parsedDate2 !== todayStr } as any;
      }
      throw new Error('xskt.com.vn: no numbers parsed');
    } catch (err2) {
      console.error('[XSMB] Source 2 (xskt.com.vn) failed:', err2);
    }

    // ── Source 3: xoso.com.vn ──────────────────────────────────────────────
    try {
      const url3 = `https://xoso.com.vn/xsmb.js`;
      const resp3 = await fetch(url3, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
        signal: AbortSignal.timeout(12000),
      });
      if (!resp3.ok) throw new Error(`xoso.com.vn status ${resp3.status}`);
      const js3 = await resp3.text();

      let parsedDate3 = todayStr;
      const dMatch3 = js3.match(/Ng[aà]y[:\s]*(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/i);
      if (dMatch3) parsedDate3 = `${dMatch3[1].padStart(2,'0')}-${dMatch3[2].padStart(2,'0')}-${dMatch3[3]}`;

      const prizeMap3: Array<{ cls: string; name: string }> = [
        { cls: 'giaidb', name: 'Giải Đặc Biệt' },
        { cls: 'giai1',  name: 'Giải Nhất' },
        { cls: 'giai2',  name: 'Giải Nhì' },
        { cls: 'giai3',  name: 'Giải Ba' },
        { cls: 'giai4',  name: 'Giải Tư' },
        { cls: 'giai5',  name: 'Giải Năm' },
        { cls: 'giai6',  name: 'Giải Sáu' },
        { cls: 'giai7',  name: 'Giải Bảy' },
      ];
      const allNumbers3: string[] = [];
      const prizes3: { name: string; values: string[] }[] = [];
      let specialPrize3 = '';
      for (const { cls, name } of prizeMap3) {
        const re3 = new RegExp(`class="${cls}">([^<]+)<`, 'i');
        const m3 = js3.match(re3);
        if (!m3) continue;
        const vals3 = extractNums(m3[1]);
        if (vals3.length === 0) continue;
        prizes3.push({ name, values: vals3 });
        collectLast2(vals3, allNumbers3);
        if (!specialPrize3 && cls === 'giaidb') specialPrize3 = vals3[0] || '';
      }
      if (allNumbers3.length > 0) {
        console.log(`[LôĐề] xoso.com.vn JS: kết quả ngày ${parsedDate3}`);
        return { specialPrize: specialPrize3, allNumbers: allNumbers3, rawPrizes: prizes3, date: parsedDate3, isYesterday: parsedDate3 !== todayStr } as any;
      }
      throw new Error('xoso.com.vn: no numbers');
    } catch (err3) {
      console.error('[XSMB] Source 3 (xoso.com.vn) failed:', err3);
    }

    return null;
  }

  /**
   * Khôi phục trạng thái lô đề sau khi bot restart:
   * 1. Đọc ngày đã xử lý kết quả từ DB → tránh xử lý lại
   * 2. Nạp lại các cược hôm nay chưa xử lý từ DB → không mất cược
   */
  private async loadLodeStateFromDB(): Promise<void> {
    const today = this.getTodayDateString();

    // 1. Đọc lodeResultProcessed từ bot_settings
    try {
      const { getSetting } = await import('../lib/settings.js');
      const savedDate = await getSetting('lode_result_processed_date');
      if (savedDate === today) {
        this.lodeResultProcessed = today;
        console.log('[LôĐề] Kết quả hôm nay đã xử lý (đọc từ DB) — bỏ qua re-process');
        return; // Không cần load bets vì đã xử lý
      }
    } catch (err) {
      logger.warn({ err }, '[LôĐề] Không đọc được lode_result_processed_date từ DB');
    }

    // 2. Nạp lại cược hôm nay từ transactionsTable (type='lode_bet', status='pending')
    try {
      const rows = await db
        .select()
        .from(transactionsTable)
        .where(
          and(
            eq(transactionsTable.type, 'lode_bet'),
            eq(transactionsTable.status, 'pending'),
            sql`${transactionsTable.metadata}->>'date' = ${today}`
          )
        );

      for (const row of rows) {
        const meta = row.metadata as any;
        if (!meta?.number || !meta?.betType || !meta?.date) continue;
        // Tránh duplicate nếu bet đã có trong memory (không nên xảy ra khi mới start)
        const alreadyLoaded = this.lodeBets.some(b => b.txId === row.id);
        if (alreadyLoaded) continue;
        this.lodeBets.push({
          userId: row.userId,
          chatId: meta.chatId ?? parseInt(row.userId),
          type: meta.betType as 'lo' | 'de',
          number: meta.number,
          diem: meta.diem ?? 0,
          amount: parseFloat(row.amount),
          timestamp: row.createdAt.getTime(),
          date: meta.date,
          txId: row.id,
        });
      }
      if (rows.length > 0) {
        console.log(`[LôĐề] ♻️ Khôi phục ${rows.length} cược hôm nay từ DB sau restart`);
      }
    } catch (err) {
      logger.warn({ err }, '[LôĐề] Không load được pending bets từ DB');
    }
  }

  private async processLodeResults() {
    if (!this.bot) return;

    const today = this.getTodayDateString();
    if (this.lodeResultProcessed === today) return; // Already processed today

    console.log(`[LôĐề] Fetching XSMB results for ${today}...`);

    const result = await this.fetchXSMBResults();
    if (!result) {
      console.error('[LôĐề] Failed to fetch XSMB results — will retry next minute');
      return;
    }

    // XSMB có 8 giải (ĐB, 1-7) → tổng tối thiểu 18 số 2 chữ số cuối.
    // Nếu kết quả chưa đầy đủ (fetch lúc phiên chưa xong), retry lần sau.
    const MIN_NUMBERS = 15;
    if (result.allNumbers.length < MIN_NUMBERS) {
      console.warn(`[LôĐề] Kết quả chưa đầy đủ (${result.allNumbers.length} số, cần ≥ ${MIN_NUMBERS}) — sẽ thử lại sau 1 phút`);
      return;
    }

    // Đánh dấu đã xử lý SAU KHI có kết quả đầy đủ — lưu cả vào DB để survive restart
    this.lodeResultProcessed = today;
    try {
      await storage.setSetting('lode_result_processed_date', today);
    } catch (err) {
      logger.warn({ err }, '[LôĐề] Không lưu được lode_result_processed_date vào DB');
    }
    console.log(`[LôĐề] Kết quả đầy đủ: ${result.allNumbers.length} số — bắt đầu xử lý cược`);


    // Find all bets placed for today
    const todayBets = this.lodeBets.filter(b => b.date === today);
    this.lodeBets = this.lodeBets.filter(b => b.date !== today); // Remove processed

    const specialLast2 = result.specialPrize.slice(-2).padStart(2, '0');

    // Announce result to all unique chatIds
    const chatIds = [...new Set(todayBets.map(b => b.chatId))];
    const { getSetting: getSettingForAdmin } = await import('../lib/settings.js');
    const adminChatIdStr = await getSettingForAdmin('admin_chat_id');
    const adminChatId = adminChatIdStr ? parseInt(adminChatIdStr) : 6030019812;

    // Build result summary message
    const prizeLines = result.rawPrizes
      .map(p => `<b>${p.name}:</b> ${p.values.join(' - ')}`)
      .join('\n');
    const resultMsg =
      `🎰 <b>KẾT QUẢ XỔ SỐ MIỀN BẮC</b> 🎰\n` +
      `📅 Ngày: ${today}\n` +
      `━━━━━━━━━━━━━━━━━━━━━━\n` +
      `${prizeLines}\n` +
      `━━━━━━━━━━━━━━━━━━━━━━\n` +
      `⭐ Giải ĐB 2 số cuối: <b>${specialLast2}</b>\n` +
      `🔢 Tất cả số (2 chữ số cuối): ${result.allNumbers.join(', ')}`;

    // Process each bet
    const userResults: Map<string, { chatId: number; wins: string[]; losses: string[]; totalWin: number }> = new Map();

    for (const bet of todayBets) {
      if (!userResults.has(bet.userId)) {
        userResults.set(bet.userId, { chatId: bet.chatId, wins: [], losses: [], totalWin: 0 });
      }
      const ur = userResults.get(bet.userId)!;

      let won = false;
      if (bet.type === 'lo') {
        won = result.allNumbers.includes(bet.number);
      } else {
        won = bet.number === specialLast2;
      }

      const typeName = bet.type === 'lo' ? 'Lô' : 'Đề';
      const multiplier = bet.type === 'lo' ? 70 : 80;
      const betDiem = bet.diem ?? Math.round(bet.amount / DIEM_TO_VND);

      if (won) {
        const winAmount = bet.amount * multiplier;
        ur.totalWin += winAmount;
        ur.wins.push(`${typeName} <b>${bet.number}</b> (${betDiem}đ): +${winAmount.toLocaleString('vi-VN')}đ`);

        // Credit winnings
        try {
          const userData = await storage.getBotUser(bet.userId);
          if (userData) {
            const newBal = (parseFloat(userData.balance || '0') + winAmount).toString();
            await storage.updateBotUser(bet.userId, { balance: newBal });
          }
        } catch (e) {
          console.error('[LôĐề] Error crediting win:', e);
        }
      } else {
        ur.losses.push(`${typeName} <b>${bet.number}</b> (${betDiem}đ): -${bet.amount.toLocaleString('vi-VN')}đ`);
      }

      // Cập nhật trạng thái giao dịch trong DB (won → completed, lost → cancelled)
      if (bet.txId) {
        try {
          await db
            .update(transactionsTable)
            .set({ status: won ? 'completed' : 'cancelled' } as any)
            .where(eq(transactionsTable.id, bet.txId));
        } catch (dbErr) {
          logger.warn({ dbErr, txId: bet.txId }, '[LôĐề] Không cập nhật được trạng thái cược trong DB');
        }
      }
    }

    // Send result to each user who placed bets
    for (const [userId, ur] of userResults) {
      try {
        let betMsg = `🎰 <b>KẾT QUẢ CỦA BẠN - ${today}</b>\n\n`;

        if (ur.wins.length > 0) {
          betMsg += `🏆 <b>TRÚNG THƯỞNG:</b>\n` + ur.wins.map(w => `  ✅ ${w}`).join('\n') + '\n\n';
        }
        if (ur.losses.length > 0) {
          betMsg += `😢 <b>Không trúng:</b>\n` + ur.losses.map(l => `  ❌ ${l}`).join('\n') + '\n\n';
        }
        if (ur.totalWin > 0) {
          betMsg += `💎 Tổng tiền thưởng: <b>+${ur.totalWin.toLocaleString('vi-VN')}đ</b>`;
        } else {
          betMsg += `💡 Chúc may mắn lần sau! Đặt cược mới bắt đầu từ 00:00.`;
        }

        await this.bot.sendMessage(ur.chatId, betMsg, { parse_mode: 'HTML' });
      } catch (e) {
        console.error('[LôĐề] Error sending result to user:', e);
      }
    }

    // Send full XSMB result to admin
    try {
      await this.bot.sendMessage(adminChatId, resultMsg, { parse_mode: 'HTML' });
    } catch (e) {
      console.error('[LôĐề] Error sending result to admin:', e);
    }

    console.log(`[LôĐề] Processed ${todayBets.length} bets for ${today}`);
  }

  private async showXSMBResult(chatId: number) {
    if (!this.bot) return;
    await this.bot.sendMessage(chatId, '⏳ Đang lấy kết quả XSMB...', { parse_mode: 'HTML' });

    const result = await this.fetchXSMBResults();
    if (!result) {
      await this.bot.sendMessage(chatId,
        `❌ Không thể lấy kết quả XSMB lúc này.\n` +
        `Kết quả thường có sau khi xổ số miền Bắc quay xong.\n` +
        `Vui lòng thử lại sau vài phút!`
      );
      return;
    }

    const specialLast2 = result.specialPrize ? result.specialPrize.slice(-2).padStart(2, '0') : '??';
    const prizeLines = result.rawPrizes
      .map(p => `<b>${p.name}:</b> ${p.values.join(' - ')}`)
      .join('\n');

    // Show time note: before 18:30 the result is from yesterday (normal), after 18:30 it's today's
    const now = new Date();
    const isBeforeDrawTime = now.getHours() < 18 || (now.getHours() === 18 && now.getMinutes() < 30);
    const dateNote = isBeforeDrawTime
      ? `📅 Kết quả ngày: ${result.date}`
      : `📅 Ngày: ${result.date}`;

    await this.bot.sendMessage(chatId,
      `🎰 <b>KẾT QUẢ XỔ SỐ MIỀN BẮC</b> 🎰\n` +
      `${dateNote}\n` +
      `━━━━━━━━━━━━━━━━━━━━━━\n` +
      `${prizeLines}\n` +
      `━━━━━━━━━━━━━━━━━━━━━━\n` +
      `⭐ Giải ĐB 2 số cuối: <b>${specialLast2}</b>\n` +
      `🔢 Tất cả số 2 chữ số cuối:\n${result.allNumbers.join(', ')}`,
      { parse_mode: 'HTML' }
    );
  }

  private async showMyLodeBets(chatId: number, userId: string) {
    if (!this.bot) return;
    const today = this.getTodayDateString();
    const myBets = this.lodeBets.filter(b => b.userId === userId && b.date === today);

    if (myBets.length === 0) {
      await this.bot.sendMessage(chatId,
        `📋 <b>Cược Lô Đề hôm nay (${today})</b>\n\n` +
        `Bạn chưa có cược nào hôm nay.\n\n` +
        `💡 Đặt cược:\n` +
        `• <code>LO [số] [điểm]</code> — Cược Lô (x70)\n` +
        `• <code>DE [số] [điểm]</code> — Cược Đề (x80)\n\n` +
        `📌 1 điểm = ${DIEM_TO_VND.toLocaleString('vi-VN')}đ`,
        { parse_mode: 'HTML' }
      );
      return;
    }

    const lines = myBets.map((b, i) => {
      const typeName = b.type === 'lo' ? 'Lô' : 'Đề';
      const multiplier = b.type === 'lo' ? 70 : 80;
      const betDiem = b.diem ?? Math.round(b.amount / DIEM_TO_VND);
      const winAmount = (b.amount * multiplier).toLocaleString('vi-VN');
      return `${i + 1}. ${typeName} <b>${b.number}</b> — ${betDiem} điểm (${b.amount.toLocaleString('vi-VN')}đ) → trúng: ${winAmount}đ`;
    });

    const totalDiem = myBets.reduce((s, b) => s + (b.diem ?? Math.round(b.amount / DIEM_TO_VND)), 0);
    const totalVND = myBets.reduce((s, b) => s + b.amount, 0);

    await this.bot.sendMessage(chatId,
      `📋 <b>Cược Lô Đề hôm nay (${today})</b>\n\n` +
      lines.join('\n') + '\n\n' +
      `💸 Tổng cược: ${totalDiem} điểm = ${totalVND.toLocaleString('vi-VN')}đ\n` +
      `⏰ Kết quả sẽ được cập nhật tự động khi có!`,
      { parse_mode: 'HTML' }
    );
  }

  // ========== END LÔ ĐỀ XSMB ==========

  // ─── VIP System Helpers ─────────────────────────────────────────────────────
  private getVipLevelFromPoints(vipPoints: number): number {
    const thresholds = [0, 10, 50, 100, 500, 1000, 5000, 10000, 50000, 100000];
    for (let i = thresholds.length - 1; i >= 0; i--) {
      if (vipPoints >= thresholds[i]) return i;
    }
    return 0;
  }

  private getVipDetails(level: number): { name: string; emoji: string; rate: number } {
    const data: Record<number, { name: string; emoji: string; rate: number }> = {
      0: { name: "Chưa có VIP", emoji: "🔘", rate: 0 },
      1: { name: "Tép Biển Tân Thủ", emoji: "🦐", rate: 100 },
      2: { name: "Chiến Binh Càng Cua", emoji: "🦀", rate: 200 },
      3: { name: "Bá Chủ Tôm Hùm", emoji: "🦞", rate: 300 },
      4: { name: "Kỵ Sĩ Cá Heo", emoji: "🐬", rate: 400 },
      5: { name: "Thợ Săn Đại Dương", emoji: "🦈", rate: 500 },
      6: { name: "Leviathan Biển Xanh", emoji: "🐋", rate: 600 },
      7: { name: "Chúa Tể Bóng Tối", emoji: "🦑", rate: 700 },
      8: { name: "Titan Đại Hải Trình", emoji: "🐳", rate: 800 },
      9: { name: "Hải Long Tối Thượng", emoji: "🐉", rate: 1000 },
    };
    return data[level] || data[0];
  }

  private async showVipInfo(chatId: number, userId: string) {
    if (!this.bot) return;
    const user = await storage.getBotUser(userId);
    if (!user) return;

    const totalWagered = parseFloat(user.totalWagered || "0");
    const earnedPoints = Math.floor(totalWagered / 300000);
    const spentPoints = await storage.getSpentVipPoints(userId);
    const availablePoints = Math.max(0, earnedPoints - spentPoints);
    const vipLevel = this.getVipLevelFromPoints(earnedPoints);
    const vipDetails = this.getVipDetails(vipLevel);
    const thresholds = [0, 10, 50, 100, 500, 1000, 5000, 10000, 50000, 100000];
    const nextThreshold = thresholds[vipLevel + 1] ?? null;
    const nextLevelDetails = this.getVipDetails(vipLevel + 1);

    const vipTable = [
      { lv: 1, name: "Tép Biển Tân Thủ 🦐", req: 10, rate: 100 },
      { lv: 2, name: "Chiến Binh Càng Cua 🦀", req: 50, rate: 200 },
      { lv: 3, name: "Bá Chủ Tôm Hùm 🦞", req: 100, rate: 300 },
      { lv: 4, name: "Kỵ Sĩ Cá Heo 🐬", req: 500, rate: 400 },
      { lv: 5, name: "Thợ Săn Đại Dương 🦈", req: 1000, rate: 500 },
      { lv: 6, name: "Leviathan Biển Xanh 🐋", req: 5000, rate: 600 },
      { lv: 7, name: "Chúa Tể Bóng Tối 🦑", req: 10000, rate: 700 },
      { lv: 8, name: "Titan Đại Hải Trình 🐳", req: 50000, rate: 800 },
      { lv: 9, name: "Hải Long Tối Thượng 🐉", req: 100000, rate: 1000 },
    ];

    const tableLines = vipTable.map(v => {
      const marker = vipLevel === v.lv ? "▶️" : "   ";
      return `${marker} VIP${v.lv} <b>${v.name}</b> — ${v.req.toLocaleString()} điểm | ${v.rate}đ/điểm`;
    }).join("\n");

    const nextInfo = nextThreshold !== null
      ? `\n🔺 Cần thêm <b>${(nextThreshold - earnedPoints).toLocaleString()}</b> điểm để lên VIP ${vipLevel + 1} (${nextLevelDetails.name} ${nextLevelDetails.emoji})`
      : "\n🏆 Bạn đã đạt cấp VIP tối đa!";

    const msg =
      `👑 <b>HỆ THỐNG VIP HARU88</b>\n\n` +
      `├ Cấp hiện tại: <b>VIP ${vipLevel}</b> ${vipDetails.emoji} ${vipDetails.name}\n` +
      `├ 🚀 Điểm VIP tích lũy: <b>${earnedPoints.toLocaleString()}</b> điểm\n` +
      `├ 🖐️ Điểm có thể đổi: <b>${availablePoints.toLocaleString()}</b> điểm\n` +
      `├ 💸 Tỷ lệ đổi: <b>${vipDetails.rate > 0 ? vipDetails.rate + "đ/điểm" : "Chưa đủ VIP 1"}</b>\n` +
      `└ 📊 Tổng cược: ${totalWagered.toLocaleString()}đ${nextInfo}\n\n` +
      `📋 <b>BẢNG CẤP VIP</b>\n` +
      `<i>(300,000đ cược = 1 điểm VIP)</i>\n\n` +
      tableLines + "\n\n" +
      `💡 Dùng <code>/doidiemvip [số điểm]</code> để đổi điểm lấy tiền`;

    const keyboard = {
      inline_keyboard: [
        [{ text: "📖 Hướng dẫn đổi điểm VIP", callback_data: "vip_guide" }]
      ]
    };

    await this.bot.sendMessage(chatId, msg, { parse_mode: "HTML", reply_markup: keyboard });
  }

  private async showEventDuDay(chatId: number) {
    if (!this.bot) return;
    const msg =
      `🎗 <b>SỰ KIỆN ĐU DÂY HARU88</b>\n\n` +
      `🔥 Cùng nhau "đú dây" — đặt cùng chiều với người thắng liên tiếp!\n\n` +
      `📌 <b>Cách kiểm tra:</b>\n` +
      `• Dùng lệnh <code>/daythang</code> để xem chuỗi thắng !\n` +
      `• Dùng lệnh <code>/daythua</code> để xem chuỗi thua !\n` +
      `• Đặt cùng chiều với người đang thắng chuỗi để "đu dây"\n\n` +
      `⚡ <b>Điều kiện:</b>\n` +
      `• Chỉ tính các cược Tài/Xỉu từ <b>10,000đ</b> trở lên\n` +
      `• Chuỗi thắng/thua được tính liên tiếp, reset khi đổi kết quả\n\n` +
      `🏆 Đú dây đúng chuỗi — ăn to cùng Haru88! https://t.me/TXCLHARU88`;
    await this.bot.sendMessage(chatId, msg, { parse_mode: "HTML" });
  }

  private parseAmountStr(s: string): number {
    const u = s.toUpperCase();
    const n = parseFloat(u);
    if (u.endsWith('B')) return n * 1_000_000_000;
    if (u.endsWith('M')) return n * 1_000_000;
    if (u.endsWith('K')) return n * 1_000;
    return n;
  }

  private async showEventTichLuyNap(chatId: number, userId: string) {
    if (!this.bot) return;
    const now = new Date();
    const EVENT_START = new Date("2026-06-01T00:00:01+07:00");
    const EVENT_START_STR = "2026-06-01";

    const milestones = [
      { nap: "50K",  cuoc: "1M",   gift: "20K" },
      { nap: "1M",   cuoc: "15M",  gift: "60K" },
      { nap: "5M",   cuoc: "50M",  gift: "170K" },
      { nap: "10M",  cuoc: "120M", gift: "300K" },
      { nap: "20M",  cuoc: "200M", gift: "600K" },
      { nap: "50M",  cuoc: "500M", gift: "1M" },
      { nap: "1B",   cuoc: "10B",  gift: "4M" },
      { nap: "2B",   cuoc: "20B",  gift: "7M" },
      { nap: "5B",   cuoc: "50B",  gift: "10M" },
    ];

    let napEvent = 0;
    let cuocEvent = 0;

    if (now >= EVENT_START) {
      try {
        napEvent = await storage.getDepositsSinceDate(userId, EVENT_START);
        cuocEvent = await storage.getBetsSinceDate(userId, EVENT_START_STR);
      } catch { /* ignore errors */ }
    }

    // Find current milestone reached (both nap and cuoc conditions met)
    let currentMilestone = 0;
    for (let i = 0; i < milestones.length; i++) {
      const m = milestones[i];
      if (napEvent >= this.parseAmountStr(m.nap) && cuocEvent >= this.parseAmountStr(m.cuoc)) {
        currentMilestone = i + 1;
      } else break;
    }

    // Progress to next milestone
    let progressText = "";
    const nextIdx = currentMilestone; // 0-based index of next milestone
    if (nextIdx < milestones.length) {
      const next = milestones[nextIdx];
      const napNeeded = Math.max(0, this.parseAmountStr(next.nap) - napEvent);
      const cuocNeeded = Math.max(0, this.parseAmountStr(next.cuoc) - cuocEvent);
      progressText =
        `📈 <b>Tiến độ mốc ${nextIdx + 1}:</b>\n` +
        `• Thiếu nạp: <b>${napNeeded > 0 ? napNeeded.toLocaleString('vi-VN') + "đ" : "✅ Đủ rồi"}</b>\n` +
        `• Thiếu cược: <b>${cuocNeeded > 0 ? cuocNeeded.toLocaleString('vi-VN') + "đ" : "✅ Đủ rồi"}</b>`;
    } else {
      progressText = `🏆 <b>Bạn đã đạt tất cả các mốc! Chúc mừng!</b>`;
    }

    const eventStarted = now >= EVENT_START;

    const caption =
      `🎯 <b>TÍCH LŨY NẠP, SĂN GIFTCODE</b>\n` +
      `⚡ Cơ chế: tính trực tiếp từ lịch sử kể từ ngày bắt đầu event, đạt mốc là nhận code ngay khi bấm kiểm tra.\n` +
      `🔁 Mỗi mốc chỉ nhận 1 lần.\n\n` +
      `📌 Mốc bắt đầu tính event: <b>2026-06-01 00:00:01</b>\n` +
      `📌 <b>Dữ liệu xét mốc</b> (phát sinh từ ngày bắt đầu):\n` +
      `• Nạp event: <b>${eventStarted ? napEvent.toLocaleString('vi-VN') + "đ" : "Chưa bắt đầu"}</b>\n` +
      `• Cược event: <b>${eventStarted ? cuocEvent.toLocaleString('vi-VN') + "đ" : "Chưa bắt đầu"}</b>\n\n` +
      `🏁 Mốc hiện tại đạt: <b>Mốc ${currentMilestone}</b>\n` +
      `${progressText}\n\n` +
      `💡 Khi đạt mốc mới, hãy vô <b>🧧 LÌ XÌ</b> kiểm tra hoặc dùng lệnh <code>/homqua</code> để kiểm tra!`;

    try {
      const photoBuffer = readFileSync(join(PUBLIC_DIR, 'haru88-tichluynap.png'));
      await this.bot.sendPhoto(chatId, photoBuffer, { caption, parse_mode: "HTML" });
    } catch {
      await this.bot.sendMessage(chatId, caption, { parse_mode: "HTML" });
    }
  }
}

export const telegramBotService = new TelegramBotService();
