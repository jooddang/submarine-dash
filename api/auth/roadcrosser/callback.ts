import crypto from 'node:crypto';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import {
  clearRoadcrosserStateCookie, clearSessionCookie, deleteLegacySessionToken, getCanonicalSessionToken,
  getLegacySessionToken, getRoadcrosserState, setCanonicalSessionCookie,
} from '../../_lib/auth.js';
import { consumeRoadcrosserTicket, revokeRoadcrosserSession } from '../../_lib/roadcrosserAuth.js';
import { withProductionControl } from '../../_lib/productionControls.js';

const opaque256 = /^[A-Za-z0-9_-]{43}$/;

function roadcrosserOrigin() {
  const origin = process.env.SD_ROADCROSSER_PUBLIC_ORIGIN || 'https://www.roadcrosser.com';
  if (origin !== 'https://www.roadcrosser.com' && !(process.env.NODE_ENV !== 'production' && /^http:\/\/(?:localhost|127\.0\.0\.1):[0-9]+$/.test(origin))) {
    throw new Error('Roadcrosser public origin is invalid');
  }
  return origin;
}

function roadcrosserGameUrl() {
  return `${roadcrosserOrigin()}/submarine-dash`;
}

export async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (process.env.SD_CANONICAL_AUTH_TICKETS_ENABLED !== 'true') {
    return res.status(404).json({ error: 'Canonical account connection is disabled' });
  }
  if (req.headers.origin !== roadcrosserOrigin()) return res.status(403).json({ error: 'Forbidden' });
  const ticket = typeof req.body?.ticket === 'string' ? req.body.ticket : '';
  const state = getRoadcrosserState(req);
  if (!opaque256.test(ticket) || !state || !opaque256.test(state)) {
    return res.status(400).json({ error: 'Invalid account handoff' });
  }
  const stateChallenge = crypto.createHash('sha256').update(state, 'utf8').digest('base64url');
  const existingCanonical = getCanonicalSessionToken(req);
  const existingLegacy = getLegacySessionToken(req);
  try {
    const canonical = await consumeRoadcrosserTicket(ticket, stateChallenge);
    if (!opaque256.test(canonical.sessionToken)) throw new Error('invalid session');
    try {
      if (existingLegacy) await deleteLegacySessionToken(existingLegacy);
      if (existingCanonical && existingCanonical !== canonical.sessionToken) await revokeRoadcrosserSession(existingCanonical);
    } catch {
      await revokeRoadcrosserSession(canonical.sessionToken).catch(() => undefined);
      return res.status(503).json({ error: 'Existing session could not be replaced' });
    }
    setCanonicalSessionCookie(res, canonical.sessionToken);
    if (existingLegacy) clearSessionCookie(res);
    clearRoadcrosserStateCookie(res);
    return res.redirect(303, roadcrosserGameUrl());
  } catch {
    return res.status(401).json({ error: 'Account handoff is invalid or expired' });
  }
}

export default withProductionControl('api/auth/roadcrosser/callback.ts', handler);
