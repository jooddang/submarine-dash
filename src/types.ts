// Game State Types
export type GameState = "MENU" | "PLAYING" | "GAME_OVER" | "INPUT_NAME";

// Player Interface
export interface Player {
  x: number;
  y: number;
  width: number;
  height: number;
  dy: number;
  grounded: boolean;
  rotation: number;
  isTrapped: boolean;
  isBoosting: boolean;
  boostTimer: number;
}

// Platform Interface
export interface Platform {
  x: number;
  y: number;
  width: number;
  height: number;
  type: "NORMAL" | "QUICKSAND";
  sinking?: boolean;
}

// Item Interface
export interface Item {
  x: number;
  y: number;
  width: number;
  height: number;
  collected: boolean;
  type: "OXYGEN" | "SWORDFISH" | "URCHIN" | "TURTLE_SHELL" | "TUBE_PIECE";
  rotation?: number;
  isDead?: boolean;
  dy?: number;
  // For multi-sprite items (e.g., tube pieces cut from a 2x2 sheet).
  variant?: number;
}

// Bubble Interface
export interface Bubble {
  x: number;
  y: number;
  size: number;
  speed: number;
  opacity: number;
  wobbleOffset: number;
}

// Background Entity Types
export type BackgroundEntityType = "FISH" | "WHALE" | "JELLYFISH" | "SHIP" | "DIVER" | "CORAL";

export interface BackgroundEntity {
  id: number;
  type: BackgroundEntityType;
  x: number;
  y: number;
  scale: number;
  speed: number;
  variant: number;
  wobbleOffset: number;
}

// Leaderboard Interface
export interface LeaderboardEntry {
  id: number;
  name: string;
  userId?: string; // loginId (shown alongside name when a custom name is used)
  score: number;
}

export type WeeklyLeaderboard = {
  weekId: string; // YYYY-MM-DD (Monday start, PST/PDT)
  startDate: string;
  endDate: string; // Sunday
  entries: LeaderboardEntry[];
};
