import TelegramBot from "node-telegram-bot-api";
import { storage } from "../lib/storage";
import { getSettingNumber, getSetting } from "../lib/settings";
import crypto from "crypto";
import { readFileSync } from "fs";
import { join } from "path";

interface BettingSession {
  sessionId: number;
  bets: Map<string, BetInfo[]>;
  startTime: number;
  status: 'betting' | 'locked' | 'rolling' | 'completed';
  results?: DiceResult;
  md5Hash?: string;
  originalCode?: string;
}

interface BetInfo {
  userId: string;
  username?: string;
  betType: 'T' | 'X' | 'C' | 'L' | 'TC' | 'TL' | 'XC' | 'XL' | 'MC' | 'ML' | string; // Includes ddt_X, ddxx_X, D_X, and SB_X patterns
  amount: number;
  isAnonymous: boolean;
  timestamp: number;
  targetNumber?: number; // For ddt (3-18), ddxx (1-6), D (1-6), and SB (3-18) bets
}

interface DiceResult {
  dice1: number;
  dice2: number;
  dice3: number;
  total: number;
  isTai: boolean;
  isEven: boolean;
  md5Original: string;
}

interface BettingTotals {
  tai: number;
  xiu: number;
  chan: number;
  le: number;
  tc: number;
  tl: number;
  xc: number;
  xl: number;
  mc: number;
  ml: number;
  other: number;
}

interface JackpotInfo {
  amount: number;
  lastUpdate: number;
}

class TelegramBot2Service {
  private bot: TelegramBot | null = null;
  private currentSession: BettingSession | null = null;
  private countdownTimer: NodeJS.Timeout | null = null;
  private sessionCounter: number = 1;
  private gameHistory: Array<[string, string]> = []; // Stores recent results as [TaiXiu, ChanLe] pairs
  private MAIN_GROUP: number = -1003132451812;
  private HISTORY_GROUP: number = -1003078404908;
  private MD5_GROUP: number = -1002918062379;
  private dailyLuckyNumber: number = 0;
  private dailyLuckyNumberDate: string = '';
  private jackpot: JackpotInfo = { amount: 1000000, lastUpdate: Date.now() }; // Starting jackpot 1M VND
  private isGroupLocked: boolean = false;
  private isFirstSessionOfDay: boolean = true;
  private botUsername: string = '';
  private broadcastTimers: NodeJS.Timeout[] = [];

  // ========== MAIN BOT INTEGRATION METHODS ==========
  
  /**
   * Nhận cược từ bot chính (thêm vào session hiện tại)
   */
  async receiveBetFromMainBot(userId: string, betType: string, amount: number): Promise<boolean> {
    try {
      if (!this.currentSession || this.currentSession.status !== 'betting') {
        // If bot is initialized but no session exists, auto-start one now
        if (this.bot) {
          console.log(`⚠️ No active session - auto-starting new session for main bot bet`);
          this.startNewSession();
        }
        // If still no usable session (bot not ready), reject
        if (!this.currentSession || this.currentSession.status !== 'betting') {
          console.log(`❌ Cannot accept bet from main bot - bot not initialized yet`);
          return false;
        }
      }

      // Allow multiple bets per user - no check needed

      // Get user data for username
      const userData = await storage.getBotUser(userId);
      const username = userData?.username || userData?.firstName || 'Unknown';
      
      // Create bet info for anonymous betting (from main bot)
      const betInfo: BetInfo = {
        userId,
        username,
        betType,
        amount,
        isAnonymous: true, // Always anonymous when coming from main bot
        timestamp: Date.now()
      };
      
      // Add prediction target if it's a prediction bet
      if (betType.startsWith('ddt_') || betType.startsWith('ddxx_') || betType.startsWith('D_') || betType.startsWith('SB_')) {
        const targetValue = parseInt(betType.split('_')[1]);
        betInfo.targetNumber = targetValue;
      }
      
      // Check if this is the first bet across all users - if so, start countdown
      let totalBets = 0;
      for (const userBets of Array.from(this.currentSession.bets.values())) {
        totalBets += userBets.length;
      }
      const isFirstBet = totalBets === 0;
      
      // Add bet to user's array
      if (!this.currentSession.bets.has(userId)) {
        this.currentSession.bets.set(userId, []);
      }
      this.currentSession.bets.get(userId)!.push(betInfo);
      
      // Start countdown only on first bet
      if (isFirstBet) {
        console.log(`🎯 First bet placed in session #${this.currentSession.sessionId} from main bot - starting 45s countdown`);
        this.startCountdown();
      }
      
      // Send confirmation to group (show as anonymous)
      const betTypeShort = this.getBetTypeShort(betType);
      if (this.bot) {
        await this.bot.sendMessage(this.MAIN_GROUP, 
          `Đặt thành công phiên #${this.currentSession.sessionId}\n${betTypeShort}-${amount.toLocaleString('vi-VN')} {Ẩn Danh}`
        );
      }
      
      console.log(`✅ Received bet from main bot: User ${userId}, Type: ${betType}, Amount: ${amount}`);
      return true;
      
    } catch (error) {
      console.error('❌ Error receiving bet from main bot:', error);
      return false;
    }
  }

  /**
   * Gửi kết quả đến bot chính
   */
  async sendResultToMainBot(sessionId: number, results: DiceResult, winners: Array<{userId: string, betType: string, amount: number, winAmount: number}>, losers: Array<{userId: string, betType: string, amount: number}>): Promise<void> {
    try {
      // Import main bot service dynamically to avoid circular dependency
      const { telegramBotService } = await import('./telegramBot');
      
      // Send results to main bot for processing
      await telegramBotService.receiveResultFromBot2(sessionId, results, winners, losers);
      
      console.log(`📤 Sent results to main bot for session #${sessionId}: ${winners.length} winners, ${losers.length} losers`);
    } catch (error) {
      console.error('❌ Error sending results to main bot:', error);
    }
  }

  /**
   * Notify main bot about betting activity (enhanced version)
   */
  private async notifyMainBotEnhanced(userId: string, betType: string, amount: number, sessionId: number): Promise<void> {
    try {
      // Import main bot service dynamically to avoid circular dependency
      const { telegramBotService } = await import('./telegramBot');
      
      // Notify main bot about the bet for tracking
      await telegramBotService.receiveBetFromBot2(userId, betType, amount, sessionId);
      
      // Get updated balance
      const userData = await storage.getBotUser(userId);
      const newBalance = userData ? parseFloat(userData.balance || "0") : 0;
      
      // Send notification to main bot user using the same format as when betting from main bot
      const betTypeDisplay = this.getBetTypeDisplay(betType);
      await telegramBotService.sendMessage(userId, 
        `✅ ĐẶT CƯỢC THÀNH CÔNG!\n\n` +
        `🎯 Loại cược: ${betTypeDisplay}\n` +
        `💰 Số tiền: ${amount.toLocaleString('vi-VN')}đ\n` +
        `💎 Số dư còn lại: ${newBalance.toLocaleString('vi-VN')}đ\n\n` +
        `⏳ Chờ kết quả quay số...`
      );
      
    } catch (error) {
      console.error('Error notifying main bot (enhanced):', error);
    }
  }

  /**
   * Set dice results from admin command (from main bot)
   */
  async setDiceResults(diceResults: number[]): Promise<void> {
    try {
      if (!this.currentSession || this.currentSession.status !== 'betting') {
        throw new Error('Không có phiên cược nào đang hoạt động');
      }

      if (diceResults.length !== 3 || diceResults.some(d => d < 1 || d > 6)) {
        throw new Error('Kết quả xúc xắc không hợp lệ (phải là 3 số từ 1-6)');
      }

      // Set predetermined results
      const [dice1, dice2, dice3] = diceResults;
      const total = dice1 + dice2 + dice3;
      
      this.currentSession.results = {
        dice1,
        dice2,
        dice3,
        total,
        isTai: total >= 11,
        isEven: total % 2 === 0,
        md5Original: this.currentSession.originalCode || ''
      };
      
      // End betting phase immediately and process results
      if (this.countdownTimer) {
        clearInterval(this.countdownTimer);
        this.countdownTimer = null;
      }
      
      // Lock chat and process results
      this.isGroupLocked = true;
      await this.lockGroupChat(true);
      
      await this.bot!.sendMessage(this.MAIN_GROUP,
        `🎯 <b>ADMIN ĐÃ THIẾT LẬP KẾT QUẢ PHIÊN #${this.currentSession.sessionId}</b>\n\n` +
        `🎲 Kết quả: ${dice1} ${dice2} ${dice3}\n` +
        `📊 Tổng: ${total} (${total >= 11 ? 'TÀI' : 'XỈU'})\n\n` +
        `💰 Đang xử lý thanh toán...`,
        { parse_mode: 'HTML' }
      );
      
      // Process results immediately
      await this.processResults();
      
      console.log(`✅ Admin set dice results: ${diceResults.join(', ')} for session #${this.currentSession.sessionId}`);
      
    } catch (error) {
      console.error('Error setting dice results:', error);
      throw error;
    }
  }

  // ========== END MAIN BOT INTEGRATION METHODS ==========

  async initialize(botToken: string) {
    try {
      // Clean shutdown of existing bot
      if (this.bot) {
        console.log("🔄 Shutting down existing bot2 instance...");
        try { await this.bot.close(); } catch (_) {}
        this.bot = null;
        // Wait for Telegram to release the long-poll connection (up to 30s timeout)
        await new Promise(resolve => setTimeout(resolve, 3000));
      }

      // Create bot2 with proper error handling
      this.bot = new TelegramBot(botToken, { 
        polling: {
          interval: 1000,
          autoStart: false,
          params: {
            timeout: 30
          }
        }
      });
      
      // Set up polling error handler
      this.bot.on('polling_error', (error: any) => {
        const msg: string = error?.message ?? '';
        // 401 Unauthorized — token invalid, stop immediately
        if (msg.includes('401') || error?.response?.body?.error_code === 401) {
          console.error('❌ Bot2 got 401 Unauthorized — invalid token. Stopping polling.');
          this.bot?.stopPolling().catch(() => {});
          return;
        }
        console.error('⚠️ Bot2 polling error:', msg || error);
        // On 409 Conflict, retry after Telegram's long-poll timeout (~30s)
        if (error?.code === 'ETELEGRAM' && (error?.response?.body?.error_code === 409 || msg.includes('409'))) {
          if (!(this as any)._retrying409) {
            (this as any)._retrying409 = true;
            console.warn('Bot2 got 409 Conflict — will retry polling in 35s');
            setTimeout(async () => {
              (this as any)._retrying409 = false;
              if (!this.bot) return;
              try {
                await this.bot.stopPolling();
                await new Promise(r => setTimeout(r, 1000));
                await this.bot.startPolling();
                console.log('✅ Bot2 polling restarted after 409');
              } catch (e) {
                console.error('Failed to restart Bot2 polling after 409:', e);
              }
            }, 35_000);
          }
        }
      });
      
      // Clear any existing webhook and drop pending updates
      try {
        await (this.bot as any).deleteWebHook({ drop_pending_updates: true });
        console.log("🧹 Bot2: Cleared existing webhook and pending updates");
      } catch (error) {
        console.warn("Bot2: Warning clearing webhook:", error);
      }

      // Fetch bot username for deeplink generation
      try {
        const me = await this.bot.getMe();
        this.botUsername = me.username || '';
        console.log(`🤖 Bot2 username: @${this.botUsername}`);
      } catch {
        this.botUsername = '';
      }

      this.setupHandlers();
      
      // Start polling
      await this.bot.startPolling();
      
      // Initialize daily lucky number
      await this.generateDailyLuckyNumber();
      
      // Start first betting session
      this.startNewSession();

      // Start gift code broadcast scheduler (if enabled)
      this.startGiftBroadcastScheduler().catch(err =>
        console.error('[GiftBroadcast] Scheduler start error:', err)
      );
      
      console.log("✅ Telegram Bot2 (Tài Xỉu Room) initialized successfully");
    } catch (error) {
      console.error("❌ Failed to initialize Bot2:", error);
      this.bot = null;
      throw error;
    }
  }

  private setupHandlers() {
    if (!this.bot) return;

    // Handle /start deeplinks for history/md5 — sent by bot when user clicks group callback button
    this.bot.onText(/^\/start(?: (.+))?$/, async (msg: TelegramBot.Message, match) => {
      const chatType = msg.chat.type;
      if (chatType !== 'private') return; // Only handle in private chat
      const param = match?.[1]?.trim() || '';
      if (param !== 'view_hist' && param !== 'view_md5') return;
      const base = this.getPublicUrl();
      const isHist = param === 'view_hist';
      const webUrl = isHist ? `${base}/api/bot2/history` : `${base}/api/bot2/md5`;
      const label = isHist ? "📜 Xem Lịch Sử Phiên" : "🔐 Xem Lịch Sử MD5";
      const intro = isHist ? "📜 <b>Lịch sử phiên</b>" : "🔐 <b>Lịch sử MD5</b>";
      await this.bot!.sendMessage(msg.chat.id, `${intro}\nNhấn nút bên dưới để xem:`, {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [[
            { text: label, web_app: { url: webUrl } }
          ]]
        }
      });
    });

