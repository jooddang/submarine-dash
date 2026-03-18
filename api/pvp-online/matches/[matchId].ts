import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getUserIdForSession } from '../../_lib/auth.js';
import { getUpstashRedisClient } from '../../_lib/redis.js';

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

  const matchId = req.query.matchId as string;
  if (!matchId) return res.status(400).json({ error: 'Missing matchId' });

  const redis = getUpstashRedisClient(true);
  const raw = await redis.get<string>('sd:pvp:match:' + matchId);
  if (!raw) return res.status(404).json({ error: 'Match not found' });

  try {
    const match = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return res.status(200).json({ match });
  } catch {
    return res.status(500).json({ error: 'Invalid match data' });
  }
}
