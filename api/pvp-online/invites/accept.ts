import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getUserIdForSession, getUser } from '../../_lib/auth.js';
import { acceptInvite } from '../../_lib/pvpOnlineInvites.js';
import { getRoomSnapshot } from '../../_lib/pvpOnlineRooms.js';

export const config = { runtime: 'nodejs' };

export default async function handler(req: VercelRequest, res: VercelResponse) {
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

  const { inviteId, skinId = 'default' } = req.body || {};
  if (!inviteId) return res.status(400).json({ error: 'inviteId required' });

  const result = await acceptInvite(inviteId, user.userId, user.loginId, skinId);
  if (!result.ok) return res.status(400).json({ error: result.error });

  const room = await getRoomSnapshot(result.invite.roomId);
  if (!room) return res.status(404).json({ error: 'ROOM_NOT_FOUND' });

  return res.status(200).json({ room, invite: result.invite });
}
