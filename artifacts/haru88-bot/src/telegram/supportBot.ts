import TelegramBot from "node-telegram-bot-api";
import OpenAI from "openai";
import { storage } from "../lib/storage";
import { logger } from "../lib/logger";

interface SupportRequest {
  userId: string;
  chatId: number;
  username: string;
  firstName: string;
  content: string;
  status: "pending" | "connected" | "rejected";
  requestedAt: number;
}

interface SupportSession {
  playerUserId: string;
  playerChatId: number;
  adminChatId: number;
  connectedAt: number;
}

interface PlayerState {
  userId: string;
  chatId: number;
  aiEnabled: boolean;
  lastMessageAt: number;
  inactivityTimer?: ReturnType<typeof setTimeout>;
  conversationHistory: { role: "user" | "assistant"; content: string }[];
}

// ── OpenAI client (Replit AI Integrations proxy) — lazy init ──────
let _openai: OpenAI | null = null;
function getOpenAI(): OpenAI | null {
  if (_openai) return _openai;
  const apiKey = process.env.AI_INTEGRATIONS_OPENAI_API_KEY || process.env.OPENAI_API_KEY;
  if (!apiKey) return null;
  _openai = new OpenAI({
    baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL,
    apiKey,
  });
  return _openai;
}

const SYSTEM_PROMPT = `Bạn là trợ lý AI của Haru88 — nền tảng game online có Telegram bot.
Nhiệm vụ: trả lời câu hỏi người chơi về game, nạp/rút tiền, tài khoản. Phong cách: thân thiện, ngắn gọn, dùng emoji hợp lý. LUÔN trả lời bằng tiếng Việt.

=== GAME ===
• Tài Xỉu: tổng 3 xúc xắc ≥11 = TÀI, ≤10 = XỈU. Tỉ lệ 1.95x. Lệnh /taixiu
• Bầu Cua: 6 con (🎯Bầu 🦀Cua 🦐Tôm 🐟Cá 🐓Gà 🦌Nai), gieo 3 xúc xắc, 1 trùng=x1 2=x2 3=x3. Link web từ bot.
• Xóc Đĩa: 4 đồng xu đỏ/trắng, đoán số đỏ chẵn/lẻ, tỉ lệ 1.95x. Link web từ bot.
• Quay Thú: vòng quay may mắn, nhiều ô thưởng, có jackpot. Link web từ bot.

=== NẠP TIỀN ===
Lệnh /nap — 3 phương thức:
• Thẻ cào (Viettel/Mobi/Vina/Zing) — trừ phí theo mệnh giá
• Chuyển khoản ngân hàng — cộng tự động
• QR PayOS — quét mã là xong

=== RÚT TIỀN ===
Lệnh /rut [số tiền] — tối thiểu 50,000đ — cần đăng ký tài khoản ngân hàng — 5–30 phút.

=== CÁC LỆNH CHÍNH ===
/start /nap /rut /sd (số dư) /ref (giới thiệu) /code [mã] (gift code) /toicanhotro [vấn đề] (gặp admin)

=== QUY TẮC ===
- Chỉ trả lời về Haru88. Câu hỏi ngoài chủ đề → lịch sự từ chối và hướng về game.
- Vấn đề phức tạp (lỗi giao dịch, mất tiền, tài khoản bị khóa) → khuyên dùng /toicanhotro.
- KHÔNG bịa số liệu. KHÔNG hứa hẹn thời gian cụ thể nếu không chắc.
- Trả lời ngắn (tối đa 5–6 dòng). Nếu cần dài hơn, dùng bullet point.`;

async function getGptResponse(
  history: { role: "user" | "assistant"; content: string }[],
  newMessage: string
): Promise<string> {
  const openai = getOpenAI();
  if (!openai) return fallbackResponse(newMessage);
  try {
    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      { role: "system", content: SYSTEM_PROMPT },
      ...history.slice(-10),
      { role: "user", content: newMessage },
    ];

    const resp = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages,
      max_tokens: 400,
      temperature: 0.7,
    });

    return resp.choices[0]?.message?.content?.trim() ||
      "🤖 Xin lỗi, tôi chưa thể trả lời lúc này. Thử lại sau hoặc dùng /toicanhotro để gặp admin!";
  } catch (err) {
    logger.warn({ err }, "OpenAI call failed, falling back");
    return fallbackResponse(newMessage);
  }
}

