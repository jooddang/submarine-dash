import type { VercelRequest, VercelResponse } from '@vercel/node';
import { withProductionControl } from './../../_lib/productionControls.js';
import { getCanonicalSessionToken, getUserIdForSession, isAllowedSubmarineMutationOrigin } from '../../_lib/auth.js';
import { getUpstashRedisClient } from '../../_lib/redis.js';
import { consumeOneSavedDolphin } from '../../_lib/dolphinInventory.js';
import { consumeRoadcrosserCanaryDolphin } from '../../_lib/roadcrosserAuth.js';

export const config = { runtime: 'nodejs' };

export function isSyntheticCanaryDolphinConsumeRequest(req: VercelRequest) {
  const origin = Array.isArray(req.headers.origin) ? req.headers.origin[0] : req.headers.origin;
  return req.method === 'POST' && process.env.SD_SUPABASE_DOLPHIN_WRITE_CANARY_ENABLED === 'true'
    && Boolean(getCanonicalSessionToken(req))
    && origin === (process.env.SD_SUBMARINE_PUBLIC_ORIGIN || 'https://submarine-dash.roadcrosser.com')
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
      if (!isSyntheticCanaryDolphinConsumeRequest(req)) return res.status(409).json({ error: 'Canonical account progress is read-only' });
      const raw = req.headers['idempotency-key']; const key = Array.isArray(raw) ? raw[0] : raw;
      if (!key || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(key)) return res.status(400).json({ error: 'Valid Idempotency-Key required' });
      const out = await consumeRoadcrosserCanaryDolphin(canonicalToken,key);
      return res.status(200).json({ ok:out.ok,inventory:out.inventory,stateVersion:out.stateVersion,idempotent:out.idempotent });
    }
    const userId = await getUserIdForSession(req);
    if (!userId) return res.status(401).json({ error: 'Login required' });

    const rw = getUpstashRedisClient(false);
    const out = await consumeOneSavedDolphin(rw, userId);
    return res.status(200).json({ ok: out.ok, inventory: { dolphinSaved: out.saved } });
  } catch (e) {
    console.error('Consume dolphin API error:', e);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

export const createConsumeDolphinRoute = (dependencies: Parameters<typeof withProductionControl>[2] = {}) =>
  withProductionControl('api/inventory/dolphin/consume.ts',handler,dependencies,isSyntheticCanaryDolphinConsumeRequest);
export default createConsumeDolphinRoute();
