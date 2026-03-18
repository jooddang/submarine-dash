import { getUpstashRedisClient } from './redis.js';

const LOBBY_KEY = 'sd:pvp:lobby:online';
const PRESENCE_PREFIX = 'sd:pvp:presence:';
const MEMBERSHIP_PREFIX = 'sd:pvp:room-membership:';
const PRESENCE_TTL = 30; // seconds

export type PvpPresence = {
  userId: string;
  loginId: string;
  status: string;
  roomId: string | null;
  matchId: string | null;
  enteredLobbyAt: number | null;
  lastSeenAt: number;
};

export async function enterLobby(userId: string, loginId: string): Promise<void> {
  const redis = getUpstashRedisClient(false);
  const now = Date.now();
  const presence: PvpPresence = {
    userId,
    loginId,
    status: 'IN_PVP_LOBBY',
    roomId: null,
    matchId: null,
    enteredLobbyAt: now,
    lastSeenAt: now,
  };
  await redis.set(PRESENCE_PREFIX + userId, JSON.stringify(presence), { ex: PRESENCE_TTL });
  await redis.sadd(LOBBY_KEY, userId);
}

export async function leaveLobby(userId: string): Promise<void> {
  const redis = getUpstashRedisClient(false);
  await redis.del(PRESENCE_PREFIX + userId);
  await redis.srem(LOBBY_KEY, userId);
}

export async function refreshPresence(userId: string): Promise<void> {
  const redis = getUpstashRedisClient(false);
  const raw = await redis.get<string>(PRESENCE_PREFIX + userId);
  if (!raw) return;
  try {
    const parsed: PvpPresence = typeof raw === 'string' ? JSON.parse(raw) : raw;
    parsed.lastSeenAt = Date.now();
    await redis.set(PRESENCE_PREFIX + userId, JSON.stringify(parsed), { ex: PRESENCE_TTL });
  } catch {
    // skip
  }
}

export async function getLobbyUsers(): Promise<PvpPresence[]> {
  const redis = getUpstashRedisClient(true);
  const userIds = await redis.smembers(LOBBY_KEY);
  if (!userIds || userIds.length === 0) return [];

  const results: PvpPresence[] = [];
  const stale: string[] = [];
  for (const uid of userIds) {
    const membership = await redis.get<string>(MEMBERSHIP_PREFIX + uid);
    if (membership) {
      stale.push(uid);
      continue;
    }
    const raw = await redis.get<string>(PRESENCE_PREFIX + uid);
    if (!raw) {
      stale.push(uid);
      continue;
    }
    try {
      const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
      results.push(parsed);
    } catch {
      stale.push(uid);
    }
  }
  // Clean up stale entries (presence TTL expired but SET entry remains)
  if (stale.length > 0) {
    const rw = getUpstashRedisClient(false);
    for (const uid of stale) {
      await rw.srem(LOBBY_KEY, uid);
    }
  }
  return results;
}
