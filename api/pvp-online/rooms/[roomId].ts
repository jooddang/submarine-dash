import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getUserIdForSession } from '../../_lib/auth.js';
import { getRoomSnapshot } from '../../_lib/pvpOnlineRooms.js';

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

  const roomId = req.query.roomId as string;
  if (!roomId) return res.status(400).json({ error: 'Missing roomId' });

  const room = await getRoomSnapshot(roomId);
  if (!room) return res.status(404).json({ error: 'Room not found' });

  return res.status(200).json({ room });
}
