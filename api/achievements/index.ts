import type { VercelRequest, VercelResponse } from '@vercel/node';
import { withProductionControl } from './../_lib/productionControls.js';
import { getUserIdForSession } from '../_lib/auth.js';
import { getUpstashRedisClient } from '../_lib/redis.js';
import { getAchievementState } from '../_lib/achievements.js';
import { ACHIEVEMENT_CATALOG } from '../../shared/achievements.js';

export const config = { runtime: 'nodejs' };

async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const userId = await getUserIdForSession(req);

    let unlocked: Record<string, number> = {};
    if (userId) {
      const ro = getUpstashRedisClient(true);
      const state = await getAchievementState(ro, userId);
      unlocked = state.unlocked;
    }

    const achievements = ACHIEVEMENT_CATALOG.map((a: any) => ({
      id: a.id,
      name: a.name,
      description: a.description,
      category: a.category,
      reward: a.reward,
      unlocked: !!unlocked[a.id],
      unlockedAt: unlocked[a.id] || null,
    }));

    return res.status(200).json({ achievements });
  } catch (error) {
    console.error('Achievements API error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

export default withProductionControl('api/achievements/index.ts', handler);
