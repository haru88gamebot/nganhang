import { createServer } from "http";
import { WebSocketServer } from "ws";
import app from "./app";
import { logger } from "./lib/logger";
import { telegramBotService } from "./telegram/telegramBot";
import { telegramBot2Service } from "./telegram/telegramBot2";
import { supportBotService } from "./telegram/supportBot";
import { bankService } from "./telegram/bankService";
import { setupGameWebSocket } from "./lib/gameServer";
import { startCrashGame } from "./lib/crashGame";
import { getSetting } from "./lib/settings";
import { setWebGameNotify } from "./lib/webGameLock";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error("PORT environment variable is required but was not provided.");
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

const httpServer = createServer(app);

const gameWss = new WebSocketServer({ noServer: true });
setupGameWebSocket(gameWss);

httpServer.on("upgrade", (req, socket, head) => {
  const url = req.url || "";
  const wsBase = (process.env.API_BASE_PATH ?? "/api") + "/games/ws";
  if (url.startsWith(wsBase)) {
    gameWss.handleUpgrade(req, socket, head, (ws) => {
      gameWss.emit("connection", ws, req);
    });
  } else {
    socket.destroy();
  }
});

httpServer.listen(port, async () => {
  logger.info({ port }, "Server listening");

  const botToken = await getSetting("bot_token");
  if (botToken) {
    try {
      await telegramBotService.initialize(botToken);
      // Wire up web game result notifications via Telegram bot
      setWebGameNotify(async (tgId, msg) => {
        await telegramBotService.sendNotification(tgId, msg);
      });
      logger.info("✅ Telegram bot (Bot1) started");
    } catch (err) {
      logger.error({ err }, "❌ Failed to start Telegram bot");
    }
  } else {
    logger.warn("bot_token not set — Telegram bot will not start. Set it in Admin Panel → Cài đặt.");
  }

  const bot2Token = await getSetting("bot2_token");
  if (bot2Token) {
    try {
      await telegramBot2Service.initialize(bot2Token);
      logger.info("✅ Bot2 (Tài Xỉu Room) started");
    } catch (err) {
      logger.error({ err }, "❌ Failed to start Bot2");
    }
  } else {
    logger.warn("bot2_token not set — Bot2 will not start.");
  }

  const supportBotToken = await getSetting("support_bot_token");
  if (supportBotToken) {
    try {
      await supportBotService.initialize(supportBotToken);
      logger.info("✅ Support bot (Bot3) started");
    } catch (err) {
      logger.error({ err }, "❌ Failed to start Support bot");
    }
  } else {
    logger.warn("support_bot_token not set — Support bot will not start.");
  }

  // Load bank account info from DB settings (needed for QR generation)
  try {
    await bankService.loadAccountInfoFromSettings();
    logger.info("✅ Bank account info loaded from settings");
  } catch (err) {
    logger.warn({ err }, "⚠️ Could not load bank account info — set bank_account_number in Admin Settings");
  }

  startCrashGame();
});

const shutdown = async () => {
  logger.info("Shutting down...");
  await telegramBotService.stop();
  httpServer.close(() => {
    logger.info("Server closed");
    process.exit(0);
  });
};

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

// Prevent Telegram 429 / other unhandled rejections from killing the process
process.on("unhandledRejection", (reason) => {
  logger.error({ reason }, "⚠️ Unhandled Promise rejection — caught at process level, server continues");
});

process.on("uncaughtException", (err) => {
  logger.error({ err }, "⚠️ Uncaught Exception — caught at process level, server continues");
});
