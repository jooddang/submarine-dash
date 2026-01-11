import { KEY_PREFIX } from './auth.js';
import type { Redis } from '@upstash/redis';

export const DOLPHIN_SAVED_MAX = 5;

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
  const n = Math.max(0, Math.floor(amount));
  if (n <= 0) return 0;
  await redis.incrby(keyDolphinPending(userId), n);
  await pushDolphinLedger(redis, userId, { ts: Date.now(), type: meta.type, delta: n, meta: meta.meta });
  return n;
}

export async function settleDolphins(redis: Redis, userId: string): Promise<{ saved: number; pending: number; moved: number }> {
  const savedKey = keyDolphinSaved(userId);
  const pendingKey = keyDolphinPending(userId);

  const savedRaw = await redis.get(savedKey);
  const pendingRaw = await redis.get(pendingKey);
  const saved = Math.max(0, Math.min(DOLPHIN_SAVED_MAX, parseIntSafe(savedRaw, 0)));
  const pending = Math.max(0, parseIntSafe(pendingRaw, 0));

  const capacity = Math.max(0, DOLPHIN_SAVED_MAX - saved);
  const moved = Math.min(pending, capacity);
  if (moved > 0) {
    await redis.set(savedKey, String(saved + moved));
    await redis.set(pendingKey, String(pending - moved));
    await pushDolphinLedger(redis, userId, { ts: Date.now(), type: 'settle', delta: moved });
    return { saved: saved + moved, pending: pending - moved, moved };
  }
  // normalize any out-of-range values (best-effort)
  if (savedRaw !== String(saved)) await redis.set(savedKey, String(saved));
  if (pendingRaw !== String(pending)) await redis.set(pendingKey, String(pending));
  return { saved, pending, moved: 0 };
}

export async function consumeOneSavedDolphin(redis: Redis, userId: string): Promise<{ ok: boolean; saved: number; pending: number }> {
  // Fill saved from pending first if possible.
  const settled = await settleDolphins(redis, userId);
  if (settled.saved <= 0) return { ok: false, saved: settled.saved, pending: settled.pending };

  const savedKey = keyDolphinSaved(userId);
  const next = Math.max(0, settled.saved - 1);
  await redis.set(savedKey, String(next));
  await pushDolphinLedger(redis, userId, { ts: Date.now(), type: 'consume', delta: -1 });
  return { ok: true, saved: next, pending: settled.pending };
}

