import type { VercelRequest, VercelResponse } from '@vercel/node';
import { sendGameEvent } from './_lib/telegram.js';
import { withProductionControl } from './_lib/productionControls.js';

export const config = { runtime: 'nodejs' };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const claimedEvents = new Map<string, number>();

export async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', 'https://submarine-dash.roadcrosser.com');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const body = (req.body || {}) as Record<string, unknown>;
  if (!UUID.test(String(body.eventId ?? ''))
    || !['game_started', 'game_died', 'leaderboard_name_submitted'].includes(String(body.event ?? ''))
    || (body.score !== undefined && (!Number.isInteger(body.score) || Number(body.score) < 0 || Number(body.score) > 1_000_000))
    || (body.displayName !== undefined && (typeof body.displayName !== 'string' || body.displayName.length > 64))
    || (body.detail !== undefined && (typeof body.detail !== 'string' || body.detail.length > 160))) {
    return res.status(400).json({ error: 'Invalid game event' });
  }
  const eventId = String(body.eventId);
  const now = Date.now();
  for (const [candidate, expiresAt] of claimedEvents) {
    if (expiresAt <= now) claimedEvents.delete(candidate);
  }
  if (claimedEvents.has(eventId)) return res.status(202).json({ accepted: true, duplicate: true });
  claimedEvents.set(eventId, now + 24 * 60 * 60 * 1_000);
  try {
    await sendGameEvent({
      eventId,
      event: body.event as 'game_started' | 'game_died' | 'leaderboard_name_submitted',
      ...(typeof body.score === 'number' ? { score: body.score } : {}),
      ...(typeof body.displayName === 'string' ? { displayName: body.displayName } : {}),
      ...(typeof body.detail === 'string' ? { detail: body.detail } : {}),
    });
  } catch (error) {
    console.warn('submarine_telegram_event_failed', error instanceof Error ? error.message : 'unknown');
  }
  return res.status(202).json({ accepted: true });
}

export default withProductionControl('api/game-events.ts', handler);
