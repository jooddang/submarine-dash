import type { VercelRequest, VercelResponse } from '@vercel/node';
import { withProductionControl } from './../../_lib/productionControls.js';
import { getUserIdForSession, getUser } from '../../_lib/auth.js';
import { createRoom } from '../../_lib/pvpOnlineRooms.js';

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

  const { skinId = 'default', config } = req.body || {};

  const result = await createRoom(user.userId, user.loginId, skinId, config);
  if (!result.ok) return res.status(409).json({ error: result.error });

  return res.status(200).json({ room: result.room });
}

export default withProductionControl('api/pvp-online/rooms/create.ts', handler);
