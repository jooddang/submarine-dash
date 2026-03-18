import crypto from 'node:crypto';
import { getUpstashRedisClient } from './redis.js';

const WS_TICKET_TTL = 60; // seconds
const WS_TICKET_PREFIX = 'sd:pvp:ws-ticket:';

export async function generateWsTicket(userId: string, loginId: string) {
  const ticket = 'wst_' + crypto.randomBytes(16).toString('hex');
  const expiresAt = Date.now() + WS_TICKET_TTL * 1000;
  const redis = getUpstashRedisClient(false);
  await redis.set(
    WS_TICKET_PREFIX + ticket,
    JSON.stringify({ userId, loginId }),
    { ex: WS_TICKET_TTL },
  );
  return { ticket, expiresAt };
}

export async function validateWsTicket(ticket: string): Promise<{ userId: string; loginId: string } | null> {
  const redis = getUpstashRedisClient(false);
  const key = WS_TICKET_PREFIX + ticket;
  const raw = await redis.get<string>(key);
  if (!raw) return null;
  // Single-use: delete immediately
  await redis.del(key);
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (parsed && parsed.userId && parsed.loginId) return parsed;
    return null;
  } catch {
    return null;
  }
}
