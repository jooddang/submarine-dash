import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getUser, getUserIdForSession } from '../_lib/auth.js';
import { getUpstashRedisClient, RedisConfigError } from '../_lib/redis.js';
import { getPrevWeekId } from '../../shared/week.js';
import {
  claimKeyForWeeklyDolphin,
  currentWeekIdPst,
  ensureWeeklyStoreBootstrapped,
  readWeeklyStore,
} from '../_lib/weeklyLeaderboard.js';

export const config = { runtime: 'nodejs' };

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const userId = await getUserIdForSession(req);
    if (!userId) return res.status(200).json({ user: null });

    const user = await getUser(userId);
    if (!user) return res.status(200).json({ user: null });

    // Weekly winner dolphin reward:
    // If the user was #1 of the previous PST week, grant one saved Dolphin on next visit/play.
    // Idempotent via a server-side "last claimed weekId" marker.
    let weeklyWinnerReward: { dolphin: true; weekId: string } | null = null;
    try {
      await ensureWeeklyStoreBootstrapped();
      const store = await readWeeklyStore();
      const currentWeekId = currentWeekIdPst();
      const prevWeekId = getPrevWeekId(currentWeekId);
      const winner = store.weeks[prevWeekId]?.entries?.[0];
      const winnerLoginId = typeof winner?.userId === 'string' ? winner.userId : null;
      if (winnerLoginId && winnerLoginId.toLowerCase() === user.loginIdLower) {
        const rw = getUpstashRedisClient(false);
        const claimKey = claimKeyForWeeklyDolphin(user.userId);
        const lastClaimed = await rw.get<string>(claimKey);
        if (lastClaimed !== prevWeekId) {
          await rw.set(claimKey, prevWeekId);
          weeklyWinnerReward = { dolphin: true, weekId: prevWeekId };
        }
      }
    } catch (e) {
      // Reward is best-effort; never block auth/me.
      console.warn('Weekly winner reward check failed:', e);
    }

    return res.status(200).json({
      user: {
        userId: user.userId,
        loginId: user.loginId,
        refCode: user.refCode,
      },
      rewards: weeklyWinnerReward ? { weeklyWinner: weeklyWinnerReward } : undefined,
    });
  } catch (error) {
    if (error instanceof RedisConfigError) {
      console.error('Auth me API redis config error:', error.message);
      return res.status(503).json({ error: 'Server not configured', details: error.message });
    }
    console.error('Auth me API error:', error);
    return res.status(500).json({
      error: 'Internal server error',
      details: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}


