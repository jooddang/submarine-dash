import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getUserIdForSession } from '../../_lib/auth.js';
import { getUpstashRedisClient } from '../../_lib/redis.js';
import { addSavedDolphins, migratePendingDolphins, getSavedDolphins } from '../../_lib/dolphinInventory.js';

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

    const body = (req.body || {}) as { count?: unknown };
    const nRaw = typeof body.count === 'number' ? body.count : Number.parseInt(String(body.count ?? '0'), 10);
    const n = Number.isFinite(nRaw) ? Math.max(0, Math.floor(nRaw)) : 0;
    if (n <= 0) {
      const rw = getUpstashRedisClient(false);
      await migratePendingDolphins(rw, userId);
      const saved = await getSavedDolphins(rw, userId);
      return res.status(200).json({ ok: true, inventory: { dolphinSaved: saved } });
    }

    const rw = getUpstashRedisClient(false);
    await addSavedDolphins(rw, userId, n, { type: 'importLocal', meta: { source: 'localStorage' } });
    await migratePendingDolphins(rw, userId);
    const saved = await getSavedDolphins(rw, userId);
    return res.status(200).json({ ok: true, inventory: { dolphinSaved: saved } });
  } catch (e) {
    console.error('Import dolphin API error:', e);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