    // Handle game instruction commands
    this.bot.onText(/\/dudoanxucxac|dự đoán xúc xắc/i, async (msg: TelegramBot.Message) => {
      if (msg.chat.id !== this.MAIN_GROUP) return;
      
      await this.bot!.sendMessage(this.MAIN_GROUP,
        `🎲 GAME ĐOÁN XÚC XẮC TẠI ROOM\n\n` +
        `Chiến thắng khi 1 trong 3 viên xúc xắc có kết quả trùng số bạn chọn.\n` +
        `• Trùng 1 viên: 1 ĂN 2\n` +
        `• Trùng 2 viên: 1 ĂN 3\n` +
        `• Trùng 3 viên: 1 ĂN 4\n\n` +
        `Lệnh cược: D[số chọn 1-6] [tiền chơi]\n` +
        `VD: D6 20000`,
        { reply_to_message_id: msg.message_id }
      );
    });

    this.bot.onText(/\/dudoantong|dự đoán tổng/i, async (msg: TelegramBot.Message) => {
      if (msg.chat.id !== this.MAIN_GROUP) return;
      
      await this.bot!.sendMessage(this.MAIN_GROUP,
        `🎯 GAME ĐOÁN TỔNG 3 XÚC XẮC TẠI ROOM\n\n` +
        `Chiến thắng khi tổng 3 viên xúc xắc là kết quả trùng số bạn chọn.\n` +
        `👉 Tỷ lệ trả thưởng:\n` +
        `• 4, 17 | 40\n` +
        `• 5, 16 | 18\n` +
        `• 6, 15 | 12\n` +
        `• 7, 14 | 8\n` +
        `• 8, 13 | 6\n` +
        `• 9, 12 | 5\n` +
        `• 10, 11 | 5\n\n` +
        `Lệnh cược: SB[số chọn] [tiền chơi]\n` +
        `VD: SB11 20000`,
        { reply_to_message_id: msg.message_id }
      );
    });

    this.bot.onText(/\/dudoanxien|dự đoán xiên/i, async (msg: TelegramBot.Message) => {
      if (msg.chat.id !== this.MAIN_GROUP) return;
      
      await this.bot!.sendMessage(this.MAIN_GROUP,
        `🎲 ĐOÁN XIÊN XÚC XẮC ROOM 🎲\n\n` +
        `Nội dung | Tổng điểm 3 XX Room | Tỷ lệ ăn\n` +
        `TL (Tài Lẻ) | 11,13,15,17 | x2.6\n` +
        `TC (Tài Chẵn) | 12,14,16,18 | x3.3\n` +
        `XL (Xỉu Lẻ) | 3,5,7,9 | x3.3\n` +
        `XC (Xỉu Chẵn) | 4,6,8,10 | x2.6\n\n` +
        `VD: TC 10000`,
        { reply_to_message_id: msg.message_id }
      );
    });

    this.bot.onText(/\/xocdia|xóc đĩa/i, async (msg: TelegramBot.Message) => {
      if (msg.chat.id !== this.MAIN_GROUP) return;
      
      await this.bot!.sendMessage(this.MAIN_GROUP,
        `🥏 XÓC ĐĨA ROOM 🥏\n\n` +
        `Đoán kết quả 4 đồng xu trong đĩa:\n` +
        `🔴 4do [tiền] - 4 đỏ (x7.5)\n` +
        `⚪ 4trang [tiền] - 4 trắng (x7.5)\n` +
        `🔴🔴🔴⚪ 3do1tr [tiền] - 3 đỏ 1 trắng (x2.3)\n` +
        `🔴⚪⚪⚪ 1do3tr [tiền] - 1 đỏ 3 trắng (x2.3)\n\n` +
        `VD: 4do 20000`,
        { reply_to_message_id: msg.message_id }
      );
    });

    this.bot.onText(/\/rongho|rồng hổ/i, async (msg: TelegramBot.Message) => {
      if (msg.chat.id !== this.MAIN_GROUP) return;
      
      await this.bot!.sendMessage(this.MAIN_GROUP,
        `🐉🐅 RỒNG HỔ ROOM 🐉🐅\n\n` +
        `So sánh 2 lá bài: Rồng vs Hổ\n` +
        `🃏 Lá cao hơn thắng, bằng nhau thì hòa (hoàn tiền)\n` +
        `📈 Tỷ lệ thắng: x1.95\n\n` +
        `🐉 R [tiền] - Đặt RỒNG\n` +
        `🐅 H [tiền] - Đặt HỔ\n\n` +
        `VD: R 10000 hoặc H 5000`,
        { reply_to_message_id: msg.message_id }
      );
    });

    // Handle lucky number reward claim
    this.bot.onText(/\/nhanthuong/, async (msg: TelegramBot.Message) => {
      if (msg.chat.id !== this.MAIN_GROUP) return;
      
      const user = msg.from;
      if (!user) return;
      
      try {
        const userId = user.id.toString();
        const lastTwoDigits = parseInt(userId.slice(-2));
        
        if (lastTwoDigits === this.dailyLuckyNumber) {
          // Check if user already claimed today using database
          const today = new Date().toISOString().split('T')[0];
          
          // Check existing claim in database
          const existingClaim = await storage.hasUserClaimedToday(userId, today);
          
          if (existingClaim) {
            await this.bot!.sendMessage(this.MAIN_GROUP, 
              `❌ Bạn đã nhận thưởng số may mắn hôm nay rồi!`,
              { reply_to_message_id: msg.message_id }
            );
            return;
          }
          
          // Award 5000 VND to user in main bot
          await this.awardLuckyNumber(userId, 5000);
          
          // Record the claim in database
          await storage.createLuckyNumberClaim({
            userId,
            date: today,
            luckyNumber: this.dailyLuckyNumber,
            rewardAmount: "5000"
          });
          
          await this.bot!.sendMessage(this.MAIN_GROUP, 
            `🍀 Chúc mừng! Bạn đã nhận được 5.000 VND từ số may mắn hôm nay!`,
            { reply_to_message_id: msg.message_id }
          );
        } else {
          await this.bot!.sendMessage(this.MAIN_GROUP, 
            `❌ Số cuối ID của bạn (${lastTwoDigits}) không trùng với số may mắn (${this.dailyLuckyNumber})`,
            { reply_to_message_id: msg.message_id }
          );
        }
      } catch (error) {
        console.error('Error processing lucky number claim:', error);
        await this.bot!.sendMessage(this.MAIN_GROUP, 
          `❌ Có lỗi xảy ra khi xử lý nhận thưởng. Vui lòng thử lại sau.`,
          { reply_to_message_id: msg.message_id }
        );
      }
    });

    // Handle /ddt command: Predict total dice sum (3-18)
    this.bot.onText(/\/ddt\s+(\d+)\s+(\d+|max)/i, async (msg: TelegramBot.Message, match) => {
      if (msg.chat.id !== this.MAIN_GROUP) return;
      
      const user = msg.from;
      if (!user || !match) return;
      
      const targetTotal = parseInt(match[1]);
      const amountStr = match[2].toLowerCase();
      
      // Validate target total
      if (targetTotal < 3 || targetTotal > 18) {
        await this.bot!.sendMessage(this.MAIN_GROUP, 
          "❌ Tổng điểm phải từ 3 đến 18",
          { reply_to_message_id: msg.message_id }
        );
        return;
      }
      
      await this.processPredictionBet(user, 'ddt', targetTotal, amountStr, msg.message_id);
    });

    // Handle /ddxx command: Predict specific dice number (1-6)
    this.bot.onText(/\/ddxx\s+(\d+)\s+(\d+|max)/i, async (msg: TelegramBot.Message, match) => {
      if (msg.chat.id !== this.MAIN_GROUP) return;
      
      const user = msg.from;
      if (!user || !match) return;
      
      const targetNumber = parseInt(match[1]);
      const amountStr = match[2].toLowerCase();
      
      // Validate target number
      if (targetNumber < 1 || targetNumber > 6) {
        await this.bot!.sendMessage(this.MAIN_GROUP, 
          "❌ Số xúc xắc phải từ 1 đến 6",
          { reply_to_message_id: msg.message_id }
        );
        return;
      }
      
      await this.processPredictionBet(user, 'ddxx', targetNumber, amountStr, msg.message_id);
    });

    // Handle D[1-6] command: New dice prediction game with match-based payouts
    this.bot.onText(/^D([1-6])\s+(\d+|max)$/i, async (msg: TelegramBot.Message, match) => {
      if (msg.chat.id !== this.MAIN_GROUP) return;
      
      const user = msg.from;
      if (!user || !match) return;
      
      const targetNumber = parseInt(match[1]);
      const amountStr = match[2].toLowerCase();
      
      await this.processPredictionBet(user, 'D', targetNumber, amountStr, msg.message_id);
    });

    // Handle SB[number] command: Total prediction with specific payout ratios
    this.bot.onText(/^SB(\d+)\s+(\d+|max)$/i, async (msg: TelegramBot.Message, match) => {
      if (msg.chat.id !== this.MAIN_GROUP) return;
      
      const user = msg.from;
      if (!user || !match) return;
      
      const targetTotal = parseInt(match[1]);
      const amountStr = match[2].toLowerCase();
      
      // Validate target total (3-18)
      if (targetTotal < 3 || targetTotal > 18) {
        await this.bot!.sendMessage(this.MAIN_GROUP, 
          "❌ Tổng điểm phải từ 3 đến 18",
          { reply_to_message_id: msg.message_id }
        );
        return;
      }
      
      await this.processPredictionBet(user, 'SB', targetTotal, amountStr, msg.message_id);
    });

    // Handle cross prediction betting: CROSS [TC/TL/XL/XC] [amount] for cross prediction game
    this.bot.onText(/^CROSS\s+(TC|TL|XL|XC)\s+(\d+|max)$/i, async (msg: TelegramBot.Message, match) => {
      if (msg.chat.id !== this.MAIN_GROUP) return;
      
      const user = msg.from;
      if (!user || !match) return;
      
      const betTypeRaw = match[1].toUpperCase();
      const amountStr = match[2].toLowerCase();
      
      await this.processCrossPredictionBet(user, betTypeRaw as 'TC' | 'TL' | 'XL' | 'XC', amountStr, msg.message_id);
    });

    // Handle Xóc Đĩa betting: 4do/4trang/3do1tr/1do3tr [amount]
    this.bot.onText(/^(4do|4trang|3do1tr|1do3tr)\s+(\d+|max)$/i, async (msg: TelegramBot.Message, match) => {
      if (msg.chat.id !== this.MAIN_GROUP) return;
      
      const user = msg.from;
      if (!user || !match) return;
      
      const betTypeRaw = match[1].toLowerCase();
      const amountStr = match[2].toLowerCase();
      
      await this.processXocDiaBet(user, betTypeRaw as '4do' | '4trang' | '3do1tr' | '1do3tr', amountStr, msg.message_id);
    });

    // ── Nạp/Rút keyword auto-reply in group ──────────────────────────────────
    // Khi ai đó nói "nạp" hoặc "rút" trong nhóm, bot tự động reply với nút deeplink
    const napRutCooldown = new Map<string, number>(); // userId → last replied timestamp
    this.bot.on('message', async (msg: TelegramBot.Message) => {
      if (msg.chat.id !== this.MAIN_GROUP) return;
      if (!msg.text || msg.text.startsWith('/')) return;

      const text = msg.text.toLowerCase();
      const wantsDeposit = /\bnạp\b|\bnap\b/.test(text);
      const wantsWithdraw = /\brút\b|\brut\b/.test(text);
      if (!wantsDeposit && !wantsWithdraw) return;

      // Cooldown 60s per user to avoid spam
      const userId = String(msg.from?.id ?? 0);
      const now = Date.now();
      if ((napRutCooldown.get(userId) ?? 0) + 60_000 > now) return;
      napRutCooldown.set(userId, now);

      // Get main bot username from settings
      const mainBotUsername = await getSetting('bot_username').catch(() => '') || 'Haru88Bot';

      const buttons: TelegramBot.InlineKeyboardButton[] = [];
      if (wantsDeposit) {
        buttons.push({ text: '💳 Nạp tiền ngay', url: `https://t.me/${mainBotUsername}?start=nap_tien` });
      }
      if (wantsWithdraw) {
        buttons.push({ text: '💸 Rút tiền ngay', url: `https://t.me/${mainBotUsername}?start=rut_tien` });
      }

      const replyText =
        wantsDeposit && wantsWithdraw
          ? `💳💸 <b>Nạp / Rút tiền</b>\n\nNhấn nút bên dưới để mở menu ngay trong bot!`
          : wantsDeposit
          ? `💳 <b>Nạp tiền nhanh!</b>\n\nNhấn nút để vào menu nạp tiền ngay!`
          : `💸 <b>Rút tiền nhanh!</b>\n\nNhấn nút để vào menu rút tiền ngay!`;

      try {
        await this.bot!.sendMessage(this.MAIN_GROUP, replyText, {
          parse_mode: 'HTML',
          reply_to_message_id: msg.message_id,
          reply_markup: { inline_keyboard: [buttons] },
        });
      } catch (err) {
        console.error('[NapRutReply] Error:', err);
      }
    });

