import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getUserIdForSession } from '../../_lib/auth.js';
import { getUpstashRedisClient } from '../../_lib/redis.js';
import { equipSkin, getSkinState } from '../../_lib/skinInventory.js';

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

    const body = req.body || {};
    const skinId = typeof body.skinId === 'string' ? body.skinId.trim() : '';
    if (!skinId) return res.status(400).json({ error: 'Missing skinId' });

    const rw = getUpstashRedisClient(false);
    const result = await equipSkin(rw, userId, skinId);
    if (!result.ok) {
      return res.status(400).json({ error: 'Skin not owned' });
    }

    const state = await getSkinState(rw, userId);
    return res.status(200).json({ ok: true, skins: state });
  } catch (error) {
    console.error('Skin equip API error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
