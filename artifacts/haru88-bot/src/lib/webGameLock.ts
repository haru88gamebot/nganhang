/**
 * webGameLock — tracks users currently in an active web game session.
 *
 * When a user bets in a web game (crash / bau-cua):
 *   1. Their account is "locked" — bot rejects withdrawal/transfer commands.
 *   2. When the round ends (win or lose), the lock is released and a Telegram
 *      notification is sent with the result.
 *
 * globalPendingBets — shared cross-game pending balance tracker.
 *   Prevents double-spending when the user has multiple game tabs open.
 *   Games that use staged bets (baucua, xocdia, quaythu) register pending amounts
 *   here when a bet is placed and release them when the round resolves.
 *   Games that deduct immediately (crash) only READ this map to block overbetting.
 *
 * balanceBroadcast — shared real-time balance sync across ALL web games.
 *   Any game (gameServer SSE or crashGame SSE) can call broadcastBalance(tgId, balance)
 *   and ALL registered listeners (from all game modules) will push balance_update to
 *   their connected clients for that user. This ensures a user playing multiple games
 *   simultaneously always sees the same up-to-date balance across all tabs.
 */

type NotifyFn = (tgId: string, msg: string) => Promise<void>;
type BalanceFn = (tgId: string, balance: number) => void;

export interface WebGameSession {
  game: string;
  betAmount: number;
  startedAt: number;
}

// ─── Active sessions (for bot withdrawal lock) ───────────────────────────────

const activeSessions = new Map<string, WebGameSession>();
let _notify: NotifyFn = async () => {};

/** Register the Telegram notify callback (called once on bot startup). */
export function setWebGameNotify(fn: NotifyFn) {
  _notify = fn;
}

/** Lock a user — they are now in an active web game round. */
export function webGameLock(tgId: string, game: string, betAmount: number) {
  activeSessions.set(tgId, { game, betAmount, startedAt: Date.now() });
}

/** Get the current active web game session for a user (null if none). */
export function getWebGameSession(tgId: string): WebGameSession | null {
  return activeSessions.get(tgId) ?? null;
}

/**
 * Resolve the game: unlock the user and send a Telegram result notification.
 * Safe to call even if user has no active session (no-op).
 */
export async function webGameResolve(tgId: string, message: string) {
  activeSessions.delete(tgId);
  try {
    await _notify(tgId, message);
  } catch {
    // Silent — user may have blocked bot or disconnected
  }
}

/**
 * Send a Telegram notification to a user without touching active sessions.
 * Used by gameServer to send bet confirmations and game results.
 */
export async function sendBotNotify(tgId: string, message: string): Promise<void> {
  try {
    await _notify(tgId, message);
  } catch {
    // Silent
  }
}

// ─── Global Pending Bets (cross-game double-spend prevention) ─────────────────
//
// Tracks the total amount of STAGED bets per user across all SSE game rooms
// (baucua, xocdia, quaythu). These games deduct from DB only on round end.
// The crash game deducts immediately, so it only needs to READ this map.
//
// Rule: availableBalance = DB.balance - getPendingBets(tgId)
//   → Both staged-bet games and crash enforce this before accepting a bet.
//   → Staged-bet games call addPendingBet on success, reducePendingBet on resolve.
//   → Crash does NOT call add/reduce (it deducts from DB directly).

const _globalPendingBets = new Map<string, number>();

/** Get total pending (staged, not yet DB-deducted) bets for a user. */
export function getPendingBets(tgId: string): number {
  return _globalPendingBets.get(tgId) || 0;
}

/** Add to a user's global pending bets (call after staged-bet accepted). */
export function addPendingBet(tgId: string, amount: number): void {
  _globalPendingBets.set(tgId, (_globalPendingBets.get(tgId) || 0) + amount);
}

/** Reduce a user's global pending bets (call after DB is updated on resolve). */
export function reducePendingBet(tgId: string, amount: number): void {
  const next = Math.max(0, (_globalPendingBets.get(tgId) || 0) - amount);
  if (next === 0) _globalPendingBets.delete(tgId);
  else _globalPendingBets.set(tgId, next);
}

// ─── Shared Balance Broadcast (cross-game real-time balance sync) ─────────────
//
// Each game module registers a listener here. When any game updates a user's
// balance (bet placed, round resolved, cashout), it calls broadcastBalance() and
// ALL registered listeners push { type: "balance_update", balance } to that
// user's SSE connection — no matter which game tab they have open.

const _balanceListeners: BalanceFn[] = [];

/**
 * Register a balance update listener.
 * Called once per game module at startup (gameServer, crashGame).
 * The listener receives (tgId, balance) and should push balance_update SSE
 * to that user's connected client for this game type.
 */
export function registerBalanceListener(fn: BalanceFn): void {
  _balanceListeners.push(fn);
}

/**
 * Broadcast a balance update to ALL registered game listeners for a user.
 * Call this whenever a user's balance changes due to any web game action.
 */
export function broadcastBalance(tgId: string, balance: number): void {
  for (const fn of _balanceListeners) {
    try { fn(tgId, balance); } catch {}
  }
}
