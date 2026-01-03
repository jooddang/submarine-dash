import type { VercelRequest, VercelResponse } from '@vercel/node';
import { sanitizeLeaderboardName } from '../../shared/profanity.js';
import {
  currentWeekIdPst,
  ensureWeeklyStoreBootstrapped,
  readWeeklyStore,
  type WeeklyLeaderboard,
} from '../_lib/weeklyLeaderboard.js';

export const config = { runtime: 'nodejs' };

function sortWeekIdsDesc(a: string, b: string) {
  // weekId is ISO date YYYY-MM-DD, lexicographic sort works.
  return a < b ? 1 : a > b ? -1 : 0;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    await ensureWeeklyStoreBootstrapped();
    const store = await readWeeklyStore();
    const currentWeekId = currentWeekIdPst();

    const rawLimit = Array.isArray(req.query.limit) ? req.query.limit[0] : req.query.limit;
    const limit = rawLimit ? Math.max(1, Math.min(260, Number.parseInt(String(rawLimit), 10))) : 52;

    const weekIds = Object.keys(store.weeks).sort(sortWeekIdsDesc).slice(0, limit);

    const weeks: WeeklyLeaderboard[] = await Promise.all(
      weekIds.map(async (weekId) => {
        const w = store.weeks[weekId];
        const entries = await Promise.all(
          (w?.entries ?? []).map(async (e) => ({
            ...e,
            name: await sanitizeLeaderboardName(e.name),
          }))
        );
        return { ...w, entries };
      })
    );

    const current = store.weeks[currentWeekId]?.entries ?? [];
    const currentSanitized = await Promise.all(
      current.map(async (e) => ({ ...e, name: await sanitizeLeaderboardName(e.name) }))
    );

    return res.status(200).json({
      currentWeekId,
      current: currentSanitized,
      weeks,
    });
  } catch (error) {
    console.error('Weekly leaderboard API error:', error);
    return res.status(500).json({
      error: 'Internal server error',
      details: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}


