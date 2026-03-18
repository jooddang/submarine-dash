import type { Player, Platform, Item, Bubble, BackgroundEntity } from "../types";
import type { SeededRNG } from '../pvp-core/rng';

// --- Seeded RNG (canonical source: pvp-core/rng.ts) ---
export type { SeededRNG };

// --- Power-up Mode ---
export type PvpPowerUpMode = "inventory" | "earned" | "none" | "score_attack";

// --- Match Format ---
export type PvpMatchFormat = "single" | "bo3" | "bo5";

// --- Bet ---
export interface PvpBet {
  coins: number;
  dolphins: number;
  tubePieces: number;
}

// --- Match Configuration (set in lobby before game starts) ---
export interface PvpMatchConfig {
  format: PvpMatchFormat;
  powerUpMode: PvpPowerUpMode;
  betting: boolean;
  p1Bet: PvpBet;
  p2Bet: PvpBet;
  /** Auth user IDs - required only when betting or using inventory power-ups */
  p1UserId: string | null;
  p2UserId: string | null;
  p1LoginId: string | null;
  p2LoginId: string | null;
  p1SkinId: string;
  p2SkinId: string;
}

// --- Rescue state (simplified for PVP - same structure as Game.tsx) ---
export type RescuePhase = "FLY_IN" | "HOOK" | "TOW" | "COUNTDOWN";

export type PvpRescueState =
  | { active: false }
  | {
      active: true;
      phase: RescuePhase;
      phaseT: number;
      turtleX: number;
      turtleY: number;
      targetPlayerX: number;
      targetPlayerY: number;
      playerXFixed: number;
      towStartY: number;
      worldShiftApplied: number;
      hookPointX: number;
      hookPointY: number;
      countdownMs: number;
      lastCountdownDisplay: number | null;
    };

export type PvpTubeRescueState =
  | { active: false }
  | {
      active: true;
      phase: RescuePhase;
      phaseT: number;
      tubeX: number;
      tubeY: number;
      tubeRot: number;
      targetPlayerX: number;
      targetPlayerY: number;
      playerXFixed: number;
      towStartY: number;
      worldShiftApplied: number;
      countdownMs: number;
      lastCountdownDisplay: number | null;
    };

// --- Per-player mutable game state ---
export interface PvpPlayerState {
  player: Player;
  platforms: Platform[];
  items: Item[];
  bubbles: Bubble[];
  bgEntities: BackgroundEntity[];

  oxygen: number;
  speed: number;
  distance: number;
  score: number;
  gameTime: number;
  alive: boolean;
  deathCause: string | null;

  // Power-up state
  swordfishTimer: number;
  isSwordfishActive: boolean;
  turtleShellSaved: boolean;
  turtleShellUseCount: number;
  rescue: PvpRescueState;
  tubeRescue: PvpTubeRescueState;
  rescueJumpCharges: number;
  tubePieces: number;
  tubeRescueCharges: number;
  dolphinCount: number;
  dolphinUsesThisRun: number;

  // Input
  jumpInputActive: boolean;
  jumpBufferTimer: number;

  // RNG
  rng: SeededRNG;

  // Trail particles (imported type from skins)
  trailParticles: unknown[];

  // Quicksand
  quickSandTimer: number | null;
  /** Elapsed game time in ms (used for quicksand timing instead of performance.now) */
  elapsedMs: number;

  // Score Attack mode: bonus points from items
  scoreAttackBonus: number;
  /** Floating point indicators: [{text, x, y, opacity, age}] */
  scorePopups: ScorePopup[];
}

export interface ScorePopup {
  text: string;
  x: number;
  y: number;
  opacity: number;
  age: number;
}

// --- Round Result ---
export interface PvpRoundResult {
  winner: 0 | 1 | 2;
  p1Score: number;
  p2Score: number;
  p1DeathCause: string | null;
  p2DeathCause: string | null;
}

// --- Match State ---
export type PvpMatchPhase = "LOBBY" | "INSTRUCTIONS" | "COUNTDOWN" | "PLAYING" | "ROUND_RESULT" | "MATCH_RESULT";

export interface PvpMatchState {
  phase: PvpMatchPhase;
  config: PvpMatchConfig;
  roundsPlayed: number;
  p1Wins: number;
  p2Wins: number;
  roundResults: PvpRoundResult[];
  countdownValue: number;
  roundsNeeded: number; // 1 for single, 2 for bo3, 3 for bo5
}

// --- Bet Settlement (API) ---
export interface PvpSettleBetRequest {
  winnerUserId: string;
  loserUserId: string;
  bet: PvpBet;
}

export interface PvpSettleBetResponse {
  ok: boolean;
  transferred: PvpBet;
  error?: string;
}
