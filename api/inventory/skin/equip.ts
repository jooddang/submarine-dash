import type { VercelRequest, VercelResponse } from '@vercel/node';
import { withProductionControl } from './../../_lib/productionControls.js';
import { getCanonicalSessionToken, getUserIdForSession, isAllowedSubmarineMutationOrigin } from '../../_lib/auth.js';
import { getUpstashRedisClient } from '../../_lib/redis.js';
import { equipSkin, getSkinState } from '../../_lib/skinInventory.js';
import { equipRoadcrosserCanarySkin } from '../../_lib/roadcrosserAuth.js';

export const config = { runtime: 'nodejs' };

export function isSyntheticCanaryEquipRequest(req: VercelRequest) {
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
      if (!isSyntheticCanaryEquipRequest(req)) return res.status(403).json({ error: 'Origin not allowed' });
      const idempotencyHeader = req.headers['idempotency-key'];
      const idempotencyKey = Array.isArray(idempotencyHeader) ? idempotencyHeader[0] : idempotencyHeader;
      if (!idempotencyKey || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(idempotencyKey)) {
        return res.status(400).json({ error: 'Valid Idempotency-Key required' });
      }
      const skinId = typeof req.body?.skinId === 'string' ? req.body.skinId : '';
      if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(skinId)) return res.status(400).json({ error: 'Missing skinId' });
      const result = await equipRoadcrosserCanarySkin(canonicalToken, idempotencyKey, skinId);
      return res.status(200).json({ ok: true, skins: result.skins, stateVersion: result.stateVersion, idempotent: result.idempotent });
    }
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

export function createEquipSkinRoute(
  dependencies: Parameters<typeof withProductionControl>[2] = {},
) {
  return withProductionControl('api/inventory/skin/equip.ts', handler, dependencies, isSyntheticCanaryEquipRequest);
}

export default createEquipSkinRoute();
