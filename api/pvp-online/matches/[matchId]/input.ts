import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getUserIdForSession } from '../../../_lib/auth.js';
import { getUpstashRedisClient } from '../../../_lib/redis.js';

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

  const matchId = req.query.matchId as string;
  if (!matchId) return res.status(400).json({ error: 'Missing matchId' });

  const { seq, action } = req.body || {};
  if (typeof seq !== 'number') return res.status(400).json({ error: 'seq required' });
  if (action !== 'down' && action !== 'up') return res.status(400).json({ error: 'INVALID_ACTION' });

  const redis = getUpstashRedisClient(false);
  const raw = await redis.get<string>('sd:pvp:match:' + matchId);
  if (!raw) return res.status(404).json({ error: 'MATCH_NOT_FOUND' });

  const match = typeof raw === 'string' ? JSON.parse(raw) : raw;
  const role = match.players?.host?.userId === userId
    ? 'host'
    : match.players?.guest?.userId === userId
      ? 'guest'
      : null;
  if (!role) return res.status(403).json({ error: 'NOT_MATCH_PARTICIPANT' });

  match.inputs = match.inputs || { host: [], guest: [] };
  const inputList = role === 'host' ? match.inputs.host : match.inputs.guest;
  const lastSeq = inputList.length > 0 ? inputList[inputList.length - 1].seq : -1;
  if (seq > lastSeq) {
    inputList.push({ seq, action, at: Date.now() });
    if (inputList.length > 120) {
      inputList.splice(0, inputList.length - 120);
    }
  }

  match.updatedAt = Date.now();
  await redis.set('sd:pvp:match:' + matchId, JSON.stringify(match));
  return res.status(200).json({ ok: true });
}