    // ── Gift code reveal callback ─────────────────────────────────────────────
    this.bot.on('callback_query', async (query: TelegramBot.CallbackQuery) => {
      if (!query.data?.startsWith('reveal_code_')) return;
      const code = query.data.replace('reveal_code_', '');
      const userId = query.from.id;
      try {
        // Gửi tin nhắn riêng để user có thể copy code
        try {
          await this.bot!.sendMessage(userId,
            `🎁 <b>MÃ QUÀ TẶNG HARU88</b>\n\n` +
            `💰 Code của bạn:\n<code>/code ${code}</code>\n\n` +
            `📱 Nhấn vào dòng trên để sao chép, sau đó gửi vào chat riêng với bot chính để nhận thưởng!\n\n` +
            `⚠️ Mỗi code chỉ dùng được <b>1 lần</b> — nhanh tay nhé!`,
            { parse_mode: 'HTML' }
          );
          await this.bot!.answerCallbackQuery(query.id, {
            text: `✅ Đã gửi code vào tin nhắn riêng của bạn!`,
            show_alert: false,
          });
        } catch {
          // User chưa start bot — fallback hiển thị alert
          await this.bot!.answerCallbackQuery(query.id, {
            text: `🎁 Code: ${code}\n\nVào bot chính gõ: /code ${code}`,
            show_alert: true,
          });
        }
      } catch (err) {
        console.error('[GiftBroadcast] reveal_code error:', err);
      }
    });

    // Handle Rồng Hổ betting: R/H [amount]
    this.bot.onText(/^([RH])\s+(\d+|max)$/i, async (msg: TelegramBot.Message, match) => {
      if (msg.chat.id !== this.MAIN_GROUP) return;
      
      const user = msg.from;
      if (!user || !match) return;
      
      const betTypeRaw = match[1].toUpperCase();
      const amountStr = match[2].toLowerCase();
      
      await this.processRongHoBet(user, betTypeRaw as 'R' | 'H', amountStr, msg.message_id);
    });

    // ── ADMIN: /band — kick/ban a user from the group ────────────────────────
    this.bot.onText(/^\/band(?:@\w+)?(?:\s+(\d+))?$/i, async (msg: TelegramBot.Message, match) => {
      if (msg.chat.id !== this.MAIN_GROUP) return;
      const fromUser = msg.from;
      if (!fromUser) return;

      if (!await this.isGroupAdmin(this.MAIN_GROUP, fromUser.id)) {
        await this.bot!.sendMessage(this.MAIN_GROUP, '❌ Chỉ admin mới được dùng lệnh này!', { reply_to_message_id: msg.message_id });
        return;
      }

      const { userId: targetId, displayName } = this.getTargetFromMsg(msg, match?.[1]);
      if (!targetId) {
        await this.bot!.sendMessage(this.MAIN_GROUP,
          '❌ Vui lòng reply tin nhắn người cần ban hoặc dùng /band [user_id]',
          { reply_to_message_id: msg.message_id }
        );
        return;
      }

      if (await this.isGroupAdmin(this.MAIN_GROUP, targetId)) {
        await this.bot!.sendMessage(this.MAIN_GROUP, '❌ Không thể ban admin!', { reply_to_message_id: msg.message_id });
        return;
      }

      try {
        await this.bot!.banChatMember(this.MAIN_GROUP, targetId);
        await this.bot!.sendMessage(this.MAIN_GROUP,
          `🔨 Đã ban <b>${displayName}</b> (<code>${targetId}</code>) khỏi nhóm!`,
          { parse_mode: 'HTML' }
        );
      } catch (e: any) {
        await this.bot!.sendMessage(this.MAIN_GROUP, `❌ Không thể ban: ${e?.message ?? e}`, { reply_to_message_id: msg.message_id });
      }
    });

    // ── ADMIN: /cam [user_id] <thời_gian> — cấm chat (reply hoặc kèm id) ────
    this.bot.onText(/^\/cam(?:@\w+)?(.*)/i, async (msg: TelegramBot.Message, match) => {
      if (msg.chat.id !== this.MAIN_GROUP) return;
      const fromUser = msg.from;
      if (!fromUser) return;

      if (!await this.isGroupAdmin(this.MAIN_GROUP, fromUser.id)) {
        await this.bot!.sendMessage(this.MAIN_GROUP, '❌ Chỉ admin mới được dùng lệnh này!', { reply_to_message_id: msg.message_id });
        return;
      }

      const parts = (match?.[1] ?? '').trim().split(/\s+/).filter(Boolean);
      let targetId: number | null = null;
      let displayName = '';
      let timeStr = '';

      if (msg.reply_to_message?.from) {
        const u = msg.reply_to_message.from;
        targetId = u.id;
        displayName = u.first_name || u.username || String(u.id);
        timeStr = parts[0] ?? '';
      } else if (parts.length >= 2) {
        targetId = parseInt(parts[0]);
        displayName = parts[0];
        timeStr = parts[1];
      }

      if (!targetId || !timeStr) {
        await this.bot!.sendMessage(this.MAIN_GROUP,
          '❌ Cú pháp:\n' +
          '• Reply + <code>/cam 1p</code> hoặc <code>/cam 1t</code> hoặc <code>/cam 1n</code>\n' +
          '• <code>/cam [user_id] [thời_gian]</code>\n\n' +
          '⏱ 1p = 1 phút | 1t = 1 tiếng | 1n = 1 ngày',
          { parse_mode: 'HTML', reply_to_message_id: msg.message_id }
        );
        return;
      }

      const seconds = this.parseAdminTime(timeStr);
      if (!seconds) {
        await this.bot!.sendMessage(this.MAIN_GROUP,
          '❌ Thời gian không hợp lệ! Dùng: <code>1p</code> (phút) | <code>1t</code> (tiếng) | <code>1n</code> (ngày)',
          { parse_mode: 'HTML', reply_to_message_id: msg.message_id }
        );
        return;
      }

      if (await this.isGroupAdmin(this.MAIN_GROUP, targetId)) {
        await this.bot!.sendMessage(this.MAIN_GROUP, '❌ Không thể cấm admin!', { reply_to_message_id: msg.message_id });
        return;
      }

      const until = Math.floor(Date.now() / 1000) + seconds;
      try {
        // node-telegram-bot-api v0.66 does NOT auto-stringify 'permissions' —
        // must pass it as a JSON string so Telegram Bot API v6+ accepts it
        await this.bot!.restrictChatMember(this.MAIN_GROUP, targetId, {
          permissions: JSON.stringify({
            can_send_messages: false,
            can_send_audios: false,
            can_send_documents: false,
            can_send_photos: false,
            can_send_videos: false,
            can_send_video_notes: false,
            can_send_voice_notes: false,
            can_send_polls: false,
            can_send_other_messages: false,
            can_add_web_page_previews: false,
          }),
          until_date: until,
        } as any);
        await this.bot!.sendMessage(this.MAIN_GROUP,
          `🔇 Đã cấm chat <b>${displayName}</b> trong <b>${this.formatAdminDuration(seconds)}</b>!`,
          { parse_mode: 'HTML' }
        );
      } catch (e: any) {
        await this.bot!.sendMessage(this.MAIN_GROUP, `❌ Không thể cấm: ${e?.message ?? e}`, { reply_to_message_id: msg.message_id });
      }
    });

    // ── ADMIN: /mo [user_id] — mở ban/cấm (reply hoặc kèm id) ───────────────
    this.bot.onText(/^\/mo(?:@\w+)?(?:\s+(\d+))?$/i, async (msg: TelegramBot.Message, match) => {
      if (msg.chat.id !== this.MAIN_GROUP) return;
      const fromUser = msg.from;
      if (!fromUser) return;

      if (!await this.isGroupAdmin(this.MAIN_GROUP, fromUser.id)) {
        await this.bot!.sendMessage(this.MAIN_GROUP, '❌ Chỉ admin mới được dùng lệnh này!', { reply_to_message_id: msg.message_id });
        return;
      }

      const { userId: targetId, displayName } = this.getTargetFromMsg(msg, match?.[1]);
      if (!targetId) {
        await this.bot!.sendMessage(this.MAIN_GROUP,
          '❌ Vui lòng reply tin nhắn người cần mở hoặc dùng /mo [user_id]',
          { reply_to_message_id: msg.message_id }
        );
        return;
      }

      try {
        // Unban first (in case they were banned)
        await this.bot!.unbanChatMember(this.MAIN_GROUP, targetId, { only_if_banned: true } as any);
        // Restore all permissions — must JSON.stringify 'permissions' for Bot API v6+
        await this.bot!.restrictChatMember(this.MAIN_GROUP, targetId, {
          permissions: JSON.stringify({
            can_send_messages: true,
            can_send_audios: true,
            can_send_documents: true,
            can_send_photos: true,
            can_send_videos: true,
            can_send_video_notes: true,
            can_send_voice_notes: true,
            can_send_polls: true,
            can_send_other_messages: true,
            can_add_web_page_previews: true,
          }),
        } as any);
        await this.bot!.sendMessage(this.MAIN_GROUP,
          `✅ Đã mở tất cả hạn chế cho <b>${displayName}</b> (<code>${targetId}</code>)!`,
          { parse_mode: 'HTML' }
        );
      } catch (e: any) {
        await this.bot!.sendMessage(this.MAIN_GROUP, `❌ Lỗi: ${e?.message ?? e}`, { reply_to_message_id: msg.message_id });
      }
    });

    // Handle betting messages: T/X/C/L [amount] or TT/XX/CC/LL [amount]
    this.bot.on('message', async (msg: TelegramBot.Message) => {
      if (msg.chat?.id !== this.MAIN_GROUP) return;
      if (!msg.text || msg.text.startsWith('/')) return;
      if (this.isGroupLocked) return; // Ignore messages when chat is locked
      
      const user = msg.from;
      if (!user) return;
      
      // Parse betting command (TC/TL/XL/XC are back for combination bets, CROSS TC/TL/XL/XC for cross prediction)
      const betMatch = msg.text.match(/^(T|X|C|L|TT|XX|CC|LL|TC|TL|XC|XL|MC|ML)\s+(\d+|max)$/i);
      if (!betMatch) return;
      
      const betTypeRaw = betMatch[1].toUpperCase();
      const amountStr = betMatch[2].toLowerCase();
      
      try {
        // Get user data
        const userData = await storage.getBotUser(user.id.toString());
        if (!userData) {
          await this.bot!.sendMessage(this.MAIN_GROUP,
            `❌ Bạn chưa có tài khoản! Nhắn tin cho @Haru88gamebot gõ /start để đăng ký.`,
            { reply_to_message_id: msg.message_id }
          );
          return;
        }
        
        // Determine bet amount
        let amount: number;
        const currentBalance = parseFloat(userData.balance || "0");
        {
          const minBet2 = await getSettingNumber('min_bet', 1000);
          const maxBet2 = await getSettingNumber('max_bet', 1000000);
          if (amountStr === 'max') {
            amount = Math.min(currentBalance, maxBet2);
          } else {
            amount = parseInt(amountStr);
          }
          if (amount < minBet2) {
            await this.bot!.sendMessage(this.MAIN_GROUP, 
              `❌ Tiền cược tối thiểu là ${minBet2.toLocaleString('vi-VN')} VND`,
              { reply_to_message_id: msg.message_id }
            );
            return;
          }
          if (amount > maxBet2) {
            await this.bot!.sendMessage(this.MAIN_GROUP, 
              `❌ Tiền cược tối đa là ${maxBet2.toLocaleString('vi-VN')} VND`,
              { reply_to_message_id: msg.message_id }
            );
            return;
          }
        }
        
        if (amount > currentBalance) {
          await this.bot!.sendMessage(this.MAIN_GROUP,
            `❌ SỐ DƯ KHÔNG ĐỦ!\n💎 Số dư hiện tại: ${currentBalance.toLocaleString('vi-VN')}đ\n💰 Cần: ${amount.toLocaleString('vi-VN')}đ\n⚠️ Thiếu: ${(amount - currentBalance).toLocaleString('vi-VN')}đ`,
            { reply_to_message_id: msg.message_id }
          );
          return;
        }
        
        // Process bet
        await this.processBet(user, betTypeRaw, amount, msg.message_id);
        
      } catch (error) {
        console.error('Error processing bet:', error);
        await this.bot!.sendMessage(this.MAIN_GROUP, 
          "❌ Lỗi xử lý cược. Vui lòng thử lại.",
          { reply_to_message_id: msg.message_id }
        );
      }
    });

