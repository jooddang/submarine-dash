import { KEY_PREFIX } from './auth.js';
import type { Redis } from '@upstash/redis';

export function keyDolphinSaved(userId: string) {
  return `${KEY_PREFIX}user:${userId}:dolphin:saved`;
}
export function keyDolphinPending(userId: string) {
  return `${KEY_PREFIX}user:${userId}:dolphin:pending`;
}
export function keyDolphinLedger(userId: string) {
  return `${KEY_PREFIX}user:${userId}:dolphin:ledger`;
}
export function keyDolphinStreakLastAwarded(userId: string) {
  return `${KEY_PREFIX}user:${userId}:reward:dolphin:streak:lastAwarded`;
}
export function keyLegacyDolphinGrant(userId: string) {
  // Back-compat: older manual grant mechanism.
  return `${KEY_PREFIX}reward:dolphin:grant:${userId}`;
}

function parseIntSafe(raw: unknown, fallback = 0): number {
  if (raw === null || raw === undefined) return fallback;
  const n = Number.parseInt(String(raw), 10);
  return Number.isFinite(n) ? n : fallback;
}

export async function pushDolphinLedger(
  redis: Redis,
  userId: string,
  entry: { ts: number; type: string; delta: number; meta?: Record<string, unknown> }
) {
  const key = keyDolphinLedger(userId);
  const line = JSON.stringify(entry);
  await redis.lpush(key, line);
  // keep it bounded (best-effort)
  await redis.ltrim(key, 0, 99);
}

export async function addPendingDolphins(
  redis: Redis,
  userId: string,
  amount: number,
  meta: { type: string; meta?: Record<string, unknown> }
) {
  return addSavedDolphins(redis, userId, amount, meta);
}

export async function addSavedDolphins(
  redis: Redis,
  userId: string,
  amount: number,
  meta: { type: string; meta?: Record<string, unknown> }
) {
  const n = Math.max(0, Math.floor(amount));
  if (n <= 0) return 0;
  await redis.incrby(keyDolphinSaved(userId), n);
  await pushDolphinLedger(redis, userId, { ts: Date.now(), type: meta.type, delta: n, meta: meta.meta });
  return n;
}

export async function migratePendingDolphins(
  redis: Redis,
  userId: string
): Promise<{ saved: number; moved: number }> {
  const savedKey = keyDolphinSaved(userId);
  const pendingKey = keyDolphinPending(userId);

  const savedRaw = await redis.get(savedKey);
  const pendingRaw = await redis.get(pendingKey);
  const saved = Math.max(0, parseIntSafe(savedRaw, 0));
  const pending = Math.max(0, parseIntSafe(pendingRaw, 0));

  if (pending > 0) {
    const nextSaved = saved + pending;
    await redis.set(savedKey, String(nextSaved));
    await redis.set(pendingKey, '0');
    await pushDolphinLedger(redis, userId, { ts: Date.now(), type: 'migratePending', delta: pending });
    return { saved: nextSaved, moved: pending };
  }

  if (savedRaw !== String(saved)) await redis.set(savedKey, String(saved));
  if (pendingRaw !== String(pending)) await redis.set(pendingKey, String(pending));
  return { saved, moved: 0 };
}

export async function getSavedDolphins(redis: Redis, userId: string): Promise<number> {
  const savedRaw = await redis.get(keyDolphinSaved(userId));
  return Math.max(0, parseIntSafe(savedRaw, 0));
}

export async function consumeOneSavedDolphin(redis: Redis, userId: string): Promise<{ ok: boolean; saved: number }> {
  await migratePendingDolphins(redis, userId);
  const savedKey = keyDolphinSaved(userId);
  const savedRaw = await redis.get(savedKey);
  const saved = Math.max(0, parseIntSafe(savedRaw, 0));
  if (saved <= 0) return { ok: false, saved };

  const next = saved - 1;
  await redis.set(savedKey, String(next));
  await pushDolphinLedger(redis, userId, { ts: Date.now(), type: 'consume', delta: -1 });
  return { ok: true, saved: next };
}

