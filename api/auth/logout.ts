import type { VercelRequest, VercelResponse } from '@vercel/node';
import { withProductionControl } from './../_lib/productionControls.js';
import {
  clearCanonicalSessionCookie, clearSessionCookie, deleteSession, getCanonicalSessionToken,
  isAllowedSubmarineMutationOrigin,
} from '../_lib/auth.js';
import { RedisConfigError } from '../_lib/redis.js';
import { revokeRoadcrosserSession } from '../_lib/roadcrosserAuth.js';

export const config = { runtime: 'nodejs' };

export async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!isAllowedSubmarineMutationOrigin(req)) return res.status(403).json({ error: 'Forbidden' });


  try {
    const canonicalToken = getCanonicalSessionToken(req);
    if (canonicalToken) await revokeRoadcrosserSession(canonicalToken);
    await deleteSession(req);
    clearSessionCookie(res);
    clearCanonicalSessionCookie(res);
    return res.status(200).json({ ok: true });
  } catch (error) {
    if (error instanceof RedisConfigError) {
      console.error('Auth logout API redis config error:', error.message);
      // Logout is best-effort; if storage isn't configured, just clear the cookie.
      clearSessionCookie(res);
      clearCanonicalSessionCookie(res);
      return res.status(200).json({ ok: true });
    }
    console.error('Auth logout API error:', error);
    return res.status(500).json({
      error: 'Internal server error',
      details: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}

export default withProductionControl('api/auth/logout.ts', handler);