    // Handle callback queries (inline buttons)
    this.bot.on("callback_query", async (query: TelegramBot.CallbackQuery) => {
      if (!query.data || !query.message) return;
      
      const chatId = query.message.chat.id;
      const userId = query.from.id.toString();
      const data = query.data;

      try {
        if (data === "lich_su_phien") {
          await this.bot!.answerCallbackQuery(query.id);
          const base = this.getPublicUrl();
          await this.bot!.sendMessage(chatId,
            `📜 <b>Lịch sử phiên</b>\nNhấn nút bên dưới để xem:`,
            {
              parse_mode: "HTML",
              reply_markup: { inline_keyboard: [[{ text: "📜 Xem Lịch Sử Phiên", web_app: { url: `${base}/api/bot2/history` } }]] }
            }
          );
        } else if (data === "lich_su_md5") {
          await this.bot!.answerCallbackQuery(query.id);
          const base = this.getPublicUrl();
          await this.bot!.sendMessage(chatId,
            `🔐 <b>Lịch sử MD5</b>\nNhấn nút bên dưới để xem:`,
            {
              parse_mode: "HTML",
              reply_markup: { inline_keyboard: [[{ text: "🔐 Xem Lịch Sử MD5", web_app: { url: `${base}/api/bot2/md5` } }]] }
            }
          );
        } else if (data === "nap_tien_bot2") {
          await this.bot!.answerCallbackQuery(query.id, {
            url: "https://t.me/Haru88gamebot?start=nap_tien"
          });
        } else if (data === "check_sd_bot2") {
          // Show balance as toast notification without sending any message
          try {
            const userData = await storage.getBotUser(userId);
            const bal = parseFloat(userData?.balance || "0");
            await this.bot!.answerCallbackQuery(query.id, {
              text: `💎 Số dư: ${bal.toLocaleString('vi-VN')}đ`,
              show_alert: false
            });
          } catch {
            await this.bot!.answerCallbackQuery(query.id, { text: "❌ Không thể lấy số dư!", show_alert: false });
          }
        } else if (data === "open_hist_web" || data === "open_md5_web") {
          // Use t.me deeplink via answerCallbackQuery.url:
          // Telegram opens the bot in private chat WITHOUT any "Open Link" dialog.
          // The /start handler then responds with a web_app button that opens directly.
          const isHist = data === "open_hist_web";
          const startParam = isHist ? "view_hist" : "view_md5";
          if (this.botUsername) {
            // Navigate user to bot's private chat — Telegram handles t.me links natively (no dialog)
            await this.bot!.answerCallbackQuery(query.id, {
              url: `https://t.me/${this.botUsername}?start=${startParam}`
            });
          } else {
            // Fallback: send private message with web_app button directly
            const base = this.getPublicUrl();
            const webUrl = isHist ? `${base}/api/bot2/history` : `${base}/api/bot2/md5`;
            const label = isHist ? "📜 Xem Lịch Sử Phiên" : "🔐 Xem Lịch Sử MD5";
            const intro = isHist ? "📜 <b>Lịch sử phiên</b>" : "🔐 <b>Lịch sử MD5</b>";
            await this.bot!.answerCallbackQuery(query.id);
            try {
              await this.bot!.sendMessage(query.from.id, `${intro}\nNhấn nút bên dưới để xem:`, {
                parse_mode: "HTML",
                reply_markup: { inline_keyboard: [[{ text: label, web_app: { url: webUrl } }]] }
              });
            } catch {
              const base2 = this.getPublicUrl();
              await this.bot!.sendMessage(chatId,
                `${intro}: <a href="${isHist ? base2 + '/api/bot2/history' : base2 + '/api/bot2/md5'}">Nhấn vào đây</a>`,
                { parse_mode: "HTML" }
              );
            }
          }
        } else {
          await this.bot!.answerCallbackQuery(query.id);
        }
      } catch (error) {
        console.error("Bot2 callback query error:", error);
        try { await this.bot!.answerCallbackQuery(query.id, { text: "❌ Có lỗi xảy ra!" }); } catch {}
      }
    });

