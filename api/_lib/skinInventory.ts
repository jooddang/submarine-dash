import { KEY_PREFIX } from './auth.js';
import type { Redis } from '@upstash/redis';

export function keySkinOwned(userId: string) {
  return `${KEY_PREFIX}user:${userId}:skins:owned`;
}

export function keySkinEquipped(userId: string) {
  return `${KEY_PREFIX}user:${userId}:skins:equipped`;
}

const DEFAULT_SKIN_ID = 'default';

export type SkinState = {
  owned: string[];
  equipped: string;
};

export async function getSkinState(redis: Redis, userId: string): Promise<SkinState> {
  const [ownedRaw, equippedRaw] = await Promise.all([
    redis.smembers(keySkinOwned(userId)),
    redis.get(keySkinEquipped(userId)),
  ]);
  const owned = Array.isArray(ownedRaw) ? ownedRaw.map(String) : [];
  // Ensure default is always in owned list
  if (!owned.includes(DEFAULT_SKIN_ID)) owned.push(DEFAULT_SKIN_ID);
  const equipped = typeof equippedRaw === 'string' && equippedRaw ? equippedRaw : DEFAULT_SKIN_ID;
  return { owned, equipped };
}

export async function addOwnedSkin(
  redis: Redis,
  userId: string,
  skinId: string,
): Promise<void> {
  await redis.sadd(keySkinOwned(userId), skinId);
}

export async function equipSkin(
  redis: Redis,
  userId: string,
  skinId: string,
): Promise<{ ok: boolean; equipped: string }> {
  // Check ownership
  const isOwned = await redis.sismember(keySkinOwned(userId), skinId);
  // Allow default even without explicit ownership
  if (!isOwned && skinId !== DEFAULT_SKIN_ID) {
    return { ok: false, equipped: '' };
  }
  await redis.set(keySkinEquipped(userId), skinId);
  return { ok: true, equipped: skinId };
}