// ── Fallback khi GPT lỗi ──────────────────────────────────────────
const FALLBACK_FAQ: { patterns: RegExp[]; answer: string }[] = [
  { patterns: [/tài xỉu|taixiu/i], answer: "🎲 <b>Tài Xỉu</b>: tổng 3 xúc xắc ≥11=TÀI, ≤10=XỈU. Tỉ lệ 1.95x. Dùng /taixiu để chơi!" },
  { patterns: [/bầu cua|bau cua/i], answer: "🦀 <b>Bầu Cua</b>: chọn 1 trong 6 con, gieo 3 xúc xắc. 1 trùng=x1, 2=x2, 3=x3. Mở link từ bot!" },
  { patterns: [/xóc đĩa|xoc dia/i], answer: "⚪🔴 <b>Xóc Đĩa</b>: 4 đồng đỏ/trắng, đoán chẵn/lẻ. Tỉ lệ 1.95x. Mở link từ bot!" },
  { patterns: [/quay thú|quay thu/i], answer: "🎡 <b>Quay Thú</b>: vòng quay nhiều ô thưởng, có jackpot. Mở link từ bot!" },
  { patterns: [/nạp|nap tien/i], answer: "💳 Dùng lệnh /nap để xem các cách nạp: thẻ cào, ngân hàng, PayOS QR." },
  { patterns: [/rút|rut tien/i], answer: "💸 Dùng lệnh /rut [số tiền]. Tối thiểu 50,000đ. Xử lý 5–30 phút." },
  { patterns: [/số dư|so du|balance/i], answer: "💎 Dùng lệnh /sd để xem số dư của bạn!" },
  { patterns: [/gift|code|giftcode/i], answer: "🎁 Dùng /code [mã_code] để đổi gift code!" },
];

function fallbackResponse(text: string): string {
  for (const faq of FALLBACK_FAQ) {
    if (faq.patterns.some(p => p.test(text))) return faq.answer;
  }
  return `🤖 Tôi đang gặp sự cố kết nối. Vui lòng thử lại sau hoặc dùng:\n<code>/toicanhotro [vấn đề của bạn]</code>\nđể được admin hỗ trợ trực tiếp.`;
}

// ─────────────────────────────────────────────────────────────────

class SupportBotService {
  private bot: TelegramBot | null = null;
  private requests: Map<string, SupportRequest> = new Map();
  private sessions: Map<string, SupportSession> = new Map();
  private playerStates: Map<string, PlayerState> = new Map();
  private adminChatIds: number[] = [];
  private typingTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();

  private get primaryAdminChatId(): number | null {
    return this.adminChatIds[0] ?? null;
  }

  private parseAdminIds(raw: string): number[] {
    return raw
      .split(",")
      .map(s => parseInt(s.trim()))
      .filter(n => !isNaN(n) && n > 0);
  }

  async reloadAdminIds(): Promise<void> {
    try {
      const raw = await storage.getSetting("support_admin_id");
      if (raw) this.adminChatIds = this.parseAdminIds(raw);
    } catch {}
  }

