import type { VercelRequest, VercelResponse } from '@vercel/node';
import { withProductionControl } from './../_lib/productionControls.js';
import { getCanonicalSessionToken, KEY_PREFIX } from '../_lib/auth.js';
import { readRoadcrosserAchievementSummaries } from '../_lib/roadcrosserAuth.js';
import { getUpstashRedisClient } from '../_lib/redis.js';
import { getAchievementState } from '../_lib/achievements.js';
import { ACHIEVEMENT_CATALOG } from '../../shared/achievements.js';

export const config = { runtime: 'nodejs' };

const ACHIEVEMENT_NAME_MAP = Object.fromEntries(
  ACHIEVEMENT_CATALOG.map((a: any) => [a.id, { name: a.name, category: a.category }])
);

export async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const raw = req.query?.loginIds;
    const loginIdsParam = typeof raw === 'string' ? raw : '';
    if (!loginIdsParam) return res.status(400).json({ error: 'loginIds query parameter required' });

    const loginIds = [...new Set(loginIdsParam.split(',').map(id => id.trim()).filter(Boolean))];
    if (loginIds.length === 0) return res.status(400).json({ error: 'No valid loginIds provided' });
    if (loginIds.length > 20) return res.status(400).json({ error: 'Too many loginIds (max 20)' });

    const result: Record<string, { count: number; achievements: { id: string; name: string; category: string }[] }> = {};

    const canonicalToken = getCanonicalSessionToken(req);
    if (canonicalToken) {
      const summaries = await readRoadcrosserAchievementSummaries(canonicalToken, loginIds);
      for (const loginId of loginIds) {
        const summary = summaries[loginId] || Object.entries(summaries)
          .find(([canonicalLoginId]) => canonicalLoginId.toLowerCase() === loginId.toLowerCase())?.[1]
          || { count: 0, unlockedIds: [] };
        const unlockedIds = summary.unlockedIds;
        const achievements = unlockedIds.map((id) => {
          const meta = ACHIEVEMENT_NAME_MAP[id];
          return meta ? { id, name: meta.name, category: meta.category } : null;
        }).filter((achievement): achievement is { id: string; name: string; category: string } => achievement !== null);
        result[loginId] = { count: summary.count, achievements };
      }
      return res.status(200).json({ users: result });
    }

    const ro = getUpstashRedisClient(true);

    for (const loginId of loginIds) {
      const userId = await ro.get<string>(`${KEY_PREFIX}loginId:${loginId.toLowerCase()}`);
      if (!userId) {
        result[loginId] = { count: 0, achievements: [] };
        continue;
      }

      const state = await getAchievementState(ro, userId);
      const unlockedIds = Object.keys(state.unlocked);
      result[loginId] = {
        count: unlockedIds.length,
        achievements: unlockedIds
          .map(id => {
            const meta = ACHIEVEMENT_NAME_MAP[id];
            return meta ? { id, name: meta.name, category: meta.category } : null;
          })
          .filter((a): a is { id: string; name: string; category: string } => a !== null),
      };
    }

    return res.status(200).json({ users: result });
  } catch (error) {
    console.error('Achievements users API error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

export function isCanonicalAchievementSummariesBoundary(req: VercelRequest) {
  return req.method === 'GET' && Boolean(getCanonicalSessionToken(req));
}

export const createAchievementSummariesRoute = (dependencies: Parameters<typeof withProductionControl>[2] = {}) =>
  withProductionControl('api/achievements/users.ts', handler, dependencies, isCanonicalAchievementSummariesBoundary);

export default createAchievementSummariesRoute();