    console.log("🤖 Bot2 handlers setup complete");
  }

  private async processPredictionBet(user: TelegramBot.User, betCategory: 'ddt' | 'ddxx' | 'D' | 'SB', targetValue: number, amountStr: string, messageId: number) {
    if (!this.currentSession || this.currentSession.status !== 'betting') {
      await this.bot!.sendMessage(this.MAIN_GROUP, 
        "❌ Hiện tại không thể đặt cược",
        { reply_to_message_id: messageId }
      );
      return;
    }

    const userId = user.id.toString();
    
    // Allow multiple bets per user - no restriction needed

    try {
      // Get user data
      const userData = await storage.getBotUser(userId);
      if (!userData) {
        await this.bot!.sendMessage(this.MAIN_GROUP,
          `❌ Bạn chưa có tài khoản! Nhắn tin cho @Haru88gamebot gõ /start để đăng ký.`,
          { reply_to_message_id: messageId }
        );
        return;
      }
      
      // Determine bet amount
      let amount: number;
      const currentBalance = parseFloat(userData.balance || "0");
      
      {
        const minBetD = await getSettingNumber('min_bet', 1000);
        const maxBetD = await getSettingNumber('max_bet', 1000000);
        if (amountStr === 'max') {
          amount = Math.min(currentBalance, maxBetD);
        } else {
          amount = parseInt(amountStr);
        }
        if (amount < minBetD) {
          await this.bot!.sendMessage(this.MAIN_GROUP,
            `❌ Tiền cược tối thiểu là ${minBetD.toLocaleString('vi-VN')} VND`,
            { reply_to_message_id: messageId }
          );
          return;
        }
        if (amount > maxBetD) {
          await this.bot!.sendMessage(this.MAIN_GROUP,
            `❌ Tiền cược tối đa là ${maxBetD.toLocaleString('vi-VN')} VND`,
            { reply_to_message_id: messageId }
          );
          return;
        }
      }

      if (amount > currentBalance) {
        await this.bot!.sendMessage(this.MAIN_GROUP,
          `❌ SỐ DƯ KHÔNG ĐỦ!\n💎 Số dư hiện tại: ${currentBalance.toLocaleString('vi-VN')}đ\n💰 Cần: ${amount.toLocaleString('vi-VN')}đ\n⚠️ Thiếu: ${(amount - currentBalance).toLocaleString('vi-VN')}đ`,
          { reply_to_message_id: messageId }
        );
        return;
      }

      // Only deduct balance for direct prediction bets in bot2 (non-anonymous)
      // Anonymous bets from main bot should NOT deduct balance here
      const newBalance = (currentBalance - amount).toFixed(2);
      await storage.updateBotUser(userId, { balance: newBalance });
      
      // Add bet to session with specific type
      const betType = `${betCategory}_${targetValue}`;
      const betInfo: BetInfo = {
        userId,
        username: user.username || user.first_name,
        betType,
        amount,
        isAnonymous: false, // Prediction bets are not anonymous
        timestamp: Date.now(),
        targetNumber: targetValue
      };
      
      // Check if this is the first bet across all users - if so, start countdown
      let totalBets = 0;
      for (const userBets of Array.from(this.currentSession.bets.values())) {
        totalBets += userBets.length;
      }
      const isFirstBet = totalBets === 0;
      
      // Add bet to user's array
      if (!this.currentSession.bets.has(userId)) {
        this.currentSession.bets.set(userId, []);
      }
      this.currentSession.bets.get(userId)!.push(betInfo);
      
      // Start countdown only on first bet
      if (isFirstBet) {
        console.log(`🎯 First bet placed in session #${this.currentSession.sessionId} - starting 45s countdown`);
        this.startCountdown();
      }
      
      // Send confirmation to group
      let predictionDisplay: string;
      if (betCategory === 'ddt') {
        predictionDisplay = `🎯 DỰ ĐOÁN TỔNG ${targetValue}`;
      } else if (betCategory === 'ddxx') {
        predictionDisplay = `🎲 DỰ ĐOÁN SỐ ${targetValue}`;
      } else if (betCategory === 'D') {
        predictionDisplay = `🎲 ĐOÁN XÚC XẮC ${targetValue}`;
      } else if (betCategory === 'SB') {
        predictionDisplay = `🎯 ĐOÁN TỔNG ${targetValue}`;
      } else {
        predictionDisplay = `${betCategory} ${targetValue}`;
      }
      
      await this.bot!.sendMessage(this.MAIN_GROUP, 
        `🥉 Đặt thành công phiên #${this.currentSession.sessionId} ${predictionDisplay} ${amount.toLocaleString('vi-VN')}đ (${userId})`,
        { reply_to_message_id: messageId }
      );
      
      // Notify main bot about the bet (enhanced version)
      await this.notifyMainBotEnhanced(userId, betType, amount, this.currentSession.sessionId);
      
    } catch (error) {
      console.error('Error processing prediction bet:', error);
      await this.bot!.sendMessage(this.MAIN_GROUP, 
        "❌ Lỗi xử lý cược. Vui lòng thử lại.",
        { reply_to_message_id: messageId }
      );
    }
  }

  private async processCrossPredictionBet(user: TelegramBot.User, betTypeRaw: 'TC' | 'TL' | 'XL' | 'XC', amountStr: string, messageId: number) {
    if (!this.currentSession || this.currentSession.status !== 'betting') {
      await this.bot!.sendMessage(this.MAIN_GROUP, 
        "❌ Hiện tại không thể đặt cược",
        { reply_to_message_id: messageId }
      );
      return;
    }

    const userId = user.id.toString();
    
    try {
      // Get user data
      const userData = await storage.getBotUser(userId);
      if (!userData) {
        await this.bot!.sendMessage(this.MAIN_GROUP,
          `❌ Bạn chưa có tài khoản! Nhắn tin cho @Haru88gamebot gõ /start để đăng ký.`,
          { reply_to_message_id: messageId }
        );
        return;
      }
      
      // Determine bet amount
      let amount: number;
      const currentBalance = parseFloat(userData.balance || "0");
      
      if (amountStr === 'max') {
        amount = Math.min(currentBalance, 1000000); // Max bet limit 1M VND
      } else {
        amount = parseInt(amountStr);
      }
      
      // Validate bet amount
      {
        const minBetC = await getSettingNumber('min_bet', 1000);
        const maxBetC = await getSettingNumber('max_bet', 1000000);
        if (amount < minBetC) {
          await this.bot!.sendMessage(this.MAIN_GROUP, 
            `❌ Tiền cược tối thiểu là ${minBetC.toLocaleString('vi-VN')} VND`,
            { reply_to_message_id: messageId }
          );
          return;
        }
        if (amount > maxBetC) {
          await this.bot!.sendMessage(this.MAIN_GROUP, 
            `❌ Tiền cược tối đa là ${maxBetC.toLocaleString('vi-VN')} VND`,
            { reply_to_message_id: messageId }
          );
          return;
        }
      }
      
      if (amount > currentBalance) {
        await this.bot!.sendMessage(this.MAIN_GROUP,
          `❌ SỐ DƯ KHÔNG ĐỦ!\n💎 Số dư hiện tại: ${currentBalance.toLocaleString('vi-VN')}đ\n💰 Cần: ${amount.toLocaleString('vi-VN')}đ\n⚠️ Thiếu: ${(amount - currentBalance).toLocaleString('vi-VN')}đ`,
          { reply_to_message_id: messageId }
        );
        return;
      }

      // Deduct balance for cross prediction bets (non-anonymous)
      const newBalance = (currentBalance - amount).toFixed(2);
      await storage.updateBotUser(userId, { balance: newBalance });
      
      // Add bet to session with cross prediction type
      const betType = `CROSS_${betTypeRaw}`;
      const betInfo: BetInfo = {
        userId,
        username: user.username || user.first_name,
        betType,
        amount,
        isAnonymous: false, // Cross prediction bets are not anonymous
        timestamp: Date.now()
      };
      
      // Check if this is the first bet across all users - if so, start countdown
      let totalBets = 0;
      for (const userBets of Array.from(this.currentSession.bets.values())) {
        totalBets += userBets.length;
      }
      const isFirstBet = totalBets === 0;
      
      // Add bet to user's array
      if (!this.currentSession.bets.has(userId)) {
        this.currentSession.bets.set(userId, []);
      }
      this.currentSession.bets.get(userId)!.push(betInfo);
      
      // Start countdown only on first bet
      if (isFirstBet) {
        console.log(`🎯 First bet placed in session #${this.currentSession.sessionId} - starting 45s countdown`);
        this.startCountdown();
      }
      
      // Send confirmation to group
      const crossPredictionDisplay = `🎲 ĐOÁN XIÊN ${betTypeRaw}`;
      
      await this.bot!.sendMessage(this.MAIN_GROUP, 
        `🥉 Đặt thành công phiên #${this.currentSession.sessionId} ${crossPredictionDisplay} ${amount.toLocaleString('vi-VN')}đ (${userId})`,
        { reply_to_message_id: messageId }
      );
      
      // Notify main bot about the bet (enhanced version)
      await this.notifyMainBotEnhanced(userId, betType, amount, this.currentSession.sessionId);
      
    } catch (error) {
      console.error('Error processing cross prediction bet:', error);
      await this.bot!.sendMessage(this.MAIN_GROUP, 
        "❌ Lỗi xử lý cược. Vui lòng thử lại.",
        { reply_to_message_id: messageId }
      );
    }
  }

  private async processBet(user: TelegramBot.User, betTypeRaw: string, amount: number, messageId: number) {
    if (!this.currentSession || this.currentSession.status !== 'betting') {
      await this.bot!.sendMessage(this.MAIN_GROUP, 
        "❌ Hiện tại không thể đặt cược",
        { reply_to_message_id: messageId }
      );
      return;
    }

    const userId = user.id.toString();
    
    // Allow multiple bets per user - no restriction needed

    // Determine bet type and if anonymous
    // Direct bets in bot2 group are NEVER anonymous — balance must be deducted here.
    // Bets forwarded from the main bot (via receiveBetFromBot2) already set isAnonymous:true.
    const isAnonymous = false;
    let betType: BetInfo['betType'];
    
    // Check 2-character bet types FIRST before single character ones
    if (betTypeRaw === 'TC') betType = 'TC';
    else if (betTypeRaw === 'TL') betType = 'TL';
    else if (betTypeRaw === 'XC') betType = 'XC';
    else if (betTypeRaw === 'XL') betType = 'XL';
    else if (betTypeRaw === 'MC') betType = 'MC';
    else if (betTypeRaw === 'ML') betType = 'ML';
    else if (betTypeRaw.startsWith('T')) betType = 'T';
    else if (betTypeRaw.startsWith('X')) betType = 'X';
    else if (betTypeRaw.startsWith('C')) betType = 'C';
    else if (betTypeRaw.startsWith('L')) betType = 'L';
    else return;

    try {
      // BOT2 SHOULD NOT DEDUCT BALANCE FOR ANONYMOUS BETS FROM MAIN BOT
      // Anonymous bets already have balance deducted by main bot before sending here
      // Only deduct balance for direct bets in bot2 (non-anonymous)
      if (!isAnonymous) {
        const currentUserData = await storage.getBotUser(userId);
        if (!currentUserData) {
          await this.bot!.sendMessage(this.MAIN_GROUP,
            `❌ Bạn chưa có tài khoản! Nhắn tin cho @Haru88gamebot gõ /start để đăng ký.`,
            { reply_to_message_id: messageId }
          );
          return;
        }
        
        const currentBalance = parseFloat(currentUserData.balance || "0");
        if (currentBalance < amount) {
          await this.bot!.sendMessage(this.MAIN_GROUP,
            `❌ SỐ DƯ KHÔNG ĐỦ!\n💎 Số dư hiện tại: ${currentBalance.toLocaleString('vi-VN')}đ\n💰 Cần: ${amount.toLocaleString('vi-VN')}đ\n⚠️ Thiếu: ${(amount - currentBalance).toLocaleString('vi-VN')}đ`,
            { reply_to_message_id: messageId }
          );
          return;
        }
        
        const newBalance = (currentBalance - amount).toFixed(2);
        await storage.updateBotUser(userId, { balance: newBalance });
      }
      
      // Add bet to session
      const betInfo: BetInfo = {
        userId,
        username: user.username || user.first_name,
        betType,
        amount,
        isAnonymous,
        timestamp: Date.now()
      };
      
      // Check if this is the first bet across all users - if so, start countdown
      let totalBets = 0;
      for (const userBets of Array.from(this.currentSession.bets.values())) {
        totalBets += userBets.length;
      }
      const isFirstBet = totalBets === 0;
      
      // Add bet to user's array
      if (!this.currentSession.bets.has(userId)) {
        this.currentSession.bets.set(userId, []);
      }
      this.currentSession.bets.get(userId)!.push(betInfo);
      
      // Start countdown only on first bet
      if (isFirstBet) {
        console.log(`🎯 First bet placed in session #${this.currentSession.sessionId} - starting 45s countdown`);
        this.startCountdown();
      }
      
      // Send confirmation to group (bot2)
      const betTypeShort = this.getBetTypeShort(betType);
      await this.bot!.sendMessage(this.MAIN_GROUP, 
        `Đặt thành công phiên #${this.currentSession.sessionId}\n${betTypeShort}-${amount.toLocaleString('vi-VN')}${isAnonymous ? ' {Ẩn Danh}' : ''}`,
        { reply_to_message_id: messageId }
      );
      
      // Notify main bot about the bet (enhanced version)
      await this.notifyMainBotEnhanced(userId, betType, amount, this.currentSession.sessionId);
      
    } catch (error) {
      console.error('Error processing bet:', error);
      await this.bot!.sendMessage(this.MAIN_GROUP, 
        "❌ Lỗi xử lý cược. Vui lòng thử lại.",
        { reply_to_message_id: messageId }
      );
    }
  }

  private async notifyMainBot(userId: string, betType: string, amount: number, sessionId: number) {
    try {
      // Get updated balance
      const userData = await storage.getBotUser(userId);
      const newBalance = userData ? parseFloat(userData.balance || "0") : 0;
      
      // Import main bot service to send notification
      const { telegramBotService } = await import('./telegramBot');
      
      // Send notification to main bot user (anonymous - no user ID shown)
      const betTypeDisplay = this.getBetTypeDisplay(betType);
      await telegramBotService.sendMessage(userId, 
        `🥉 Đặt thành công phiên #${sessionId}\n${betTypeDisplay} ${amount.toLocaleString('vi-VN')}đ\nSố dư sau khi cược: ${newBalance.toLocaleString('vi-VN')} VND`
      );
      
    } catch (error) {
      console.error('Error notifying main bot:', error);
    }
  }

  /**
   * Trả về public URL của server — tự động nhận diện môi trường chạy.
   * Ưu tiên: PUBLIC_URL env → RENDER_EXTERNAL_URL → REPLIT_DOMAINS → REPLIT_DEV_DOMAIN → bot-config.json
   */
  private getPublicUrl(): string {
    if (process.env["PUBLIC_URL"]) return process.env["PUBLIC_URL"].replace(/\/$/, "");
    if (process.env["RENDER_EXTERNAL_URL"]) return process.env["RENDER_EXTERNAL_URL"].replace(/\/$/, "");
    const domains = process.env["REPLIT_DOMAINS"]?.split(",");
    if (domains?.[0]) return `https://${domains[0].trim()}`;
    if (process.env["REPLIT_DEV_DOMAIN"]) return `https://${process.env["REPLIT_DEV_DOMAIN"]}`;
    try {
      const cfg = JSON.parse(readFileSync(join(process.cwd(), "bot-config.json"), "utf8"));
      if (cfg.publicUrl && typeof cfg.publicUrl === "string" && cfg.publicUrl.startsWith("http")) {
        return cfg.publicUrl.replace(/\/$/, "");
      }
    } catch { /* bỏ qua nếu file không tồn tại */ }
    return "";
  }

  private getBetTypeDisplay(betType: string): string {
    switch (betType) {
      case 'T': return '🔵 TÀI';
      case 'X': return '🔴 XỈU';
      case 'C': return '⚪️ CHẴN';
      case 'L': return '⚫️ LẺ';
      case 'TC': return '🔵⚪️ TÀI CHẴN (12,14,16,18)';
      case 'TL': return '🔵⚫️ TÀI LẺ (11,13,15,17)';
      case 'XC': return '🔴⚪️ XỈU CHẴN (4,6,8,10)';
      case 'XL': return '🔴⚫️ XỈU LẺ (3,5,7,9)';
      case 'MC': return '🔵 MD5 CHẴN';
      case 'ML': return '🔴 MD5 LẺ';
      default:
        if (betType.startsWith('ddt_')) {
          const targetTotal = betType.split('_')[1];
          return `🎯 DỰ ĐOÁN TỔNG ${targetTotal}`;
        } else if (betType.startsWith('ddxx_')) {
          const targetNumber = betType.split('_')[1];
          return `🎲 DỰ ĐOÁN SỐ ${targetNumber}`;
        } else if (betType.startsWith('D_')) {
          const targetNumber = betType.split('_')[1];
          return `🎲 ĐOÁN XÚC XẮC SỐ ${targetNumber} (x2/x3/x4)`;
        } else if (betType.startsWith('SB_')) {
          const targetTotal = betType.split('_')[1];
          return `🎯 ĐOÁN TỔNG ${targetTotal}`;
        }
        return betType;
    }
  }

  private getBetTypeShort(betType: string): string {
    switch (betType) {
      case 'T': return 'T';
      case 'X': return 'X';
      case 'C': return 'C';
      case 'L': return 'L';
      case 'TC': return 'TC';
      case 'TL': return 'TL';
      case 'XC': return 'XC';
      case 'XL': return 'XL';
      case 'MC': return 'MC';
      case 'ML': return 'ML';
      default:
        if (betType.startsWith('ddt_')) {
          const targetTotal = betType.split('_')[1];
          return `DT${targetTotal}`;
        } else if (betType.startsWith('ddxx_')) {
          const targetNumber = betType.split('_')[1];
          return `DX${targetNumber}`;
        }
        return betType;
    }
  }

  private startNewSession() {
    this.sessionCounter++;
    
    // Generate MD5 hash for this session
    const sessionCode = this.generateRandomCode();
    const md5Hash = crypto.createHash('md5').update(sessionCode).digest('hex');
    
    this.currentSession = {
      sessionId: this.sessionCounter,
      bets: new Map(),
      startTime: Date.now(),
      status: 'betting',
      md5Hash: md5Hash,
      originalCode: sessionCode
    };
    
    // Send session start message (fire-and-forget with error logging)
    this.sendSessionStartMessage().catch((e) =>
      console.error('Error sending session start message:', e)
    );
    
    // Do NOT start countdown here - it will start with first bet
    console.log(`🎲 Started new Tài Xỉu session #${this.sessionCounter} - waiting for first bet`);
  }

  private async sendSessionStartMessage() {
    if (!this.currentSession || !this.bot) return;
    
    let sessionStartMsg: string;
    
    if (this.isFirstSessionOfDay) {
      // First session of the day - full message with lucky number
      const keyboard = {
        inline_keyboard: [
          [{ text: "Link Bot Chính", url: "https://t.me/Haru88gamebot" }],
          [{ text: "💰 Nạp Tiền", url: "https://t.me/Haru88gamebot?start=nap_tien" }]
        ]
      };
      
      sessionStartMsg = `Xin mời đặt cược phiên #${this.currentSession.sessionId}\n\n` +
                       `- Tiền cược tối thiểu 1.000 và tối đa 1.000.000\n` +
                       `Cách chơi: Cửa cược [dấu cách] số tiền\n\n` +
                       `VD: T 50000 hoặc C 30000\n` +
                       `Cược tất tay: X max\n` +
                       `MD5: ${this.currentSession.md5Hash}\n` +
                       `🍀 Con số may mắn của hôm nay là: ${this.dailyLuckyNumber} 🍀\n` +
                       `Nhận thưởng 5.000 nếu 2 số cuối ID của bạn trùng với số may mắn\n` +
                       `Cách nhận: chat lệnh /nhanthuong`;
      
      await this.bot.sendMessage(this.MAIN_GROUP, sessionStartMsg, {
        reply_markup: keyboard
      });
      
      // Mark that first session of day has been sent
      this.isFirstSessionOfDay = false;
    } else {
      // Subsequent sessions - short message with countdown and Bot Chính button
      const keyboard = {
        inline_keyboard: [
          [{ text: "Bot Chính", url: "https://t.me/Haru88gamebot" }],
          [{ text: "💰 Nạp Tiền", url: "https://t.me/Haru88gamebot?start=nap_tien" }]
        ]
      };
      
      sessionStartMsg = `Xin mời đặt cược phiên #${this.currentSession.sessionId}\n\n` +
                       `- Tiền cược tối thiểu 1.000 và tối đa 1.000.000\n` +
                       `Cách chơi: Cửa cược [dấu cách] số tiền\n\n` +
                       `VD: T 50000 hoặc C 30000\n` +
                       `Cược tất tay: X max\n` +
                       `90s của phiên tiếp theo bắt đầu!`;
      
      await this.bot.sendMessage(this.MAIN_GROUP, sessionStartMsg, {
        reply_markup: keyboard
      });
    }
  }

  private async startCountdown() {
    if (!this.currentSession) return;

    // Đọc thời gian phiên từ cài đặt DB, mặc định 90 giây
    const rawDuration = await getSettingNumber('bot2_session_duration', 90);
    const totalDuration = Math.max(15, Math.min(300, rawDuration)); // Giới hạn 15–300 giây
    const rawLock = await getSettingNumber('bot2_lock_seconds', 5);
    const lockSeconds = Math.max(3, Math.min(30, rawLock)); // Giới hạn 3–30 giây

    let timeLeft = totalDuration;
    const sessionId = this.currentSession.sessionId;

    // Reminder checkpoints: 2/3 và 1/3 của tổng thời gian (làm tròn, ít nhất cách 5s)
    const remind1 = Math.round((totalDuration * 2) / 3);
    const remind2 = Math.round(totalDuration / 3);

    const sendUpdate = async (label?: string) => {
      if (!this.currentSession || this.currentSession.sessionId !== sessionId) return;
      
      const totals = this.calculateBettingTotals();
      const keyboard = {
        inline_keyboard: [
          [
            { text: "💰 Nạp Tiền", url: "https://t.me/Haru88gamebot?start=nap_tien" },
            { text: "💎 Kiểm tra SD", callback_data: "check_sd_bot2" }
          ]
        ]
      };
      
      const header = label ? label : `⏳ Còn ${timeLeft} giây đặt cược phiên #${sessionId}`;
      let message = `${header}\n` +
        `🔵 TÀI: ${totals.tai.toLocaleString('vi-VN')}\n` +
        `🔴 XỈU: ${totals.xiu.toLocaleString('vi-VN')}\n` +
        `⚪️ CHẴN: ${totals.chan.toLocaleString('vi-VN')}\n` +
        `⚫️ LẺ: ${totals.le.toLocaleString('vi-VN')}`;
      
      if (totals.tc > 0) message += `\n🔵⚪️ TÀI CHẴN: ${totals.tc.toLocaleString('vi-VN')}`;
      if (totals.tl > 0) message += `\n🔵⚫️ TÀI LẺ: ${totals.tl.toLocaleString('vi-VN')}`;
      if (totals.xc > 0) message += `\n🔴⚪️ XỈU CHẴN: ${totals.xc.toLocaleString('vi-VN')}`;
      if (totals.xl > 0) message += `\n🔴⚫️ XỈU LẺ: ${totals.xl.toLocaleString('vi-VN')}`;
      
      await this.bot!.sendMessage(this.MAIN_GROUP, message, { reply_markup: keyboard });
    };
    
    // Gửi thông báo bắt đầu phiên
    sendUpdate(`🎰 Phiên #${sessionId} bắt đầu! ${totalDuration} giây đặt cược`);
    
    this.countdownTimer = setInterval(async () => {
      timeLeft -= 1;

      // Lock chat khi còn lockSeconds giây
      if (timeLeft === lockSeconds && !this.isGroupLocked) {
        this.isGroupLocked = true;
        await this.lockGroupChat(true);
        await this.bot!.sendMessage(this.MAIN_GROUP,
          `🔒 <b>KHOÁ CỬA ĐẶT CƯỢC!</b>\n⏳ Còn ${lockSeconds} giây — chuẩn bị tung xúc xắc...`,
          { parse_mode: 'HTML' }
        );
      }

      // Nhắc ở mốc 2/3 và 1/3 thời gian (chỉ nếu cách lock đủ xa)
      if ((timeLeft === remind1 || timeLeft === remind2) && timeLeft > lockSeconds + 5) {
        await sendUpdate();
      }

      if (timeLeft <= 0) {
        clearInterval(this.countdownTimer!);
        if (this.bot) {
          const totals = this.calculateBettingTotals();
          const totalAll = totals.tai + totals.xiu + totals.chan + totals.le + totals.tc + totals.tl + totals.xc + totals.xl;
          await this.bot.sendMessage(this.MAIN_GROUP,
            `🔒 HẾT GIỜ ĐẶT CƯỢC phiên #${sessionId}\n` +
            `💰 Tổng cược: ${totalAll.toLocaleString('vi-VN')}đ\n` +
            `⏳ Đang tung xúc xắc...`
          );
        }
        await this.endBettingPhase();
      }
    }, 1000);
  }

  private calculateBettingTotals(): BettingTotals {
    const totals: BettingTotals = { tai: 0, xiu: 0, chan: 0, le: 0, tc: 0, tl: 0, xc: 0, xl: 0, mc: 0, ml: 0, other: 0 };
    
    if (!this.currentSession) return totals;
    
    for (const userBets of Array.from(this.currentSession.bets.values())) {
      for (const bet of userBets) {
        switch (bet.betType) {
          case 'T':   totals.tai   += bet.amount; break;
          case 'X':   totals.xiu   += bet.amount; break;
          case 'C':   totals.chan  += bet.amount; break;
          case 'L':   totals.le    += bet.amount; break;
          case 'TC':  totals.tc    += bet.amount; break;
          case 'TL':  totals.tl    += bet.amount; break;
          case 'XC':  totals.xc    += bet.amount; break;
          case 'XL':  totals.xl    += bet.amount; break;
          case 'MC':  totals.mc    += bet.amount; break;
          case 'ML':  totals.ml    += bet.amount; break;
          default:    totals.other += bet.amount; break;
        }
      }
    }
    
    return totals;
  }

  private async endBettingPhase() {
    if (!this.currentSession) return;
    
    this.currentSession.status = 'locked';
    const totals = this.calculateBettingTotals();
    
    // Send final betting summary
    let finalMessage = `Hết thời gian đặt cược phiên #${this.currentSession.sessionId}\n` +
      `🔵 TÀI: ${totals.tai.toLocaleString('vi-VN')}\n` +
      `🔴 XỈU: ${totals.xiu.toLocaleString('vi-VN')}\n` +
      `⚪️ CHẴN: ${totals.chan.toLocaleString('vi-VN')}\n` +
      `⚫️ LẺ: ${totals.le.toLocaleString('vi-VN')}`;
    
    // Show combined bets only if they have stakes
    if (totals.tc > 0)    finalMessage += `\n🔵⚪️ TÀI CHẴN: ${totals.tc.toLocaleString('vi-VN')}`;
    if (totals.tl > 0)    finalMessage += `\n🔵⚫️ TÀI LẺ: ${totals.tl.toLocaleString('vi-VN')}`;
    if (totals.xc > 0)    finalMessage += `\n🔴⚪️ XỈU CHẴN: ${totals.xc.toLocaleString('vi-VN')}`;
    if (totals.xl > 0)    finalMessage += `\n🔴⚫️ XỈU LẺ: ${totals.xl.toLocaleString('vi-VN')}`;
    if (totals.mc > 0)    finalMessage += `\n⚪️🔵 MẠNH CHẴN: ${totals.mc.toLocaleString('vi-VN')}`;
    if (totals.ml > 0)    finalMessage += `\n⚫️🔵 MẠNH LẺ: ${totals.ml.toLocaleString('vi-VN')}`;
    if (totals.other > 0) finalMessage += `\n🎯 KHÁC: ${totals.other.toLocaleString('vi-VN')}`;
    
    await this.bot!.sendMessage(this.MAIN_GROUP, finalMessage);
    
    // Start rolling dice
    await this.startDiceRoll();
  }

  private async startDiceRoll() {
    if (!this.currentSession) return;
    
    this.currentSession.status = 'rolling';
    
    await this.bot!.sendMessage(this.MAIN_GROUP, 
      `💥 Bắt đầu tung xúc xắc phiên #${this.currentSession.sessionId} 💥`
    );
    
    // Send dice using sendDice API with 1s delay between each
    const diceResults: number[] = [];
    
    for (let i = 0; i < 3; i++) {
      try {
        const diceMessage = await this.bot!.sendDice(this.MAIN_GROUP);
        if (diceMessage.dice) {
          diceResults.push(diceMessage.dice.value);
        }
        
        // Wait 1 second between dice so they don't overlap
        if (i < 2) {
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      } catch (error) {
        console.error('Error sending dice:', error);
        // Fallback to generated results if sendDice fails
        const fallbackResults = this.generateDiceResults();
        diceResults.push([fallbackResults.dice1, fallbackResults.dice2, fallbackResults.dice3][i]);
      }
    }
    
    // Create results from actual dice API or fallback
    const [dice1, dice2, dice3] = diceResults.length === 3 ? diceResults : [1, 1, 1]; // fallback
    const total = dice1 + dice2 + dice3;
    
    this.currentSession.results = {
      dice1,
      dice2,
      dice3,
      total,
      isTai: total >= 11,
      isEven: total % 2 === 0,
      md5Original: this.currentSession.originalCode || ''
    };
    
    // Wait for all dice animations to fully settle (~4.5s after last dice sent)
    await new Promise(resolve => setTimeout(resolve, 4500));
    
    // Process results
    await this.processResults();
  }

  private generateDiceResults(): DiceResult {
    // Use the session's original code for provable fairness
    if (!this.currentSession?.originalCode) {
      throw new Error('No session original code available for dice generation');
    }
    const randomCode = this.currentSession.originalCode;
    const md5Hash = crypto.createHash('md5').update(randomCode).digest('hex');
    
    // Extract random values from MD5
    const dice1 = (parseInt(md5Hash.substr(0, 2), 16) % 6) + 1;
    const dice2 = (parseInt(md5Hash.substr(2, 2), 16) % 6) + 1;
    const dice3 = (parseInt(md5Hash.substr(4, 2), 16) % 6) + 1;
    
    const total = dice1 + dice2 + dice3;
    
    return {
      dice1,
      dice2,
      dice3,
      total,
      isTai: total >= 11,
      isEven: total % 2 === 0,
      md5Original: randomCode
    };
  }

  private generateRandomCode(): string {
    const sessionId = this.currentSession?.sessionId || 0;
    const randomString = Math.random().toString(36).substring(2, 18); // 16 chars
    const randomNum = Math.floor(Math.random() * 99) + 1;
    return `#${sessionId}:${randomString}_${randomNum}`;
  }


  private async processResults() {
    if (!this.currentSession || !this.currentSession.results) return;
    try {
    const { dice1, dice2, dice3, total, isTai, isEven, md5Original } = this.currentSession.results;
    const sessionId = this.currentSession.sessionId;
    
    // Calculate winnings and losings
    let totalWinnings = 0;
    let totalLosings = 0;
    const winnersData: Array<{userId: string, betType: string, amount: number, winAmount: number}> = [];
    const losersData: Array<{userId: string, betType: string, amount: number}> = [];
    
    for (const [userId, userBets] of Array.from(this.currentSession.bets.entries())) {
      for (const bet of userBets) {
        let won = false;
        
        switch (bet.betType) {
          case 'T':
            won = isTai;
            break;
          case 'X':
            won = !isTai;
            break;
          case 'C':
            won = isEven;
            break;
          case 'L':
            won = !isEven;
            break;
          case 'TC':
            // Tài Chẵn: totals 12,14,16,18
            won = [12, 14, 16, 18].includes(total);
            break;
          case 'TL':
            // Tài Lẻ: totals 11,13,15,17
            won = [11, 13, 15, 17].includes(total);
            break;
          case 'XC':
            // Xỉu Chẵn: totals 4,6,8,10
            won = [4, 6, 8, 10].includes(total);
            break;
          case 'XL':
            // Xỉu Lẻ: totals 3,5,7,9
            won = [3, 5, 7, 9].includes(total);
            break;
          case 'MC':
            // MD5 even: last digit of random number is even
            const lastDigit = parseInt(md5Original.split('_')[1]) % 10;
            won = lastDigit % 2 === 0;
            break;
          case 'ML':
            // MD5 odd: last digit of random number is odd
            const lastDigitOdd = parseInt(md5Original.split('_')[1]) % 10;
            won = lastDigitOdd % 2 === 1;
            break;
          default:
            // Handle prediction bets: ddt_X, ddxx_X, D_X, and SB_X
            if (bet.betType.startsWith('ddt_')) {
              const targetTotal = parseInt(bet.betType.split('_')[1]);
              won = total === targetTotal;
            } else if (bet.betType.startsWith('ddxx_')) {
              const targetNumber = parseInt(bet.betType.split('_')[1]);
              won = dice1 === targetNumber || dice2 === targetNumber || dice3 === targetNumber;
            } else if (bet.betType.startsWith('D_')) {
              const targetNumber = parseInt(bet.betType.split('_')[1]);
              // For D bets, we store the number of matches for payout calculation
              let matches = 0;
              if (dice1 === targetNumber) matches++;
              if (dice2 === targetNumber) matches++;
              if (dice3 === targetNumber) matches++;
              won = matches > 0;
              // Store matches count in the bet object for multiplier calculation
              (bet as any).matchCount = matches;
            } else if (bet.betType.startsWith('SB_')) {
              const targetTotal = parseInt(bet.betType.split('_')[1]);
              won = total === targetTotal;
            } else if (bet.betType.startsWith('CROSS_')) {
              // Cross prediction bets
              const crossType = bet.betType.split('_')[1];
              if (crossType === 'TL') {
                // Tài Lẻ: totals 11,13,15,17
                won = [11, 13, 15, 17].includes(total);
              } else if (crossType === 'TC') {
                // Tài Chẵn: totals 12,14,16,18
                won = [12, 14, 16, 18].includes(total);
              } else if (crossType === 'XL') {
                // Xỉu Lẻ: totals 3,5,7,9
                won = [3, 5, 7, 9].includes(total);
              } else if (crossType === 'XC') {
                // Xỉu Chẵn: totals 4,6,8,10
                won = [4, 6, 8, 10].includes(total);
              }
            }
            break;
        }
        
        if (won) {
          // Calculate multiplier based on bet type
          const houseEdgeTx = await getSettingNumber('house_edge', 2.5);
          let multiplier = parseFloat((2 * (1 - houseEdgeTx / 100)).toFixed(4)); // Default for T/X/C/L/MC/ML
          if (bet.betType === 'TL') {
            multiplier = 2.6; // Tài Lẻ: 11,13,15,17
          } else if (bet.betType === 'TC') {
            multiplier = 3.3; // Tài Chẵn: 12,14,16,18
          } else if (bet.betType === 'XL') {
            multiplier = 3.3; // Xỉu Lẻ: 3,5,7,9
          } else if (bet.betType === 'XC') {
            multiplier = 2.6; // Xỉu Chẵn: 4,6,8,10
          } else if (bet.betType.startsWith('ddt_')) {
            multiplier = 15.0; // 15x for total prediction
          } else if (bet.betType.startsWith('ddxx_')) {
            multiplier = 1.5; // 1.5x for specific dice number
          } else if (bet.betType.startsWith('D_')) {
            // D bets: 1 match = 2x, 2 matches = 3x, 3 matches = 4x
            const matches = (bet as any).matchCount || 1;
            multiplier = matches + 1; // 1->2, 2->3, 3->4
          } else if (bet.betType.startsWith('SB_')) {
            // SB bets: Different multipliers based on target total
            const targetTotal = parseInt(bet.betType.split('_')[1]);
            if (targetTotal === 4 || targetTotal === 17) {
              multiplier = 40;
            } else if (targetTotal === 5 || targetTotal === 16) {
              multiplier = 18;
            } else if (targetTotal === 6 || targetTotal === 15) {
              multiplier = 12;
            } else if (targetTotal === 7 || targetTotal === 14) {
              multiplier = 8;
            } else if (targetTotal === 8 || targetTotal === 13) {
              multiplier = 6;
            } else if (targetTotal === 9 || targetTotal === 12) {
              multiplier = 5;
            } else if (targetTotal === 10 || targetTotal === 11) {
              multiplier = 5;
            } else {
              multiplier = 1; // Safety fallback
            }
          } else if (bet.betType.startsWith('CROSS_')) {
            // Cross prediction bets with specific multipliers
            const crossType = bet.betType.split('_')[1];
            if (crossType === 'TL') {
              multiplier = 2.6; // Tài Lẻ: 11,13,15,17
            } else if (crossType === 'TC') {
              multiplier = 3.3; // Tài Chẵn: 12,14,16,18
            } else if (crossType === 'XL') {
              multiplier = 3.3; // Xỉu Lẻ: 3,5,7,9
            } else if (crossType === 'XC') {
              multiplier = 2.6; // Xỉu Chẵn: 4,6,8,10
            }
          }
          
          const winAmount = Math.floor(bet.amount * multiplier);
          totalWinnings += winAmount;
          
          // Update winner's balance directly in DB
          try {
            const currentUserData = await storage.getBotUser(userId);
            const currentUserBalance = parseFloat(currentUserData?.balance || "0");
            const newBalance = (currentUserBalance + winAmount).toFixed(2);
            await storage.updateBotUser(userId, { balance: newBalance });
          } catch (balErr) {
            console.error(`❌ Failed to credit balance for winner ${userId}:`, balErr);
          }
          
          winnersData.push({
            userId,
            betType: bet.betType,
            amount: bet.amount,
            winAmount
          });
        } else {
          totalLosings += bet.amount;
          
          // Add to losers data
          losersData.push({
            userId,
            betType: bet.betType,
            amount: bet.amount
          });
        }
      }
    }
    
    // Check for jackpot (all three dice same)
    const isJackpot = dice1 === dice2 && dice2 === dice3;
    if (isJackpot && winnersData.length > 0) {
      // Distribute jackpot among winners (add to their winAmount)
      const jackpotPerWinner = Math.floor(this.jackpot.amount / winnersData.length);
      winnersData.forEach(winner => {
        winner.winAmount += jackpotPerWinner;
      });
      totalWinnings += this.jackpot.amount;
      this.jackpot.amount = 0; // Reset jackpot to 0
    }
    
    // Add 1% of losses to jackpot
    const jackpotIncrease = Math.floor(totalLosings * 0.01);
    this.jackpot.amount += jackpotIncrease;
    
    // Save session to DB for history web page
    try {
      await storage.saveTaixiuSession({
        sessionId,
        dice1,
        dice2,
        dice3,
        total,
        isTai,
        isEven,
        md5Original,
        md5Hash: crypto.createHash('md5').update(md5Original).digest('hex'),
        totalWinnings,
        totalLosings,
      });
    } catch (dbErr) {
      console.error('Error saving taixiu session to DB:', dbErr);
    }

    // Load recent history from DB (reliable after restarts), newest-first → reverse for oldest-left display
    let taiXiuHistory = '';
    let chanLeHistory = '';
    try {
      const recentSessions = await storage.getTaixiuSessions(12);
      const ordered = [...recentSessions].reverse(); // oldest first (left → right)
      taiXiuHistory = ordered.map(s => s.isTai ? '🔵' : '🔴').join(' ');
      chanLeHistory = ordered.map(s => s.isEven ? '⚪️' : '⚫️').join(' ');
    } catch {
      // Fallback to in-memory history if DB fails
      this.updateGameHistory(isTai, isEven);
      const ordered = [...this.gameHistory].reverse();
      taiXiuHistory = ordered.map(r => r[0]).join(' ');
      chanLeHistory = ordered.map(r => r[1]).join(' ');
    }
    
    // Notify main bot for transaction records and private notifications
    await this.sendResultToMainBot(sessionId, this.currentSession.results, winnersData, losersData);
    
    // Send results with exact format requested
    const taiXiuText = isTai ? 'TÀI' : 'XỈU';
    const chanLeText = isEven ? 'CHẴN' : 'LẺ';
    
    const base = this.getPublicUrl();

    // Links embedded in message text open directly in Telegram's in-app browser
    // without a "Do you want to open?" confirmation dialog (unlike url inline buttons).
    const resultMsg =
      `🎲 <b>Kết quả phiên #${sessionId}</b>\n\n` +
      `<blockquote>🎲 ${dice1} · ${dice2} · ${dice3}   👉  <b>${taiXiuText} ${chanLeText}</b>  ${isTai ? '🔵' : '🔴'}${isEven ? '⚪️' : '⚫️'}</blockquote>\n\n` +
      `<blockquote expandable>📋 Chi tiết phiên\n` +
      `🔐 Mã MD5: <code>${md5Original}</code>\n` +
      `💰 Tổng thắng: <b>${totalWinnings.toLocaleString('vi-VN')}đ</b>\n` +
      `💸 Tổng thua: <b>${totalLosings.toLocaleString('vi-VN')}đ</b>\n` +
      `🏆 Cộng vào hũ: <b>${jackpotIncrease.toLocaleString('vi-VN')}đ</b>\n` +
      `🎰 Hũ hiện tại: <b>${this.jackpot.amount.toLocaleString('vi-VN')}đ</b></blockquote>\n\n` +
      `<blockquote>📊 Lịch sử gần đây (cũ → mới)\n` +
      `TÀI/XỈU:  ${taiXiuHistory}\n` +
      `CHẴN/LẺ: ${chanLeHistory}</blockquote>\n\n` +
      `📜 Nhấn nút bên dưới để xem lịch sử phiên dưới dạng mini app`;

    // Build buttons — use t.me deeplinks so Telegram opens private chat
    // then bot sends web_app button → opens as true mini app (no URL bar)
    const histBtn = this.botUsername
      ? { text: "📜 Lịch sử phiên", url: `https://t.me/${this.botUsername}?start=view_hist` }
      : { text: "📜 Lịch sử phiên", url: `${base}/api/bot2/history` };
    const md5Btn = this.botUsername
      ? { text: "🔐 Lịch sử MD5", url: `https://t.me/${this.botUsername}?start=view_md5` }
      : { text: "🔐 Lịch sử MD5", url: `${base}/api/bot2/md5` };

    try {
      await this.bot!.sendMessage(this.MAIN_GROUP, resultMsg, {
        reply_markup: {
          inline_keyboard: [[ histBtn, md5Btn ]]
        },
        parse_mode: 'HTML'
      });
    } catch (msgErr) {
      console.error('Bot2: Failed to send result message:', msgErr instanceof Error ? msgErr.message : String(msgErr));
    }
    
    // Main bot result message removed as requested
    
    // Send history to groups
    await this.sendToHistoryGroups(sessionId, total, isTai, isEven, md5Original);
    
    // Mark session completed first
    this.currentSession.status = 'completed';
    
    // Unlock chat THEN clear local lock flag (order matters)
    await this.lockGroupChat(false);
    this.isGroupLocked = false;
    
    // Start new session after 3 seconds
    setTimeout(() => {
      this.startNewSession();
    }, 3000);
    } catch (err) {
      console.error('Bot2: Critical error in processResults — session may need manual reset:', err instanceof Error ? err.message : String(err));
      // Ensure chat is unlocked and a new session starts even if something failed
      try { await this.lockGroupChat(false); } catch {}
      this.isGroupLocked = false;
      setTimeout(() => { this.startNewSession(); }, 5000);
    }
  }

  private updateGameHistory(isTai: boolean, isEven: boolean) {
    // Add to beginning (unshift) and keep exactly 12 results (not 10)
    this.gameHistory.unshift([isTai ? '🔵' : '🔴', isEven ? '⚪️' : '⚫️']);
    if (this.gameHistory.length > 12) {
      this.gameHistory = this.gameHistory.slice(0, 12);
    }
  }

  private getGameHistoryDisplay(): string {
    const taiXiuLine = this.gameHistory.map(result => result[0]).join('');
    const chanLeLine = this.gameHistory.map(result => result[1]).join('');
    
    return `${taiXiuLine}\n${chanLeLine}`;
  }

  private async sendToHistoryGroups(sessionId: number, total: number, isTai: boolean, isEven: boolean, md5Original: string) {
    try {
      if (!this.currentSession?.results) return;
      
      const { dice1, dice2, dice3 } = this.currentSession.results;
      
      // Generate stats for display (12 recent results)
      const taiXiuStats = this.gameHistory.map(result => result[0]).join('');
      const chanLeStats = this.gameHistory.map(result => result[1]).join('');
      
      // Send session history with format: 🎲 Kết quả phiên (số phiên) 🎲 (dice1, dice2, dice3) 👉 (tài hay xỉu/chẵn hay lẻ) (🔵hay🔴/⚪️hay⚫️)
      const taiXiuResult = isTai ? 'TÀI' : 'XỈU';
      const chanLeResult = isEven ? 'CHẴN' : 'LẺ';
      const taiXiuIcon = isTai ? '🔵' : '🔴';
      const chanLeIcon = isEven ? '⚪️' : '⚫️';
      
      const historyMessage = `🎲 Kết quả phiên (${sessionId}) 🎲\n(${dice1}, ${dice2}, ${dice3}) 👉 ${taiXiuResult}/${chanLeResult} ${taiXiuIcon}${chanLeIcon}`;
      await this.bot!.sendMessage(this.HISTORY_GROUP, historyMessage);
      
      // Send MD5 original to MD5 group with exact format: #{session_id}:{16_ky_tu_random}_{1-99}
      await this.bot!.sendMessage(this.MD5_GROUP, md5Original);
      
    } catch (error: any) {
      const msg = error?.message || String(error);
      // Bỏ qua lỗi nếu nhóm lịch sử chưa được cấu hình hoặc bot chưa được thêm vào
      if (!msg.includes('chat not found') && !msg.includes('bot was kicked') && !msg.includes('CHAT_WRITE_FORBIDDEN')) {
        console.error('Error sending to history groups:', msg);
      }
    }
  }

  private async generateDailyLuckyNumber() {
    const today = new Date().toISOString().split('T')[0];
    
    if (this.dailyLuckyNumberDate !== today) {
      // New day detected - mark as first session of day
      this.isFirstSessionOfDay = true;
      
      // Check if lucky number already exists for today
      const existingLuckyNumber = await storage.getLuckyNumberByDate(today);
      
      if (existingLuckyNumber) {
        this.dailyLuckyNumber = existingLuckyNumber.luckyNumber;
      } else {
        // Generate new lucky number and save to database
        this.dailyLuckyNumber = Math.floor(Math.random() * 100);
        await storage.createLuckyNumber({
          luckyNumber: this.dailyLuckyNumber,
          date: today
        });
      }
      
      this.dailyLuckyNumberDate = today;
      console.log(`🍀 Daily lucky number for ${today}: ${this.dailyLuckyNumber}`);
    }
  }

  private async awardLuckyNumber(userId: string, amount: number) {
    try {
      const userData = await storage.getBotUser(userId);
      if (userData) {
        const currentBalance = parseFloat(userData.balance || "0");
        const newBalance = (currentBalance + amount).toFixed(2);
        await storage.updateBotUser(userId, { balance: newBalance });
        console.log(`🍀 Awarded ${amount} VND to user ${userId} for lucky number`);
      }
    } catch (error) {
      console.error('Error awarding lucky number:', error);
    }
  }

  private async lockGroupChat(lock: boolean) {
    try {
      if (!this.bot) return;
      
      // Define permissions for locked and unlocked states
      const lockedPermissions = {
        can_send_messages: false,
        can_send_audios: false,
        can_send_documents: false,
        can_send_photos: false,
        can_send_videos: false,
        can_send_video_notes: false,
        can_send_voice_notes: false,
        can_send_polls: false,
        can_send_other_messages: false,
        can_add_web_page_previews: false,
        can_change_info: false,
        can_invite_users: false,
        can_pin_messages: false,
        can_manage_topics: false
      };
      
      const unlockedPermissions = {
        can_send_messages: true,
        can_send_audios: true,
        can_send_documents: true,
        can_send_photos: true,
        can_send_videos: true,
        can_send_video_notes: true,
        can_send_voice_notes: true,
        can_send_polls: true,
        can_send_other_messages: true,
        can_add_web_page_previews: true,
        can_change_info: false, // Keep restrictive for security
        can_invite_users: false, // Keep restrictive for security
        can_pin_messages: false, // Keep restrictive for security
        can_manage_topics: false // Keep restrictive for security
      };
      
      // Apply permissions to the group
      await this.bot.setChatPermissions(
        this.MAIN_GROUP, 
        lock ? lockedPermissions : unlockedPermissions
      );
      
      console.log(`🔒 Group chat ${lock ? 'locked' : 'unlocked'} via setChatPermissions`);
      
      // Chat permissions changed silently - no messages sent to group
      
    } catch (error) {
      console.error('Error setting group chat permissions:', error);
      
      // If API call fails, still maintain local lock state for fallback
      console.log(`⚠️ Group chat ${lock ? 'locked' : 'unlocked'} (fallback - local only)`);
      
      // Check if it's a permission error
      if (error instanceof Error && error.message?.includes('permissions')) {
        console.warn('⚠️ Bot may not have administrator permissions in the group');
        await this.bot?.sendMessage(this.MAIN_GROUP, 
          "⚠️ Bot cần quyền quản trị viên để khóa chat. Vui lòng cấp quyền cho bot."
        );
      }
    }
  }

  async processXocDiaBet(user: any, betType: '4do' | '4trang' | '3do1tr' | '1do3tr', amountStr: string, replyToMessageId?: number): Promise<void> {
    if (!this.bot) return;
    await this.bot.sendMessage(this.MAIN_GROUP, '⚠️ Tính năng Xóc Đĩa đang được bảo trì.', replyToMessageId ? { reply_to_message_id: replyToMessageId } : undefined);
  }

  async processRongHoBet(user: any, betType: 'R' | 'H', amountStr: string, replyToMessageId?: number): Promise<void> {
    if (!this.bot) return;
    await this.bot.sendMessage(this.MAIN_GROUP, '⚠️ Tính năng Rồng Hổ đang được bảo trì.', replyToMessageId ? { reply_to_message_id: replyToMessageId } : undefined);
  }

  async sendMessage(chatId: number, text: string, options?: any) {
    if (!this.bot) return;
    
    try {
      return await this.bot.sendMessage(chatId, text, options);
    } catch (error) {
      console.error('Error sending message:', error);
      return;
    }
  }

  async getSessionStatus() {
    return {
      currentSession: this.currentSession ? {
        sessionId: this.currentSession.sessionId,
        status: this.currentSession.status,
        betsCount: this.currentSession.bets.size,
        totals: this.calculateBettingTotals()
      } : null,
      dailyLuckyNumber: this.dailyLuckyNumber,
      jackpot: this.jackpot.amount
    };
  }

  public isActive(): boolean {
    return this.bot !== null;
  }

  // ── Admin helper: kiểm tra user có phải admin/creator của nhóm không ──────
  private async isGroupAdmin(chatId: number, userId: number): Promise<boolean> {
    try {
      const member = await this.bot!.getChatMember(chatId, userId);
      return member.status === 'administrator' || member.status === 'creator';
    } catch {
      return false;
    }
  }

  // ── Admin helper: lấy target user từ reply hoặc argument ─────────────────
  private getTargetFromMsg(msg: TelegramBot.Message, commandArg?: string): { userId: number | null; displayName: string } {
    if (msg.reply_to_message?.from) {
      const u = msg.reply_to_message.from;
      return { userId: u.id, displayName: u.first_name || u.username || String(u.id) };
    }
    if (commandArg && /^\d+$/.test(commandArg.trim())) {
      const id = parseInt(commandArg.trim());
      return { userId: id, displayName: String(id) };
    }
    return { userId: null, displayName: '' };
  }

  // ── Admin helper: parse chuỗi thời gian → giây (1p/1t/1n) ───────────────
  private parseAdminTime(s: string): number | null {
    const m = s.trim().match(/^(\d+)(p|t|n)$/i);
    if (!m) return null;
    const n = parseInt(m[1]);
    switch (m[2].toLowerCase()) {
      case 'p': return n * 60;
      case 't': return n * 3600;
      case 'n': return n * 86400;
      default: return null;
    }
  }

  // ── Admin helper: format giây → chuỗi đọc được ───────────────────────────
  private formatAdminDuration(seconds: number): string {
    if (seconds < 3600) return `${seconds / 60} phút`;
    if (seconds < 86400) return `${seconds / 3600} tiếng`;
    return `${seconds / 86400} ngày`;
  }

  // ========== GIFT CODE BROADCAST ==========

  /**
   * Khởi động scheduler phát code tặng ~2 lần/ngày tại thời điểm ngẫu nhiên.
   * Lần 1: delay ngẫu nhiên 30 phút – 8 tiếng kể từ khi bot start.
   * Lần 2: 12 tiếng sau lần 1, ±2 tiếng ngẫu nhiên.
   * Sau mỗi chu kỳ 24h, tự lên lịch lại.
   */
  async startGiftBroadcastScheduler(): Promise<void> {
    // Clear any existing timers
    this.broadcastTimers.forEach(t => clearTimeout(t));
    this.broadcastTimers = [];

    const enabled = await getSetting('bot2_gift_broadcast_enabled');
    if (enabled !== '1') {
      console.log('[GiftBroadcast] Feature disabled — scheduler not started');
      return;
    }

    const MS = (h: number) => h * 60 * 60 * 1000;

    // First broadcast: random between 30min and 8h from now
    const delay1 = MS(0.5) + Math.floor(Math.random() * MS(7.5));

    // Second broadcast: ~12h after first, ±2h jitter
    const delay2 = delay1 + MS(10) + Math.floor(Math.random() * MS(4));

    const hrStr = (ms: number) => `${(ms / 3600000).toFixed(1)}h`;
    console.log(`[GiftBroadcast] Next broadcasts in ~${hrStr(delay1)} and ~${hrStr(delay2)}`);

    const t1 = setTimeout(async () => {
      await this.broadcastGiftCodes();
    }, delay1);

    const t2 = setTimeout(async () => {
      await this.broadcastGiftCodes();
      // Re-schedule for the next 24h cycle
      this.startGiftBroadcastScheduler().catch(console.error);
    }, delay2);

    this.broadcastTimers = [t1, t2];
  }

  /**
   * Tạo 5 mã gift code ngẫu nhiên (3k–9k mỗi code) và gửi vào nhóm Bot2.
   * Code được đăng ký với hệ thống giftCodesTable của bot chính.
   */
  private async broadcastGiftCodes(): Promise<void> {
    if (!this.bot) return;

    // Re-check enabled state at fire time
    const enabled = await getSetting('bot2_gift_broadcast_enabled');
    if (enabled !== '1') {
      console.log('[GiftBroadcast] Feature disabled at broadcast time — skipping');
      return;
    }

    const COUNT = 5;
    const MIN_AMOUNT = 3000;
    const MAX_AMOUNT = 9000;
    const STEP = 1000; // amounts in multiples of 1000đ

    // Target chat: configurable, default = MAIN_GROUP
    const chatIdSetting = await getSetting('bot2_gift_channel_id');
    const targetChatId = chatIdSetting ? parseInt(chatIdSetting) : this.MAIN_GROUP;

    // Generate codes and register in main bot gift code system
    const codes: Array<{ code: string; amount: number }> = [];
    const steps = (MAX_AMOUNT - MIN_AMOUNT) / STEP;

    for (let i = 0; i < COUNT; i++) {
      // Chỉ dùng ký tự rõ ràng, tránh nhầm 0↔O, 1↔I↔L
      const SAFE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
      const suffix = Array.from({ length: 6 }, () => SAFE_CHARS[Math.floor(Math.random() * SAFE_CHARS.length)]).join('');
      const code = `HARU${suffix}`;
      const amount = MIN_AMOUNT + Math.floor(Math.random() * (steps + 1)) * STEP;

      try {
        await storage.createGiftCode({
          code,
          amount: amount.toString(),
          maxUses: 1,
          isActive: true,
          createdBy: 'bot2_broadcast',
        });
        // Chỉ thêm vào danh sách nếu tạo thành công trong DB
        codes.push({ code, amount });
        console.log(`[GiftBroadcast] Created code ${code} = ${amount.toLocaleString('vi-VN')}đ`);
      } catch (err) {
        console.error(`[GiftBroadcast] Failed to create code ${code}:`, err);
        // Không thêm code lỗi vào keyboard để tránh user thấy code không tồn tại
      }
    }

    if (codes.length === 0) {
      console.error('[GiftBroadcast] No codes created successfully — aborting broadcast');
      return;
    }

    // Build message
    const now = new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' });
    const msg =
      `🎁 <b>QUÀ TẶNG ĐẶC BIỆT TỪ HARU88</b> 🎁\n` +
      `━━━━━━━━━━━━━━━━━━━━━━\n` +
      `🌟 Bot hôm nay gửi đến ${COUNT} mã quà MIỄN PHÍ!\n` +
      `⏰ Phát lúc: ${now}\n\n` +
      `📌 Mỗi code chỉ dùng được <b>1 lần</b> — ai nhanh thì được!\n` +
      `📱 Vào bot chính → nhập code để nhận thưởng ngay\n\n` +
      `👇 <b>Nhấn nút để xem code</b>\n` +
      `⚠️ Code hiển thị 1 lần — phải <b>tự gõ tay</b>, không sao chép được!`;

    // Inline buttons — ẩn số tiền để tạo yếu tố bí ẩn/may rủi
    const keyboard = codes.map((c, i) => [
      {
        text: `🎁 Mở Code ${i + 1} — May Mắn 🍀`,
        callback_data: `reveal_code_${c.code}`,
      },
    ]);

    try {
      await this.bot.sendMessage(targetChatId, msg, {
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: keyboard },
      });
      console.log(`[GiftBroadcast] ✅ Sent ${COUNT} codes to chat ${targetChatId}`);
    } catch (err) {
      console.error('[GiftBroadcast] Failed to send broadcast message:', err);
    }
  }

  /**
   * Gọi từ Admin API khi toggle bật/tắt để áp dụng ngay lập tức.
   */
  async restartGiftBroadcastScheduler(): Promise<void> {
    await this.startGiftBroadcastScheduler();
  }
}

export const telegramBot2Service = new TelegramBot2Service();