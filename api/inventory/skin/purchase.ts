import type { VercelRequest, VercelResponse } from '@vercel/node';
import { withProductionControl } from './../../_lib/productionControls.js';
import { getCanonicalSessionToken, getUserIdForSession, isAllowedSubmarineMutationOrigin } from '../../_lib/auth.js';
import { getUpstashRedisClient } from '../../_lib/redis.js';
import { getSkinState, addOwnedSkin } from '../../_lib/skinInventory.js';
import { getCoinBalance } from '../../_lib/coinInventory.js';
import { purchaseRoadcrosserCanarySkin } from '../../_lib/roadcrosserAuth.js';
import { SKIN_COSTS } from '../../../shared/canaryPurchase.js';

export const config = { runtime: 'nodejs' };

export function isSyntheticCanaryPurchaseRequest(req: VercelRequest) {
  const origin = Array.isArray(req.headers.origin) ? req.headers.origin[0] : req.headers.origin;
  const expectedOrigin = process.env.SD_SUBMARINE_PUBLIC_ORIGIN || 'https://submarine-dash.roadcrosser.com';
  return req.method === 'POST'
    && process.env.SD_SUPABASE_WRITE_CANARY_ENABLED === 'true'
    && Boolean(getCanonicalSessionToken(req))
    && origin === expectedOrigin
    && isAllowedSubmarineMutationOrigin(req);
}

export async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Idempotency-Key');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const canonicalToken = getCanonicalSessionToken(req);
    if (canonicalToken) {
      if (process.env.SD_SUPABASE_WRITE_CANARY_ENABLED !== 'true') {
        return res.status(409).json({ error: 'Canonical account progress is read-only' });
      }
      if (!isSyntheticCanaryPurchaseRequest(req)) return res.status(403).json({ error: 'Origin not allowed' });
      const idempotencyHeader = req.headers['idempotency-key'];
      const idempotencyKey = Array.isArray(idempotencyHeader) ? idempotencyHeader[0] : idempotencyHeader;
      if (!idempotencyKey || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(idempotencyKey)) {
        return res.status(400).json({ error: 'Valid Idempotency-Key required' });
      }
      const skinId = typeof req.body?.skinId === 'string' ? req.body.skinId : '';
      if (!Object.hasOwn(SKIN_COSTS, skinId)) return res.status(400).json({ error: 'Invalid skin ID' });
      const result = await purchaseRoadcrosserCanarySkin(canonicalToken, idempotencyKey, skinId);
      if (result.rejected === 'already_owned') return res.status(400).json({ error: 'Already owned' });
      if (result.rejected === 'insufficient_coins') {
        return res.status(400).json({ error: 'Insufficient coins', required: result.required, balance: result.balance });
      }
      return res.status(200).json({
        ok: true, skinId: result.skinId, cost: result.cost, coins: result.coins,
        skins: result.skins, stateVersion: result.stateVersion, idempotent: result.idempotent,
      });
    }
    const userId = await getUserIdForSession(req);
    if (!userId) return res.status(401).json({ error: 'Login required' });

    const body = req.body || {};
    const skinId = typeof body.skinId === 'string' ? body.skinId.trim() : '';
    if (!skinId || !Object.hasOwn(SKIN_COSTS, skinId)) {
      return res.status(400).json({ error: 'Invalid skin ID' });
    }

    const cost = SKIN_COSTS[skinId as keyof typeof SKIN_COSTS];
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

export function createPurchaseSkinRoute(
  dependencies: Parameters<typeof withProductionControl>[2] = {},
) {
  return withProductionControl('api/inventory/skin/purchase.ts', handler, dependencies, isSyntheticCanaryPurchaseRequest);
}

export default createPurchaseSkinRoute();