  async initialize(token: string): Promise<void> {
    if (this.bot) {
      try { await this.bot.stopPolling(); } catch {}
    }

    // Create bot WITHOUT auto-polling so we can validate the token first
    this.bot = new TelegramBot(token, { polling: false });

    // Validate token before starting polling — avoids infinite 401 spam
    try {
      await this.bot.getMe();
    } catch (err: any) {
      const msg: string = err?.message ?? '';
      if (msg.includes('401') || msg.includes('Unauthorized')) {
        logger.error('❌ Support bot token is invalid (401). Bot will not start.');
        this.bot = null;
        return;
      }
      throw err;
    }

    // Token is valid — register 401 guard then start polling
    this.bot.on('polling_error', (error: any) => {
      const msg: string = error?.message ?? '';
      if (msg.includes('401') || error?.response?.body?.error_code === 401) {
        logger.error('❌ Support bot got 401 Unauthorized — stopping polling.');
        this.bot?.stopPolling().catch(() => {});
      }
    });

    await this.reloadAdminIds();

    this.bot.on("message", async (msg) => {
      if (!msg.from || !msg.text) return;
      const chatId = msg.chat.id;
      const userId = msg.from.id.toString();
      const text = msg.text.trim();
      // Reload admin IDs on every message so changes take effect without restart
      await this.reloadAdminIds();
      const isAdmin = this.adminChatIds.includes(chatId);

      // ── Admin commands ──
      if (isAdmin) {
        if (text === "/rs") { await this.handleAdminReset(chatId); return; }
        const activeSession = [...this.sessions.values()].find(s => s.adminChatId === chatId);
        if (activeSession) {
          if (text === "/dung") {
            await this.handleDisconnect(activeSession.playerUserId, chatId, "admin");
            return;
          }
          await this.bot!.sendMessage(activeSession.playerChatId,
            `🛡️ <b>Admin:</b> ${text}`, { parse_mode: "HTML" });
          return;
        }
        if (text === "/start") {
          await this.bot!.sendMessage(chatId,
            `🛡️ <b>Support Bot Admin</b>\n\n` +
            `Khi người chơi dùng <code>/toicanhotro</code>, bạn sẽ nhận thông báo ngay tại đây với 2 nút:\n` +
            `• <b>✅ Kết nối ngay</b> — bắt đầu chat trực tiếp với người chơi\n` +
            `• <b>❌ Từ chối</b> — từ chối và AI tiếp tục hỗ trợ\n\n` +
            `<b>Lệnh trong phiên hỗ trợ:</b>\n` +
            `• /dung — Kết thúc phiên đang kết nối\n` +
            `• /rs — Xoá các cuộc trò chuyện đã hoàn thành\n\n` +
            `💡 Không cần vào web — mọi thứ xử lý ngay tại đây!`,
            { parse_mode: "HTML" });
          return;
        }
      }

      // ── Player commands ──
      if (text.startsWith("/start")) {
        await this.handleStart(chatId, userId, msg.from.username, msg.from.first_name);
        return;
      }
      if (text.startsWith("/help")) {
        await this.handleHelp(chatId);
        return;
      }

      const toiCanHotroMatch = text.match(/^\/toicanhotro(?:\s+([\s\S]+))?$/i);
      if (toiCanHotroMatch) {
        const content = toiCanHotroMatch[1]?.trim() || "";
        await this.handleSupportRequest(chatId, userId, msg.from.username ?? "", msg.from.first_name ?? "", content);
        return;
      }

      // ── Active session: forward to admin ──
      const session = this.sessions.get(userId);
      if (session) {
        this.refreshInactivity(userId);
        const playerName = msg.from.first_name || userId;
        try {
          await this.bot!.sendMessage(session.adminChatId,
            `👤 <b>${playerName}</b> (ID: <code>${userId}</code>):\n${text}`,
            { parse_mode: "HTML" });
        } catch {}
        return;
      }

      // ── AI mode ──
      const state = this.getOrCreateState(userId, chatId);
      if (!state.aiEnabled) return;
      this.refreshInactivity(userId);

      // Show typing indicator
      try { await this.bot!.sendChatAction(chatId, "typing"); } catch {}

      const aiReply = await getGptResponse(state.conversationHistory, text);

      // Update conversation history
      state.conversationHistory.push({ role: "user", content: text });
      state.conversationHistory.push({ role: "assistant", content: aiReply });
      if (state.conversationHistory.length > 20) {
        state.conversationHistory = state.conversationHistory.slice(-20);
      }

      await this.bot!.sendMessage(chatId, aiReply, {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [[
            { text: "🙋 Cần hỗ trợ từ admin", callback_data: "request_support" }
          ]]
        }
      });
    });

