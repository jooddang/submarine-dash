import type { VercelRequest, VercelResponse } from '@vercel/node';
import { withProductionControl } from './../../_lib/productionControls.js';
import { getUserIdForSession } from '../../_lib/auth.js';
import { getUpstashRedisClient } from '../../_lib/redis.js';
import { getSkinState } from '../../_lib/skinInventory.js';
import { getUserRoomMembership, updateRoomSkin } from '../../_lib/pvpOnlineRooms.js';

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

  const { roomVersion, skinId } = req.body || {};
  if (typeof roomVersion !== 'number') {
    return res.status(400).json({ error: 'roomVersion required' });
  }
  if (typeof skinId !== 'string' || !skinId.trim()) {
    return res.status(400).json({ error: 'skinId required' });
  }

  const roomId = await getUserRoomMembership(userId);
  if (!roomId) return res.status(404).json({ error: 'NOT_IN_ROOM' });

  const redis = getUpstashRedisClient(true);
  const skins = await getSkinState(redis, userId);
  if (!skins.owned.includes(skinId)) {
    return res.status(403).json({ error: 'SKIN_NOT_OWNED' });
  }

  const result = await updateRoomSkin(userId, roomId, skinId, roomVersion);
  if (!result.ok) {
    const status = result.error === 'ROOM_VERSION_CONFLICT' ? 409 : 400;
    return res.status(status).json({ error: result.error });
  }

  return res.status(200).json({ room: result.room });
}

export default withProductionControl('api/pvp-online/rooms/skin.ts', handler);
