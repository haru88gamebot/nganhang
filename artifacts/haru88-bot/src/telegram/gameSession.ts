/**
 * GameSessionManager — server-side game clock
 * All players on any game share the same phase/timer/result from this singleton.
 * Supported games: bau-cua, xoc-dia, quay-thu, dua-xe
 */

export type GameId = "bau-cua" | "xoc-dia" | "quay-thu" | "dua-xe";

export interface GameState {
  round: number;
  phase: "betting" | "rolling" | "result";
  phaseEnd: number;
  result?: Record<string, unknown>;
}

export interface GameStateView extends GameState {
  remaining: number;
}

const CONFIGS: Record<GameId, { bettingMs: number; resultMs: number }> = {
  "bau-cua": { bettingMs: 30_000, resultMs: 8_000 },
  "xoc-dia": { bettingMs: 20_000, resultMs: 7_000 },
  "quay-thu": { bettingMs: 25_000, resultMs: 8_000 },
  "dua-xe": { bettingMs: 20_000, resultMs: 10_000 },
};

const BAU_CUA_ANIMALS = ["nai", "tom", "ga", "bau", "ca", "cua"] as const;

const QUAY_THU_WEIGHTS: Record<string, number> = {
  Yến: 14, "Bồ Câu": 11, "Gấu Trúc": 10, Khỉ: 10,
  Thỏ: 13, Công: 10, Hổ: 7, "Đại Bàng": 6,
  "Cá Mập Xanh": 4, "Cá Mập Vàng": 2, Rương: 2, Bom: 11,
};

function weightedPick(weights: Record<string, number>): string {
  const total = Object.values(weights).reduce((a, b) => a + b, 0);
  let r = Math.random() * total;
  for (const [name, w] of Object.entries(weights)) {
    r -= w;
    if (r <= 0) return name;
  }
  return Object.keys(weights)[0]!;
}

function generateResult(game: GameId): Record<string, unknown> {
  switch (game) {
    case "bau-cua":
      return {
        dice: [
          BAU_CUA_ANIMALS[Math.floor(Math.random() * 6)],
          BAU_CUA_ANIMALS[Math.floor(Math.random() * 6)],
          BAU_CUA_ANIMALS[Math.floor(Math.random() * 6)],
        ],
      };
    case "xoc-dia": {
      const coins = Array.from({ length: 4 }, () =>
        Math.random() < 0.5 ? "red" : "white"
      );
      return { coins, redCount: coins.filter((c) => c === "red").length };
    }
    case "quay-thu":
      return { winner: weightedPick(QUAY_THU_WEIGHTS) };
    case "dua-xe": {
      return { winner: Math.floor(Math.random() * 8) + 1 };
    }
    default:
      return {};
  }
}

class GameSessionManager {
  private states = new Map<GameId, GameState>();
  private timers = new Map<GameId, ReturnType<typeof setTimeout>>();

  constructor() {
    for (const game of Object.keys(CONFIGS) as GameId[]) {
      this.initGame(game);
    }
  }

  getState(game: GameId): GameStateView {
    const state = this.states.get(game) ?? this.initGame(game);
    const remaining = Math.max(0, Math.ceil((state.phaseEnd - Date.now()) / 1000));
    return { ...state, remaining };
  }

  getAllStates(): Record<string, GameStateView> {
    const out: Record<string, GameStateView> = {};
    for (const game of Object.keys(CONFIGS) as GameId[]) {
      out[game] = this.getState(game);
    }
    return out;
  }

  private initGame(game: GameId): GameState {
    const cfg = CONFIGS[game];
    const state: GameState = {
      round: 1,
      phase: "betting",
      phaseEnd: Date.now() + cfg.bettingMs,
    };
    this.states.set(game, state);
    this.schedule(game);
    return state;
  }

  private schedule(game: GameId) {
    const old = this.timers.get(game);
    if (old) clearTimeout(old);

    const state = this.states.get(game)!;
    const cfg = CONFIGS[game];
    const delay = Math.max(0, state.phaseEnd - Date.now());

    const t = setTimeout(() => {
      if (state.phase === "betting") {
        state.result = generateResult(game);
        state.phase = "rolling";
        state.phaseEnd = Date.now() + cfg.resultMs;
      } else {
        state.phase = "betting";
        state.result = undefined;
        state.round++;
        state.phaseEnd = Date.now() + cfg.bettingMs;
      }
      this.schedule(game);
    }, delay);

    this.timers.set(game, t);
  }
}

export const gameSession = new GameSessionManager();
