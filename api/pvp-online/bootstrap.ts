import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getUserIdForSession, getUser } from '../_lib/auth.js';
import { getUpstashRedisClient } from '../_lib/redis.js';
import { getSavedDolphins } from '../_lib/dolphinInventory.js';
import { getCoinBalance } from '../_lib/coinInventory.js';
import { getTubeState } from '../_lib/tubeInventory.js';
import { getSkinState } from '../_lib/skinInventory.js';
import { getUnreadCount } from '../_lib/pvpOnlineInbox.js';
import { getUserRoomMembership, getRoomSnapshot } from '../_lib/pvpOnlineRooms.js';

export const config = { runtime: 'nodejs' };

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const userId = await getUserIdForSession(req);
  if (!userId) return res.status(401).json({ error: 'Not authenticated' });

  const user = await getUser(userId);
  if (!user) return res.status(401).json({ error: 'User not found' });

  const redis = getUpstashRedisClient(true);
  const [dolphins, coins, tube, skins, inboxUnreadCount, activeRoomId] = await Promise.all([
    getSavedDolphins(redis, userId),
    getCoinBalance(redis, userId),
    getTubeState(redis, userId),
    getSkinState(redis, userId),
    getUnreadCount(userId),
    getUserRoomMembership(userId),
  ]);

  let activeRoomSummary = null;
  if (activeRoomId) {
    activeRoomSummary = await getRoomSnapshot(activeRoomId);
  }

  return res.status(200).json({
    user: { userId: user.userId, loginId: user.loginId, refCode: user.refCode },
    inventory: {
      coins,
      dolphinSaved: dolphins,
      tube,
      skins,
    },
    inboxUnreadCount,
    activeRoomSummary,
  });
}
