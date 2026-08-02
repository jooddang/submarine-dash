import type { VercelRequest, VercelResponse } from '@vercel/node';
import { withProductionControl } from './../../_lib/productionControls.js';
import { getUserIdForSession, getUser, keyLoginId } from '../../_lib/auth.js';
import { getUpstashRedisClient } from '../../_lib/redis.js';
import { getUserRoomMembership } from '../../_lib/pvpOnlineRooms.js';
import { sendInvite } from '../../_lib/pvpOnlineInvites.js';

export const config = { runtime: 'nodejs' };

async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const userId = await getUserIdForSession(req);
  if (!userId) return res.status(401).json({ error: 'Not authenticated' });

  const user = await getUser(userId);
  if (!user) return res.status(401).json({ error: 'User not found' });

  const { targetUserId, targetLoginId, roomVersion } = req.body || {};
  if ((!targetUserId && !targetLoginId) || typeof roomVersion !== 'number') {
    return res.status(400).json({ error: 'targetUserId or targetLoginId, and roomVersion required' });
  }

  const roomId = await getUserRoomMembership(userId);
  if (!roomId) return res.status(404).json({ error: 'NOT_IN_ROOM' });

  let toUserId = typeof targetUserId === 'string' && targetUserId.trim() ? targetUserId.trim() : null;
  if (!toUserId && typeof targetLoginId === 'string' && targetLoginId.trim()) {
    const redis = getUpstashRedisClient(true);
    toUserId = await redis.get<string>(keyLoginId(targetLoginId.trim().toLowerCase()));
  }
  if (!toUserId) return res.status(400).json({ error: 'INVITE_TARGET_NOT_FOUND' });

  const targetUser = await getUser(toUserId);
  if (!targetUser) return res.status(400).json({ error: 'INVITE_TARGET_NOT_FOUND' });

  const result = await sendInvite(user.userId, user.loginId, toUserId, targetUser.loginId, roomId, roomVersion);
  if (!result.ok) {
    const status = result.error === 'ROOM_VERSION_CONFLICT' ? 409 : 400;
    return res.status(status).json({ error: result.error });
  }

  return res.status(200).json({ invite: result.invite });
}

export default withProductionControl('api/pvp-online/invites/send.ts', handler);
