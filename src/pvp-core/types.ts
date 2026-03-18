// Core deterministic types shared between client and authority.
// No browser APIs allowed here.

export type { SeededRNG } from './rng';
export type { SimulationSideEffect } from './events';

// Re-export game-relevant types from pvpTypes for convenience
export type PvpPowerUpMode = "inventory" | "earned" | "none" | "score_attack";
export type PvpMatchFormat = "single" | "bo3" | "bo5";

export type PvpBet = {
  coins: number;
  dolphins: number;
  tubePieces: number;
};

export type SimulationInputFrame = {
  tick: number;
  jumpPressed: boolean;
  jumpHeld: boolean;
};
