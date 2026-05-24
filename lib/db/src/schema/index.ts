import { pgTable, text, serial, integer, boolean, timestamp, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const botUsersTable = pgTable("bot_users", {
  id: text("id").primaryKey(),
  username: text("username"),
  firstName: text("first_name"),
  lastName: text("last_name"),
  balance: text("balance").notNull().default("0"),
  totalWagered: text("total_wagered").notNull().default("0"),
  totalGames: integer("total_games").notNull().default(0),
  vipLevel: text("vip_level"),
  commission: text("commission").notNull().default("0"),
  referralCode: text("referral_code"),
  referredBy: text("referred_by"),
  referralCount: integer("referral_count").notNull().default(0),
  referralEarnings: text("referral_earnings").notNull().default("0"),
  wageringRequirement: text("wagering_requirement").notNull().default("0"),
  wageringCompleted: text("wagering_completed").notNull().default("0"),
  isAdmin: boolean("is_admin").notNull().default(false),
  isBanned: boolean("is_banned").notNull().default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const insertBotUserSchema = createInsertSchema(botUsersTable).omit({ createdAt: true, updatedAt: true });
export type InsertBotUser = z.infer<typeof insertBotUserSchema>;
export type BotUser = typeof botUsersTable.$inferSelect;

export const transactionsTable = pgTable("transactions", {
  id: serial("id").primaryKey(),
  userId: text("user_id").notNull(),
  type: text("type").notNull(),
  amount: text("amount").notNull(),
  status: text("status").notNull().default("pending"),
  method: text("method"),
  externalId: text("external_id"),
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertTransactionSchema = createInsertSchema(transactionsTable).omit({ id: true, createdAt: true });
export type InsertTransaction = z.infer<typeof insertTransactionSchema>;
export type Transaction = typeof transactionsTable.$inferSelect;

export const gameSessionsTable = pgTable("game_sessions", {
  id: serial("id").primaryKey(),
  userId: text("user_id").notNull(),
  gameType: text("game_type").notNull(),
  betAmount: text("bet_amount").notNull(),
  betType: text("bet_type"),
  result: jsonb("result"),
  won: boolean("won"),
  winAmount: text("win_amount"),
  status: text("status").notNull().default("active"),
  metadata: jsonb("metadata"),
  completedAt: timestamp("completed_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const insertGameSessionSchema = createInsertSchema(gameSessionsTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertGameSession = z.infer<typeof insertGameSessionSchema>;
export type GameSessionRecord = typeof gameSessionsTable.$inferSelect;

export const giftCodesTable = pgTable("gift_codes", {
  id: serial("id").primaryKey(),
  code: text("code").notNull().unique(),
  amount: text("amount").notNull(),
  maxUses: integer("max_uses").notNull().default(1),
  usedCount: integer("used_count").notNull().default(0),
  isActive: boolean("is_active").notNull().default(true),
  createdBy: text("created_by"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type GiftCode = typeof giftCodesTable.$inferSelect;

export const giftCodeUsesTable = pgTable("gift_code_uses", {
  id: serial("id").primaryKey(),
  codeId: integer("code_id").notNull(),
  userId: text("user_id").notNull(),
  usedAt: timestamp("used_at").notNull().defaultNow(),
});

export const bettingStatsTable = pgTable("betting_stats", {
  id: serial("id").primaryKey(),
  userId: text("user_id").notNull(),
  date: text("date").notNull(),
  weekYear: text("week_year").notNull(),
  totalBetAmount: text("total_bet_amount").notNull().default("0"),
  gameCount: integer("game_count").notNull().default(0),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type BettingStat = typeof bettingStatsTable.$inferSelect;

export const rewardsTable = pgTable("rewards", {
  id: serial("id").primaryKey(),
  userId: text("user_id").notNull(),
  type: text("type").notNull(),
  rank: integer("rank"),
  rewardAmount: text("reward_amount").notNull(),
  date: text("date"),
  weekYear: text("week_year"),
  claimed: boolean("claimed").notNull().default(false),
  claimedAt: timestamp("claimed_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type Reward = typeof rewardsTable.$inferSelect;

export const botSettingsTable = pgTable("bot_settings", {
  id: serial("id").primaryKey(),
  key: text("key").notNull().unique(),
  value: text("value").notNull(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type BotSettings = typeof botSettingsTable.$inferSelect;

export const bankTransactionsTable = pgTable("bank_transactions", {
  id: serial("id").primaryKey(),
  refNo: text("ref_no").notNull().unique(),
  userId: text("user_id"),
  amount: text("amount").notNull(),
  description: text("description"),
  transactionDate: text("transaction_date"),
  processed: boolean("processed").notNull().default(false),
  processedAt: timestamp("processed_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type BankTransaction = typeof bankTransactionsTable.$inferSelect;

export const luckyNumbersTable = pgTable("lucky_numbers", {
  id: serial("id").primaryKey(),
  date: text("date").notNull().unique(),
  luckyNumber: integer("lucky_number").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type LuckyNumber = typeof luckyNumbersTable.$inferSelect;

export const luckyNumberClaimsTable = pgTable("lucky_number_claims", {
  id: serial("id").primaryKey(),
  userId: text("user_id").notNull(),
  date: text("date").notNull(),
  luckyNumber: integer("lucky_number").notNull(),
  rewardAmount: text("reward_amount").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type LuckyNumberClaim = typeof luckyNumberClaimsTable.$inferSelect;
export type InsertLuckyNumberClaim = typeof luckyNumberClaimsTable.$inferInsert;

export const taixiuSessionsTable = pgTable("taixiu_sessions", {
  id: serial("id").primaryKey(),
  sessionId: integer("session_id").notNull(),
  dice1: integer("dice1").notNull(),
  dice2: integer("dice2").notNull(),
  dice3: integer("dice3").notNull(),
  total: integer("total").notNull(),
  isTai: boolean("is_tai").notNull(),
  isEven: boolean("is_even").notNull(),
  md5Original: text("md5_original").notNull(),
  md5Hash: text("md5_hash").notNull(),
  totalWinnings: text("total_winnings").notNull().default("0"),
  totalLosings: text("total_losings").notNull().default("0"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type TaixiuSession = typeof taixiuSessionsTable.$inferSelect;

export const cardSubmissionsTable = pgTable("card_submissions", {
  id: serial("id").primaryKey(),
  requestId: text("request_id").notNull().unique(),
  userId: text("user_id").notNull(),
  telco: text("telco").notNull(),
  code: text("code").notNull(),
  serial: text("serial").notNull(),
  declaredAmount: integer("declared_amount").notNull(),
  status: integer("status").notNull().default(99),
  realAmount: integer("real_amount"),
  receivedAmount: integer("received_amount"),
  tsrTransId: text("tsr_trans_id"),
  message: text("message"),
  credited: boolean("credited").notNull().default(false),
  chatId: text("chat_id").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type CardSubmission = typeof cardSubmissionsTable.$inferSelect;
export type InsertCardSubmission = typeof cardSubmissionsTable.$inferInsert;

export const supportRequestsTable = pgTable("support_requests", {
  userId: text("user_id").primaryKey(),
  username: text("username"),
  firstName: text("first_name"),
  content: text("content").notNull(),
  status: text("status").notNull().default("pending"),
  isConnected: boolean("is_connected").notNull().default(false),
  requestedAt: timestamp("requested_at").notNull().defaultNow(),
});

export type SupportRequest = typeof supportRequestsTable.$inferSelect;