    this.bot.on("callback_query", async (query) => {
      if (!query.from || !query.message) return;
      const chatId = query.message.chat.id;
      const msgId = query.message.message_id;
      await this.bot!.answerCallbackQuery(query.id);

      if (query.data === "request_support") {
        await this.bot!.sendMessage(chatId,
          `🙋 <b>Yêu cầu hỗ trợ admin</b>\n\nDùng lệnh:\n<code>/toicanhotro [mô tả vấn đề]</code>\n\nVí dụ:\n<code>/toicanhotro Tôi không rút được tiền</code>`,
          { parse_mode: "HTML" });
        return;
      }

      // ── Admin: kết nối trực tiếp từ Telegram ──────────────────────────────
      if (query.data?.startsWith("sup_connect_")) {
        await this.reloadAdminIds();
        if (!this.adminChatIds.includes(chatId)) return; // Only allow admins
        const targetUserId = query.data.replace("sup_connect_", "");
        const result = await this.adminConnectFromTelegram(targetUserId, chatId);
        try {
          await this.bot!.editMessageText(
            result.ok
              ? `✅ <b>Đã kết nối!</b> Bạn đang chat trực tiếp với người chơi.\n\nGõ tin nhắn để hỗ trợ.\nDùng <code>/dung</code> để kết thúc phiên.`
              : `❌ ${result.message}`,
            { chat_id: chatId, message_id: msgId, parse_mode: "HTML" }
          );
        } catch {}
        return;
      }

      if (query.data?.startsWith("sup_reject_")) {
        await this.reloadAdminIds();
        if (!this.adminChatIds.includes(chatId)) return;
        const targetUserId = query.data.replace("sup_reject_", "");
        await this.adminReject(targetUserId);
        try {
          await this.bot!.editMessageText(
            `❌ <b>Đã từ chối yêu cầu hỗ trợ.</b>`,
            { chat_id: chatId, message_id: msgId, parse_mode: "HTML" }
          );
        } catch {}
        return;
      }
    });

