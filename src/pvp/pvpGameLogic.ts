// Thin wrapper over pvp-core/sim that plays sounds locally for same-device PvP.
// Keeps the same export signatures so PvpGame.tsx requires no changes.

import {
  createPlayerState as coreCreatePlayerState,
  updatePlayerState as coreUpdatePlayerState,
  attemptJump as coreAttemptJump,
} from '../pvp-core/sim';
import type { SimulationSideEffect } from '../pvp-core/events';
import type { PvpPlayerState, PvpPowerUpMode } from './pvpTypes';
import type { SeededRNG } from '../pvp-core/rng';
import { playSound } from '../audio';

function applySideEffects(effects: SimulationSideEffect[]) {
  for (const e of effects) {
    if (e.type === 'PLAY_SOUND') {
      playSound(e.sound as any);
    }
  }
}

export function createPlayerState(
  rng: SeededRNG,
  canvasWidth: number,
  canvasHeight: number,
  powerUpMode: PvpPowerUpMode,
  dolphinCount: number,
  tubeCharges: number,
): PvpPlayerState {
  return coreCreatePlayerState(rng, canvasWidth, canvasHeight, powerUpMode, dolphinCount, tubeCharges);
}

export function attemptJump(s: PvpPlayerState, allowDolphin: boolean, powerUpMode: PvpPowerUpMode): boolean {
  const effects: SimulationSideEffect[] = [];
  const result = coreAttemptJump(s, allowDolphin, powerUpMode, effects);
  applySideEffects(effects);
  return result;
}

export function updatePlayerState(
  s: PvpPlayerState,
  dt: number,
  canvasWidth: number,
  canvasHeight: number,
  powerUpMode: PvpPowerUpMode,
): boolean {
  const effects: SimulationSideEffect[] = [];
  const result = coreUpdatePlayerState(s, dt, canvasWidth, canvasHeight, powerUpMode, effects);
  applySideEffects(effects);
  return result;
}
