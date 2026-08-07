import type { VercelRequest, VercelResponse } from '@vercel/node';
import { withProductionControl } from './../_lib/productionControls.js';
import {
  KEY_PREFIX, clearCanonicalSessionCookie, clearSessionCookie, getCanonicalSessionToken, getUser, getUserIdForSession,
} from '../_lib/auth.js';
import { readRoadcrosserCanonicalBootstrap } from '../_lib/roadcrosserAuth.js';
import { getUpstashRedisClient, RedisConfigError } from '../_lib/redis.js';
import { getPrevWeekId } from '../../shared/week.js';
import {
  addSavedDolphins,
  keyLegacyDolphinGrant,
  migratePendingDolphins,
  getSavedDolphins,
} from '../_lib/dolphinInventory.js';
import { getCoinBalance } from '../_lib/coinInventory.js';
import { getTubeState, type TubeState } from '../_lib/tubeInventory.js';
import { getSkinState, type SkinState } from '../_lib/skinInventory.js';
import {
  claimKeyForWeeklyDolphin,
  currentWeekIdPst,
  ensureWeeklyStoreBootstrapped,
  readWeeklyStore,
} from '../_lib/weeklyLeaderboard.js';

export const config = { runtime: 'nodejs' };

export async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });


  try {
    const canonicalToken = getCanonicalSessionToken(req);
    if (canonicalToken) {
      try {
        const canonical = await readRoadcrosserCanonicalBootstrap(canonicalToken);
        return res.status(200).json({
          user: { userId: canonical.user.externalUserId, loginId: canonical.user.loginId, refCode: '' },
          inventory: canonical.inventory,
          achievements: canonical.achievements,
          streak: canonical.streak,
          unreadInboxCount: canonical.unreadInboxCount,
          readOnly: canonical.readOnly,
          writeCapabilities: canonical.writeCapabilities,
          canonical: true,
        });
      } catch {
        clearCanonicalSessionCookie(res);
        // Never let a dormant legacy cookie become authoritative after a
        // canonical session expires or is revoked.
        clearSessionCookie(res);
        return res.status(200).json({ user: null });
      }
    }
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
    let inventory: { dolphinSaved: number; coins: number; tube?: TubeState; skins?: SkinState } | undefined = undefined;
    try {
      const rw = getUpstashRedisClient(false);
      await migratePendingDolphins(rw, user.userId);
      const saved = await getSavedDolphins(rw, user.userId);
      const coins = await getCoinBalance(rw, user.userId);
      const tube = await getTubeState(rw, user.userId);
      const skins = await getSkinState(rw, user.userId);
      inventory = { dolphinSaved: saved, coins, tube, skins };
    } catch (e) {
      console.warn('Inventory settle failed:', e);
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

export default withProductionControl('api/auth/me.ts', handler);
