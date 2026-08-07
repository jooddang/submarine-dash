import crypto from 'node:crypto';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { setRoadcrosserStateCookie } from '../../_lib/auth.js';
import { withProductionControl } from '../../_lib/productionControls.js';

function roadcrosserConnectUrl() {
  const origin = process.env.SD_ROADCROSSER_PUBLIC_ORIGIN || 'https://www.roadcrosser.com';
  if (origin !== 'https://www.roadcrosser.com' && !(process.env.NODE_ENV !== 'production' && /^http:\/\/(?:localhost|127\.0\.0\.1):[0-9]+$/.test(origin))) {
    throw new Error('Roadcrosser public origin is invalid');
  }
  return `${origin}/games/submarine-dash/connect`;
}

export async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  if (process.env.SD_CANONICAL_AUTH_TICKETS_ENABLED !== 'true') {
    return res.status(404).json({ error: 'Canonical account connection is disabled' });
  }
  const state = crypto.randomBytes(32).toString('base64url');
  const stateChallenge = crypto.createHash('sha256').update(state, 'utf8').digest('base64url');
  setRoadcrosserStateCookie(res, state);
  return res.redirect(303, `${roadcrosserConnectUrl()}?stateChallenge=${encodeURIComponent(stateChallenge)}`);
}

export default withProductionControl('api/auth/roadcrosser/start.ts', handler);
