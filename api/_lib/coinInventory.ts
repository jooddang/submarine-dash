import { KEY_PREFIX } from './auth.js';
import type { Redis } from '@upstash/redis';

export function keyCoinBalance(userId: string) {
  return `${KEY_PREFIX}user:${userId}:coins`;
}

export function keyCoinLedger(userId: string) {
  return `${KEY_PREFIX}user:${userId}:coin:ledger`;
}

function parseIntSafe(raw: unknown, fallback = 0): number {
  if (raw === null || raw === undefined) return fallback;
  const n = Number.parseInt(String(raw), 10);
  return Number.isFinite(n) ? n : fallback;
}

async function pushCoinLedger(
  redis: Redis,
  userId: string,
  entry: { ts: number; type: string; delta: number; meta?: Record<string, unknown> }
) {
  const key = keyCoinLedger(userId);
  const line = JSON.stringify(entry);
  await redis.lpush(key, line);
  await redis.ltrim(key, 0, 99);
}

export async function getCoinBalance(redis: Redis, userId: string): Promise<number> {
  const raw = await redis.get(keyCoinBalance(userId));
  return Math.max(0, parseIntSafe(raw, 0));
}

export async function addCoins(
  redis: Redis,
  userId: string,
  amount: number,
  meta: { type: string; meta?: Record<string, unknown> }
): Promise<number> {
  const n = Math.max(0, Math.floor(amount));
  if (n <= 0) return await getCoinBalance(redis, userId);
  await redis.incrby(keyCoinBalance(userId), n);
  await pushCoinLedger(redis, userId, { ts: Date.now(), type: meta.type, delta: n, meta: meta.meta });
  return await getCoinBalance(redis, userId);
}

/**
 * Score-bracket coin earning formula.
 * Returns the number of coins earned for a given run score.
 */
export function computeCoinsForScore(score: number): number {
  if (score < 500) return 0;
  if (score < 1000) return 5;
  if (score < 3000) return 10;
  if (score < 5000) return 20;
  if (score < 7000) return 35;
  if (score < 9000) return 50;
  return 75;
}
