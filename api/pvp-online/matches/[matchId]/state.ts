import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getUserIdForSession } from '../../../_lib/auth.js';
import { getUpstashRedisClient } from '../../../_lib/redis.js';

export const config = { runtime: 'nodejs' };

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const userId = await getUserIdForSession(req);
  if (!userId) return res.status(401).json({ error: 'Not authenticated' });

  const matchId = req.query.matchId as string;
  if (!matchId) return res.status(400).json({ error: 'Missing matchId' });

  const redis = getUpstashRedisClient(false);
  const raw = await redis.get<string>('sd:pvp:match:' + matchId);
  if (!raw) return res.status(404).json({ error: 'MATCH_NOT_FOUND' });

  const match = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (match.players?.host?.userId !== userId) {
    return res.status(403).json({ error: 'ONLY_HOST_CAN_UPDATE_MATCH' });
  }

  const { phase, snapshot, series, winnerSlot = null } = req.body || {};

  // Anti-regression: never move backwards from MATCH_RESULT.
  const isAlreadyCompleted = match.phase === 'MATCH_RESULT';
  if (isAlreadyCompleted && phase && phase !== 'MATCH_RESULT') {
    return res.status(200).json({ match }); // silently ignore stale pushes
  }

  // Capture existing round info BEFORE series update for phase regression check.
  const PHASE_ORDER: Record<string, number> = {
    LOBBY: 0, INSTRUCTIONS: 1, COUNTDOWN: 2, PLAYING: 3, ROUND_RESULT: 4, MATCH_RESULT: 5,
  };
  const existingRound = match.series?.currentRound || 1;
  const existingPhaseRank = PHASE_ORDER[match.phase] ?? -1;

  // Anti-regression for series: check roundResults count AND currentRound.
  if (series) {
    const existingRounds = match.series?.roundResults?.length || 0;
    const incomingRounds = series.roundResults?.length || 0;
    const existingCurrentRound = match.series?.currentRound || 1;
    const incomingCurrentRound = series.currentRound || 1;
    if (incomingRounds >= existingRounds && incomingCurrentRound >= existingCurrentRound) {
      match.series = series;
    }
  }

  // Anti-regression for phase/snapshot: use (currentRound, phaseRank) composite.
  // A stale PLAYING/ROUND_RESULT push from a previous round must not overwrite
  // a newer COUNTDOWN push for the next round.
  if (phase) {
    const incomingRound = match.series?.currentRound || 1;
    const incomingPhaseRank = PHASE_ORDER[phase] ?? -1;

    // Accept if round advanced, or same round with phase advance or equal, or no prior phase.
    const roundAdvanced = incomingRound > existingRound;
    const sameRoundPhaseOk = incomingRound === existingRound && incomingPhaseRank >= existingPhaseRank;
    if (roundAdvanced || sameRoundPhaseOk || existingPhaseRank < 0) {
      match.phase = phase;
      if (snapshot !== undefined) match.snapshot = snapshot;
    }
    // else: stale push — silently ignore phase and snapshot
  } else if (snapshot !== undefined) {
    match.snapshot = snapshot;
  }

  // Anti-regression: never clear a decided winnerSlot.
  if (winnerSlot === 1 || winnerSlot === 2) {
    match.winnerSlot = winnerSlot;
  } else if (match.winnerSlot == null && winnerSlot === null) {
    match.winnerSlot = null;
  }
  // If match.winnerSlot is already 1 or 2, do not overwrite with null.

  match.updatedAt = Date.now();

  if (phase === 'MATCH_RESULT') {
    match.completedAt = Date.now();
    const roomRaw = await redis.get<string>('sd:pvp:room:' + match.roomId);
    if (roomRaw) {
      const room = typeof roomRaw === 'string' ? JSON.parse(roomRaw) : roomRaw;
      room.phase = room.slots?.guest ? 'READY_CHECK' : 'OPEN';
      room.matchId = null;
      room.slots.host.ready = false;
      if (room.slots.guest) room.slots.guest.ready = false;
      room.updatedAt = Date.now();
      room.version += 1;
      await redis.set('sd:pvp:room:' + match.roomId, JSON.stringify(room));
    }
  }

  await redis.set('sd:pvp:match:' + matchId, JSON.stringify(match));
  return res.status(200).json({ match });
}
