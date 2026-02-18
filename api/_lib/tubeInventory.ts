import { KEY_PREFIX } from './auth.js';
import type { Redis } from '@upstash/redis';

export function keyTubeState(userId: string) {
  return `${KEY_PREFIX}user:${userId}:tube`;
}

export type TubeState = {
  pieces: number;   // 0-3 (partial progress toward completing a tube)
  charges: number;  // 0-3 (completed tube rescue charges)
};

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function parseJson<T>(raw: unknown, fallback: T): T {
  if (!raw) return fallback;
  if (typeof raw === 'string') {
    try { return JSON.parse(raw) as T; } catch { return fallback; }
  }
  return raw as T;
}

const DEFAULT_TUBE_STATE: TubeState = { pieces: 0, charges: 0 };

export async function getTubeState(redis: Redis, userId: string): Promise<TubeState> {
  const raw = await redis.get(keyTubeState(userId));
  const state = parseJson<TubeState>(raw, DEFAULT_TUBE_STATE);
  return {
    pieces: clamp(state.pieces ?? 0, 0, 3),
    charges: clamp(state.charges ?? 0, 0, 3),
  };
}

export async function saveTubeState(
  redis: Redis,
  userId: string,
  pieces: number,
  charges: number
): Promise<TubeState> {
  const state: TubeState = {
    pieces: clamp(pieces, 0, 3),
    charges: clamp(charges, 0, 3),
  };
  await redis.set(keyTubeState(userId), JSON.stringify(state));
  return state;
}
