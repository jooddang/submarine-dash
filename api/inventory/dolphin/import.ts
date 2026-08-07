import type { VercelRequest, VercelResponse } from '@vercel/node';
import { withProductionControl } from './../../_lib/productionControls.js';
import { getCanonicalSessionToken, getUserIdForSession, isAllowedSubmarineMutationOrigin } from '../../_lib/auth.js';
import { getUpstashRedisClient } from '../../_lib/redis.js';
import { addSavedDolphins, migratePendingDolphins, getSavedDolphins } from '../../_lib/dolphinInventory.js';
import { importRoadcrosserCanaryDolphin } from '../../_lib/roadcrosserAuth.js';

export const config = { runtime: 'nodejs' };

export function isSyntheticCanaryDolphinImportRequest(req: VercelRequest) {
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
      if (!isSyntheticCanaryDolphinImportRequest(req)) return res.status(409).json({ error: 'Canonical account progress is read-only' });
      const rawKey=req.headers['idempotency-key']; const key=Array.isArray(rawKey)?rawKey[0]:rawKey;
      if (!key || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(key)) return res.status(400).json({ error: 'Valid Idempotency-Key required' });
      const count=req.body?.count;
      if (typeof count!=='number' || !Number.isSafeInteger(count) || count<0) return res.status(400).json({ error:'Safe count required' });
      const out=await importRoadcrosserCanaryDolphin(canonicalToken,key,count);
      return res.status(200).json({ ok:out.ok,inventory:out.inventory,stateVersion:out.stateVersion,idempotent:out.idempotent });
    }
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

export const createImportDolphinRoute = (dependencies: Parameters<typeof withProductionControl>[2] = {}) =>
  withProductionControl('api/inventory/dolphin/import.ts',handler,dependencies,isSyntheticCanaryDolphinImportRequest);
export default createImportDolphinRoute();
