import crypto from 'node:crypto';
import { getUpstashRedisClient } from './redis.js';

const INBOX_PREFIX = 'sd:inbox:';
const UNREAD_PREFIX = 'sd:inbox:unread:';

export type InboxItem = {
  inboxId: string;
  type: string;
  createdAt: number;
  readAt: number | null;
  actorUserId: string;
  actorLoginId: string;
  roomId: string | null;
  matchId: string | null;
  payload: Record<string, unknown>;
};

export function generateInboxId(): string {
  return 'inb_' + crypto.randomBytes(8).toString('hex');
}

export async function getInboxItems(
  userId: string,
  cursor?: string,
  limit = 20,
): Promise<{ items: InboxItem[]; nextCursor: string | null }> {
  const redis = getUpstashRedisClient(true);
  const key = INBOX_PREFIX + userId;

  // Inbox stored as Redis list (newest first via LPUSH)
  const start = cursor ? parseInt(cursor, 10) : 0;
  const end = start + limit - 1;
  const rawItems = await redis.lrange(key, start, end);

  const items: InboxItem[] = [];
  for (const raw of rawItems) {
    try {
      const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
      items.push(parsed);
    } catch {
      // skip malformed
    }
  }

  const nextStart = start + limit;
  const totalLen = await redis.llen(key);
  const nextCursor = nextStart < totalLen ? String(nextStart) : null;

  return { items, nextCursor };
}

export async function markRead(userId: string, inboxId: string): Promise<{ ok: boolean; readAt: number }> {
  const redis = getUpstashRedisClient(false);
  const key = INBOX_PREFIX + userId;
  const readAt = Date.now();

  // Scan list to find and update the item
  const len = await redis.llen(key);
  for (let i = 0; i < len; i++) {
    const rawItems = await redis.lrange(key, i, i);
    if (!rawItems[0]) continue;
    try {
      const item: InboxItem = typeof rawItems[0] === 'string' ? JSON.parse(rawItems[0]) : rawItems[0];
      if (item.inboxId === inboxId) {
        if (item.readAt === null) {
          item.readAt = readAt;
          await redis.lset(key, i, JSON.stringify(item));
          // Decrement unread count
          const unreadKey = UNREAD_PREFIX + userId;
          const current = await redis.get<number>(unreadKey);
          if (current && current > 0) {
            await redis.decr(unreadKey);
          }
        }
        return { ok: true, readAt };
      }
    } catch {
      continue;
    }
  }

  return { ok: false, readAt };
}

export async function markAllRead(userId: string): Promise<{ ok: boolean; readAt: number }> {
  const redis = getUpstashRedisClient(false);
  const key = INBOX_PREFIX + userId;
  const readAt = Date.now();

  const len = await redis.llen(key);
  for (let i = 0; i < len; i++) {
    const rawItems = await redis.lrange(key, i, i);
    if (!rawItems[0]) continue;
    try {
      const item: InboxItem = typeof rawItems[0] === 'string' ? JSON.parse(rawItems[0]) : rawItems[0];
      if (item.readAt === null) {
        item.readAt = readAt;
        await redis.lset(key, i, JSON.stringify(item));
      }
    } catch {
      continue;
    }
  }

  // Reset unread count
  await redis.set(UNREAD_PREFIX + userId, 0);
  return { ok: true, readAt };
}

export async function getUnreadCount(userId: string): Promise<number> {
  const redis = getUpstashRedisClient(true);
  const count = await redis.get<number>(UNREAD_PREFIX + userId);
  return count || 0;
}
