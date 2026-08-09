import type { VercelRequest, VercelResponse } from '@vercel/node';
import { withProductionControl } from './_lib/productionControls.js';
import { sanitizeLeaderboardName } from '../shared/profanity.js';
import { getCanonicalSessionToken, getUser, getUserIdForSession, isAllowedSubmarineMutationOrigin } from './_lib/auth.js';
import { publishRoadcrosserScore, readRoadcrosserWeeklyLeaderboard, resolveRoadcrosserSession } from './_lib/roadcrosserAuth.js';
import { getUpstashRedisClient } from './_lib/redis.js';
import {
  LEGACY_LEADERBOARD_KEY,
  MAX_ENTRIES,
  WEEKLY_LEADERBOARDS_KEY,
  currentWeekIdPst,
  ensureWeeklyStoreBootstrapped,
  readWeeklyStore,
  upsertWeek,
  type LeaderboardEntry,
} from './_lib/weeklyLeaderboard.js';

export const config = { runtime: 'nodejs' };

const CLEAR_ALLOWED = process.env.ALLOW_LEADERBOARD_CLEAR === 'true';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export async function handler(req: VercelRequest, res: VercelResponse) {
  // Enable CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  const canonicalToken = getCanonicalSessionToken(req);

  try {
    if (canonicalToken) {
      if (req.method === 'GET') {
        const weekly = await readRoadcrosserWeeklyLeaderboard(canonicalToken, 1);
        return res.status(200).json(weekly.current);
      }
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
      if (process.env.SD_SUPABASE_GAMEPLAY_WRITES_ENABLED !== 'true') {
        return res.status(409).json({ error: 'Canonical score publication is not enabled' });
      }
      if (!isAllowedSubmarineMutationOrigin(req)) return res.status(403).json({ error: 'Forbidden' });
      const body = (req.body || {}) as Record<string, unknown>;
      const runEvidenceId = typeof body.runEvidenceId === 'string' && UUID.test(body.runEvidenceId) ? body.runEvidenceId : null;
      const idempotencyKey = typeof body.idempotencyKey === 'string' && UUID.test(body.idempotencyKey) ? body.idempotencyKey : null;
      const requestedName = typeof body.name === 'string' ? body.name.trim() : '';
      if (!runEvidenceId || !idempotencyKey || requestedName.length > 64) {
        return res.status(400).json({ error: 'Score publication request is invalid' });
      }
      const session = await resolveRoadcrosserSession(canonicalToken);
      const displayName = (await sanitizeLeaderboardName(requestedName || session.loginId)).slice(0, 64);
      const publication = await publishRoadcrosserScore(canonicalToken, session.externalUserId,
        idempotencyKey, runEvidenceId, displayName);
      const weekly = await readRoadcrosserWeeklyLeaderboard(canonicalToken, 1);
      const rank = weekly.current.findIndex((entry) => entry.id === publication.entry.id) + 1;
      return res.status(200).json({ entry: publication.entry, leaderboard: weekly.current, rank });
    }
    if (req.method === 'GET') {
      // Get leaderboard (current PST week)
      await ensureWeeklyStoreBootstrapped();
      const store = await readWeeklyStore();
      const weekId = currentWeekIdPst();
      const leaderboard = store.weeks[weekId]?.entries ?? [];
      // Sanitize names on read so previously-saved bad words don't show up.
      const sanitized = await Promise.all(
        leaderboard.map(async (e) => ({
          ...e,
          name: await sanitizeLeaderboardName(e.name),
        }))
      );
      return res.status(200).json(sanitized);
    }

    if (req.method === 'POST') {
      // Submit new score (requires login)
      const userId = await getUserIdForSession(req);
      if (!userId) {
        return res.status(401).json({ error: 'Login required' });
      }
      const user = await getUser(userId);
      if (!user) {
        return res.status(401).json({ error: 'Login required' });
      }

      const { name, score, skinId } = req.body;

      if (typeof score !== 'number') {
        return res.status(400).json({ error: 'Invalid name or score' });
      }

      // Ensure legacy is preserved in weekly history before we start writing weekly keys.
      await ensureWeeklyStoreBootstrapped();
      const store = await readWeeklyStore();
      const weekId = currentWeekIdPst();
      const leaderboard = [...(store.weeks[weekId]?.entries ?? [])];

      const requestedName = typeof name === 'string' ? name.trim() : '';
      const finalName = requestedName ? await sanitizeLeaderboardName(requestedName) : user.loginId;

      const newEntry: LeaderboardEntry = {
        id: Date.now(),
        name: finalName,
        userId: user.loginId,
        skinId: typeof skinId === 'string' ? skinId : undefined,
        score
      };

      // Add new entry and sort
      leaderboard.push(newEntry);
      leaderboard.sort((a, b) => b.score - a.score);

      // Keep only top entries
      const topLeaderboard = leaderboard.slice(0, MAX_ENTRIES);
      const updatedStore = upsertWeek(store, weekId, topLeaderboard);
      const rw = getUpstashRedisClient(false);
      await rw.set(WEEKLY_LEADERBOARDS_KEY, JSON.stringify(updatedStore));
      // Keep legacy key pointing at "current leaderboard" for compatibility.
      await rw.set(LEGACY_LEADERBOARD_KEY, JSON.stringify(topLeaderboard));

      const rank = topLeaderboard.findIndex(e => e.id === newEntry.id) + 1;

      return res.status(200).json({
        entry: newEntry,
        leaderboard: topLeaderboard,
        rank
      });
    }

    if (req.method === 'DELETE') {
      // Clear leaderboard is intentionally guarded to avoid deleting historical records.
      if (!CLEAR_ALLOWED) {
        return res.status(403).json({ error: 'Leaderboard clear disabled' });
      }
      const rw = getUpstashRedisClient(false);
      const weekId = currentWeekIdPst();
      await ensureWeeklyStoreBootstrapped();
      const store = await readWeeklyStore();
      const updatedStore = upsertWeek(store, weekId, []);
      await rw.set(WEEKLY_LEADERBOARDS_KEY, JSON.stringify(updatedStore));
      await rw.set(LEGACY_LEADERBOARD_KEY, JSON.stringify([]));
      return res.status(200).json({ message: 'Leaderboard cleared (current week only)' });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (error) {
    console.error('Leaderboard API error:', error);
    return res.status(500).json({
      error: 'Internal server error',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
}

export function isCanonicalLeaderboardBoundary(req: VercelRequest) {
  return (req.method === 'GET' || req.method === 'POST') && Boolean(getCanonicalSessionToken(req));
}

export const createLeaderboardRoute = (dependencies: Parameters<typeof withProductionControl>[2] = {}) =>
  withProductionControl('api/leaderboard.ts', handler, dependencies, isCanonicalLeaderboardBoundary);

export default createLeaderboardRoute();
