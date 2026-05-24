import { logger } from "../lib/logger.js";

class Bot2Manager {
  private initialized = false;

  async initialize(botToken: string): Promise<void> {
    if (this.initialized) {
      logger.warn("Bot2Manager already initialized");
      return;
    }
    try {
      const { telegramBot2Service } = await import("./telegramBot2.js");
      await telegramBot2Service.initialize(botToken);
      this.initialized = true;
      logger.info("✅ Bot2Manager initialized");
    } catch (err) {
      logger.error({ err }, "❌ Bot2Manager initialization failed");
      throw err;
    }
  }

  isInitialized(): boolean {
    return this.initialized;
  }
}

export const bot2Manager = new Bot2Manager();