    // Start polling now that all handlers are registered
    await this.bot.startPolling();
    logger.info("✅ Support bot (GPT-powered) started");
  }

  private getOrCreateState(userId: string, chatId: number): PlayerState {
    if (!this.playerStates.has(userId)) {
      const state: PlayerState = {
        userId, chatId,
        aiEnabled: true,
        lastMessageAt: Date.now(),
        conversationHistory: [],
      };
      this.playerStates.set(userId, state);
      this.scheduleInactivity(state);
    }
    return this.playerStates.get(userId)!;
  }

  private scheduleInactivity(state: PlayerState) {
    if (state.inactivityTimer) clearTimeout(state.inactivityTimer);
    state.inactivityTimer = setTimeout(async () => {
      if (!this.bot || !state.aiEnabled) return;
      if (this.sessions.has(state.userId)) return;
      try {
        await this.bot.sendMessage(state.chatId,
          `⏰ Bạn có cần hỗ trợ thêm không?`,
          {
            reply_markup: {
              inline_keyboard: [[
                { text: "✅ Có", callback_data: "need_help_yes" },
                { text: "❌ Không, cảm ơn", callback_data: "need_help_no" }
              ]]
            }
          });
      } catch {}
    }, 90_000);
  }

  private refreshInactivity(userId: string) {
    const state = this.playerStates.get(userId);
    if (!state) return;
    state.lastMessageAt = Date.now();
    this.scheduleInactivity(state);
  }

  private async handleStart(chatId: number, userId: string, username?: string, firstName?: string) {
    if (!this.bot) return;
    const state = this.getOrCreateState(userId, chatId);
    // Reset conversation on /start
    state.conversationHistory = [];
    await this.bot.sendMessage(chatId,
      `👋 <b>Xin chào${firstName ? ` ${firstName}` : ""}!</b>\n\n` +
      `🤖 Tôi là <b>AI Hỗ Trợ Haru88</b> — được trang bị trí tuệ nhân tạo GPT!\n\n` +
      `Tôi có thể giải đáp mọi thắc mắc về:\n` +
      `🎲 Tài Xỉu · 🦀 Bầu Cua · ⚪ Xóc Đĩa · 🎡 Quay Thú\n` +
      `💳 Nạp tiền · 💸 Rút tiền · 🎁 Gift code · 👥 Giới thiệu\n\n` +
      `Cứ hỏi tự nhiên bằng tiếng Việt nhé!\n\n` +
      `Cần hỗ trợ trực tiếp từ admin? Dùng:\n<code>/toicanhotro [vấn đề của bạn]</code>`,
      { parse_mode: "HTML" });
  }

  private async handleHelp(chatId: number) {
    if (!this.bot) return;
    await this.bot.sendMessage(chatId,
      `📋 <b>Hướng Dẫn</b>\n\n` +
      `<b>Lệnh hữu ích:</b>\n` +
      `• /start — Bắt đầu lại\n` +
      `• /help — Xem hướng dẫn\n` +
      `• /toicanhotro [nội dung] — Gặp admin trực tiếp\n\n` +
      `<b>Tính năng AI:</b>\n` +
      `Hỏi bất kỳ câu nào về Haru88 — AI sẽ trả lời tự nhiên và ghi nhớ cuộc trò chuyện!\n\n` +
      `💡 Ví dụ: "Tôi chơi bầu cua thế nào?", "Nạp thẻ cào bị trừ phí bao nhiêu?"`,
      { parse_mode: "HTML" });
  }

  private async handleSupportRequest(chatId: number, userId: string, username: string, firstName: string, content: string) {
    if (!this.bot) return;

    if (this.sessions.has(userId)) {
      await this.bot.sendMessage(chatId, "⚠️ Bạn đang trong phiên hỗ trợ. Gõ /dung để kết thúc.");
      return;
    }

    const existing = this.requests.get(userId);
    if (existing && existing.status === "pending") {
      await this.bot.sendMessage(chatId, `⏳ Yêu cầu của bạn đang chờ admin xác nhận.`);
      return;
    }

    if (!content) {
      await this.bot.sendMessage(chatId,
        `📝 Vui lòng thêm nội dung:\n<code>/toicanhotro [mô tả vấn đề]</code>\n\nVí dụ:\n<code>/toicanhotro Không rút được tiền về ngân hàng</code>`,
        { parse_mode: "HTML" });
      return;
    }

    const request: SupportRequest = {
      userId, chatId,
      username: username || userId,
      firstName: firstName || "Người chơi",
      content, status: "pending",
      requestedAt: Date.now()
    };
    this.requests.set(userId, request);

    await this.bot.sendMessage(chatId,
      `✅ <b>Đã gửi yêu cầu hỗ trợ!</b>\n\n📝 Nội dung: <i>${content}</i>\n\n⏳ Chờ admin xác nhận. AI vẫn có thể trả lời các câu hỏi khác của bạn!`,
      { parse_mode: "HTML" });

    // Notify ALL admin IDs — with inline buttons to connect/reject directly in Telegram
    for (const adminId of this.adminChatIds) {
      try {
        await this.bot.sendMessage(adminId,
          `🔔 <b>Yêu cầu hỗ trợ mới!</b>\n\n` +
          `👤 <b>${firstName}</b> (@${username})\n` +
          `🆔 ID: <code>${userId}</code>\n` +
          `📝 <i>${content || "Không có mô tả"}</i>`,
          {
            parse_mode: "HTML",
            reply_markup: {
              inline_keyboard: [[
                { text: "✅ Kết nối ngay", callback_data: `sup_connect_${userId}` },
                { text: "❌ Từ chối", callback_data: `sup_reject_${userId}` },
              ]]
            }
          });
      } catch {}
    }
  }

  // ── Admin API ─────────────────────────────────────────────────────

  /** Kết nối từ Admin Panel web (dùng primaryAdminChatId) */
  async adminConnect(playerUserId: string): Promise<{ ok: boolean; message: string }> {
    return this.adminConnectFromTelegram(playerUserId, this.primaryAdminChatId ?? 0);
  }

  /** Kết nối từ nút Telegram — biết chính xác adminChatId nào đang kết nối */
  async adminConnectFromTelegram(playerUserId: string, adminChatId: number): Promise<{ ok: boolean; message: string }> {
    if (!this.bot) return { ok: false, message: "Bot chưa khởi động" };
    const request = this.requests.get(playerUserId);
    if (!request) return { ok: false, message: "Yêu cầu không còn tồn tại (có thể đã bị từ chối)" };
    if (this.sessions.has(playerUserId)) return { ok: false, message: "Người chơi đang trong phiên hỗ trợ khác" };

    request.status = "connected";
    const session: SupportSession = {
      playerUserId,
      playerChatId: request.chatId,
      adminChatId,
      connectedAt: Date.now()
    };
    this.sessions.set(playerUserId, session);

    const state = this.playerStates.get(playerUserId);
    if (state) { state.aiEnabled = false; if (state.inactivityTimer) clearTimeout(state.inactivityTimer); }

    try {
      await this.bot.sendMessage(request.chatId,
        `✅ <b>Admin đã kết nối!</b>\n\nBạn đang được hỗ trợ trực tiếp.\nGõ tin nhắn để nói chuyện với admin.\nDùng /dung để kết thúc phiên hỗ trợ.`,
        { parse_mode: "HTML" });
    } catch {}

    return { ok: true, message: "Đã kết nối" };
  }

  async adminDisconnect(playerUserId: string): Promise<{ ok: boolean; message: string }> {
    await this.handleDisconnect(playerUserId, this.primaryAdminChatId ?? 0, "admin");
    return { ok: true, message: "Đã ngắt kết nối" };
  }

  async adminReject(playerUserId: string): Promise<{ ok: boolean; message: string }> {
    if (!this.bot) return { ok: false, message: "Bot chưa khởi động" };
    const request = this.requests.get(playerUserId);
    if (!request) return { ok: false, message: "Không tìm thấy yêu cầu" };

    request.status = "rejected";
    this.requests.delete(playerUserId);

    try {
      await this.bot.sendMessage(request.chatId,
        `❌ Admin hiện không có sẵn.\n\nAI sẽ tiếp tục hỗ trợ bạn. Thử hỏi lại bất cứ lúc nào!`);
      const state = this.playerStates.get(playerUserId);
      if (state) { state.aiEnabled = true; this.scheduleInactivity(state); }
    } catch {}

    return { ok: true, message: "Đã từ chối" };
  }

  private async handleDisconnect(playerUserId: string, _adminChatId: number, initiator: "admin" | "player") {
    if (!this.bot) return;
    const session = this.sessions.get(playerUserId);
    this.sessions.delete(playerUserId);
    this.requests.delete(playerUserId);

    const state = this.playerStates.get(playerUserId);
    if (state) { state.aiEnabled = true; this.scheduleInactivity(state); }

    if (session) {
      try {
        await this.bot.sendMessage(session.playerChatId,
          initiator === "admin"
            ? `⚠️ Admin đã kết thúc phiên hỗ trợ.\n🤖 AI sẽ tiếp tục hỗ trợ bạn!`
            : `✅ Đã kết thúc phiên hỗ trợ. Cảm ơn bạn! 🙏`);
      } catch {}
      try {
        await this.bot.sendMessage(session.adminChatId, `✅ Đã ngắt kết nối với người chơi ${playerUserId}.`);
      } catch {}
    }
  }

  private async handleAdminReset(chatId: number) {
    if (!this.bot) return;
    const pending = new Map<string, SupportRequest>();
    for (const [id, req] of this.requests.entries()) {
      if (req.status === "pending") pending.set(id, req);
    }
    const cleared = this.requests.size - pending.size;
    this.requests = pending;
    await this.bot.sendMessage(chatId, `✅ Đã xoá ${cleared} cuộc trò chuyện. Còn ${pending.size} đang chờ.`);
  }

  getPendingRequests(): SupportRequest[] {
    return [...this.requests.values()].filter(r => r.status === "pending");
  }

  getAllRequests(): SupportRequest[] {
    return [...this.requests.values()];
  }

  isConnected(playerUserId: string): boolean {
    return this.sessions.has(playerUserId);
  }

  async stop() {
    if (this.bot) {
      try { await this.bot.stopPolling(); } catch {}
      this.bot = null;
    }
  }
}

export const supportBotService = new SupportBotService();
