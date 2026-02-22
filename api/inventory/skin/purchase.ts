import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getUserIdForSession } from '../../_lib/auth.js';
import { getUpstashRedisClient } from '../../_lib/redis.js';
import { getSkinState, addOwnedSkin } from '../../_lib/skinInventory.js';
import { getCoinBalance } from '../../_lib/coinInventory.js';

export const config = { runtime: 'nodejs' };

// Minimal server-side skin catalog (costs only — no rendering data needed).
const SKIN_COSTS: Record<string, number> = {
  default: 0,
  gold: 150,
  golden: 150,
  ocean_blue: 150,
  coral_red: 150,
  neon_green: 150,
  royal_purple: 150,
  whale: 1000,
  orca: 1000,
  scary_orca: 5000,
  mystical_fish: 20000,
};

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
    if (!skinId || !(skinId in SKIN_COSTS)) {
      return res.status(400).json({ error: 'Invalid skin ID' });
    }

    const cost = SKIN_COSTS[skinId];
    const rw = getUpstashRedisClient(false);

    // Check if already owned
    const state = await getSkinState(rw, userId);
    if (state.owned.includes(skinId)) {
      return res.status(400).json({ error: 'Already owned' });
    }

    // Check balance
    const balance = await getCoinBalance(rw, userId);
    if (balance < cost) {
      return res.status(400).json({ error: 'Insufficient coins', required: cost, balance });
    }

    // Deduct coins atomically
    const { keyCoinBalance } = await import('../../_lib/coinInventory.js');
    const newBalance = await rw.decrby(keyCoinBalance(userId), cost);
    if (newBalance < 0) {
      // Race condition safety: refund
      await rw.incrby(keyCoinBalance(userId), cost);
      return res.status(400).json({ error: 'Insufficient coins' });
    }

    // Grant skin
    await addOwnedSkin(rw, userId, skinId);

    const updatedState = await getSkinState(rw, userId);
    return res.status(200).json({
      ok: true,
      skinId,
      cost,
      coins: newBalance,
      skins: updatedState,
    });
  } catch (error) {
    console.error('Skin purchase API error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
