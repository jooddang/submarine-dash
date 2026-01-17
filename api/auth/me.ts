import type { VercelRequest, VercelResponse } from '@vercel/node';
import { KEY_PREFIX, getUser, getUserIdForSession } from '../_lib/auth.js';
import { getUpstashRedisClient, RedisConfigError } from '../_lib/redis.js';
import { getPrevWeekId } from '../../shared/week.js';
import {
  addSavedDolphins,
  keyLegacyDolphinGrant,
  migratePendingDolphins,
  getSavedDolphins,
} from '../_lib/dolphinInventory.js';
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
          await addSavedDolphins(rw, user.userId, 1, { type: 'weeklyWinner', meta: { weekId: prevWeekId } });
          await rw.set(claimKey, prevWeekId);
          weeklyWinnerReward = { dolphin: true, weekId: prevWeekId };
        }
      }
    } catch (e) {
      // Reward is best-effort; never block auth/me.
      console.warn('Weekly winner reward check failed:', e);
    }

    // Back-compat: legacy manual grants stored under sd:reward:dolphin:grant:<userId>
    // Convert them into pending dolphins, then clear.
    let grantReward: { dolphin: number } | null = null;
    try {
      const rw = getUpstashRedisClient(false);
      const legacyKey = keyLegacyDolphinGrant(user.userId);
      const raw = await rw.get<string>(legacyKey);
      const n = raw ? Number.parseInt(String(raw), 10) : 0;
      if (Number.isFinite(n) && n > 0) {
        await addSavedDolphins(rw, user.userId, n, { type: 'manualGrant', meta: { source: 'legacyGrantKey' } });
        await rw.set(legacyKey, '0');
        grantReward = { dolphin: n };
      }
    } catch (e) {
      console.warn('Dolphin grant check failed:', e);
    }

    // Inventory is sourced from Redis (saved only; migrate any legacy pending).
    let inventory: { dolphinSaved: number } | undefined = undefined;
    try {
      const rw = getUpstashRedisClient(false);
      await migratePendingDolphins(rw, user.userId);
      const saved = await getSavedDolphins(rw, user.userId);
      inventory = { dolphinSaved: saved };
    } catch (e) {
      console.warn('Dolphin inventory settle failed:', e);
    }

    const rewards =
      weeklyWinnerReward || grantReward
        ? {
            ...(weeklyWinnerReward ? { weeklyWinner: weeklyWinnerReward } : {}),
            ...(grantReward ? { grants: grantReward } : {}),
          }
        : undefined;

    return res.status(200).json({
      user: {
        userId: user.userId,
        loginId: user.loginId,
        refCode: user.refCode,
      },
      inventory,
      rewards,
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


