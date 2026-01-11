import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getUserIdForSession } from '../../_lib/auth.js';
import { getUpstashRedisClient } from '../../_lib/redis.js';
import { consumeOneSavedDolphin } from '../../_lib/dolphinInventory.js';

export const config = { runtime: 'nodejs' };

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const userId = await getUserIdForSession(req);
    if (!userId) return res.status(401).json({ error: 'Login required' });

    const rw = getUpstashRedisClient(false);
    const out = await consumeOneSavedDolphin(rw, userId);
    return res.status(200).json({ ok: out.ok, inventory: { dolphinSaved: out.saved, dolphinPending: out.pending } });
  } catch (e) {
    console.error('Consume dolphin API error:', e);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

