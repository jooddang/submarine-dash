import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getUserIdForSession } from '../_lib/auth.js';
import { getInboxItems } from '../_lib/pvpOnlineInbox.js';

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

  const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : undefined;
  const limit = typeof req.query.limit === 'string' ? parseInt(req.query.limit, 10) : 20;

  const result = await getInboxItems(userId, cursor, Math.min(limit, 50));
  return res.status(200).json(result);
}
