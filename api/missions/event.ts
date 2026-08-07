import type { VercelRequest, VercelResponse } from '@vercel/node';
import { withProductionControl } from './../_lib/productionControls.js';
import { getCanonicalSessionToken, getUserIdForSession, KEY_PREFIX } from '../_lib/auth.js';
import { getUpstashRedisClient } from '../_lib/redis.js';
import {
  addSavedDolphins,
  keyDolphinStreakLastAwarded,
  migratePendingDolphins,
  getSavedDolphins,
} from '../_lib/dolphinInventory.js';
import {
  addCoins,
  computeCoinsForScore,
  getCoinBalance,
} from '../_lib/coinInventory.js';
import {
  getTubeState,
  saveTubeState,
  type TubeState,
} from '../_lib/tubeInventory.js';
import { getSkinState, type SkinState } from '../_lib/skinInventory.js';
import {
  getAchievementState,
  saveAchievementState,
  evaluateRunEndAchievements,
  evaluatePvpResultAchievements,
  getAchievementRewardCoins,
} from '../_lib/achievements.js';
import {
  readWeeklyStore,
  currentWeekIdPst,
} from '../_lib/weeklyLeaderboard.js';

export const config = { runtime: 'nodejs' };

type MissionType = 'reach_score' | 'play_runs' | 'collect_oxygen';

type DailyMission = {
  id: string;
  type: MissionType;
  title: string;
  target: number;
};

type DailyProgress = {
  runs: number;
  oxygenCollected: number;
  maxScore: number;
  completedMissionIds: string[];
  keptAt?: number;
};

type StreakRecord = {
  current: number;
  lastKeptDate: string | null; // yyyy-mm-dd
  updatedAt: number;
};

type MissionEvent =
  | { type: 'run_end'; score: number; tubePieces?: number; tubeCharges?: number; deathCause?: string | null; perfectPlatformer?: boolean; allOxygenCollected?: boolean }
  | { type: 'oxygen_collected'; count?: number };

function todayKeyUTC(d = new Date()): string {
  return d.toISOString().slice(0, 10);
}

function yesterdayKeyUTC(d = new Date()): string {
  const t = new Date(d);
  t.setUTCDate(t.getUTCDate() - 1);
  return t.toISOString().slice(0, 10);
}

function tzOffsetFromReq(req: VercelRequest): number | null {
  const raw = req.headers['x-tz-offset-min'];
  const v = Array.isArray(raw) ? raw[0] : raw;
  if (!v) return null;
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) return null;
  // Clamp to plausible range [-14h, +14h]
  if (n < -14 * 60 || n > 14 * 60) return null;
  return n;
}

function dateKeyFromOffsetMinutes(offsetMin: number, nowMs = Date.now()): string {
  // offsetMin is minutes to add to local time to get UTC (Date.getTimezoneOffset()).
  // local = utc - offsetMin
  const localMs = nowMs - offsetMin * 60_000;
  return new Date(localMs).toISOString().slice(0, 10);
}

function keyDailyMissions(date: string) {
  return `${KEY_PREFIX}missions:daily:${date}`;
}

function keyUserDaily(userId: string, date: string) {
  return `${KEY_PREFIX}user:${userId}:daily:${date}`;
}

function keyUserStreak(userId: string) {
  return `${KEY_PREFIX}user:${userId}:streak`;
}

function parseJson<T>(raw: unknown, fallback: T): T {
  if (!raw) return fallback;
  if (typeof raw === 'string') {
    const t = raw.trim();
    if (!t) return fallback;
    try {
      return JSON.parse(t) as T;
    } catch {
      return fallback;
    }
  }
  return raw as T;
}

function defaultMissions(): DailyMission[] {
  return [
    { id: 'reach_800', type: 'reach_score', title: 'Reach 800 points', target: 800 },
    { id: 'runs_3', type: 'play_runs', title: 'Play 3 runs', target: 3 },
    { id: 'oxygen_3', type: 'collect_oxygen', title: 'Collect 3 oxygen tanks', target: 3 },
  ];
}

function computeCompleted(missions: DailyMission[], progress: DailyProgress): string[] {
  const out = new Set(progress.completedMissionIds || []);
  for (const m of missions) {
    if (m.type === 'reach_score' && progress.maxScore >= m.target) out.add(m.id);
    if (m.type === 'play_runs' && progress.runs >= m.target) out.add(m.id);
    if (m.type === 'collect_oxygen' && progress.oxygenCollected >= m.target) out.add(m.id);
  }
  return [...out];
}

function hasAnyCompletion(before: string[], after: string[]) {
  if (after.length === 0) return false;
  if (before.length === 0 && after.length > 0) return true;
  const b = new Set(before);
  for (const a of after) if (!b.has(a)) return true;
  return false;
}

async function keepTodayAndUpdateStreak(params: {
  userId: string;
  date: string;
  progress: DailyProgress;
}) {
  const { userId, date, progress } = params;
  const redisRO = getUpstashRedisClient(true);
  const redisRW = getUpstashRedisClient(false);

  const streakKey = keyUserStreak(userId);
  const streakRaw = await redisRO.get(streakKey);
  const streak = parseJson<StreakRecord>(
    streakRaw,
    { current: 0, lastKeptDate: null, updatedAt: Date.now() }
  );

  const today = date;
  if (streak.lastKeptDate === today) return { didUpdate: false, didReset: false, streak };

  // Compute "yesterday" based on the provided `date` to avoid edge cases around midnight.
  const yday = yesterdayKeyUTC(new Date(`${date}T00:00:00Z`));
  const continues = streak.lastKeptDate === yday;
  const next = continues ? (streak.current + 1) : 1;
  const didReset = !continues && streak.current > 0;
  streak.current = next;
  streak.lastKeptDate = today;
  streak.updatedAt = Date.now();
  progress.keptAt = Date.now();
  await redisRW.set(streakKey, JSON.stringify(streak));
  return { didUpdate: true, didReset, streak };
}

function areAllMissionsCompleted(missions: DailyMission[], completedMissionIds: string[]) {
  if (missions.length === 0) return false;
  const done = new Set(completedMissionIds || []);
  return missions.every((m) => done.has(m.id));
}

export async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-TZ-Offset-Min');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });


  try {
    if (getCanonicalSessionToken(req)) {
      return res.status(409).json({ error: 'Canonical mission rewards require trusted gameplay settlement' });
    }
    const userId = await getUserIdForSession(req);
    if (!userId) return res.status(401).json({ error: 'Login required' });

    const body = (req.body || {}) as Partial<MissionEvent>;
    if (!body.type) return res.status(400).json({ error: 'Invalid event' });

    const tzOffsetMin = tzOffsetFromReq(req);
    const date = tzOffsetMin !== null ? dateKeyFromOffsetMinutes(tzOffsetMin) : todayKeyUTC();
    const redisRO = getUpstashRedisClient(true);
    const redisRW = getUpstashRedisClient(false);

    const missionsRaw = await redisRO.get(keyDailyMissions(date));
    const missions = parseJson<DailyMission[]>(missionsRaw, defaultMissions());

    const progressKey = keyUserDaily(userId, date);
    const progressRaw = await redisRO.get(progressKey);
    const progress = parseJson<DailyProgress>(
      progressRaw,
      { runs: 0, oxygenCollected: 0, maxScore: 0, completedMissionIds: [] }
    );

    let coinsEarned = 0;

    if (body.type === 'run_end') {
      const score = typeof body.score === 'number' ? body.score : 0;
      progress.runs += 1;
      progress.maxScore = Math.max(progress.maxScore, score);

      // Award coins based on score bracket
      coinsEarned = computeCoinsForScore(score);
      if (coinsEarned > 0) {
        try {
          await addCoins(redisRW, userId, coinsEarned, { type: 'run_end', meta: { score } });
        } catch {
          // best-effort
        }
      }

      // Persist tube state (pieces + rescue charges) server-side
      if (typeof body.tubePieces === 'number' || typeof body.tubeCharges === 'number') {
        try {
          await saveTubeState(
            redisRW,
            userId,
            typeof body.tubePieces === 'number' ? body.tubePieces : 0,
            typeof body.tubeCharges === 'number' ? body.tubeCharges : 0
          );
        } catch {
          // best-effort
        }
      }
    } else if (body.type === 'oxygen_collected') {
      const count = typeof body.count === 'number' && body.count > 0 ? Math.floor(body.count) : 1;
      progress.oxygenCollected += count;
    } else if (body.type === 'pvp_result') {
      // PvP result: only evaluate achievements, no daily progress update needed
      const won = body.won === true;
      let pvpAchievements: string[] = [];
      try {
        const achState = await getAchievementState(redisRO, userId);
        const result = evaluatePvpResultAchievements(achState, won);
        pvpAchievements = result.newlyUnlocked;
        await saveAchievementState(redisRW, userId, result.state);
        if (pvpAchievements.length > 0) {
          const achCoins = getAchievementRewardCoins(pvpAchievements);
          if (achCoins > 0) {
            try {
              await addCoins(redisRW, userId, achCoins, { type: 'achievement', meta: { achievements: pvpAchievements } });
            } catch {
              // best-effort
            }
          }
        }
      } catch {
        // best-effort
      }
      let inventory: { dolphinSaved: number; coins: number } | undefined;
      try {
        const saved = await getSavedDolphins(redisRW, userId);
        const coins = await getCoinBalance(redisRW, userId);
        inventory = { dolphinSaved: saved, coins };
      } catch {
        // best-effort
      }
      return res.status(200).json({ newAchievements: pvpAchievements, inventory });
    } else {
      return res.status(400).json({ error: 'Invalid event' });
    }

    const completedAfter = computeCompleted(missions, progress);
    progress.completedMissionIds = completedAfter;

    // Kept/Streak rule (per ticket): only when ALL daily missions are completed.
    const shouldKeepToday = areAllMissionsCompleted(missions, completedAfter);
    let streakReward: { dolphin: number; streakDays: number } | null = null;
    if (shouldKeepToday) {
      const kept = await keepTodayAndUpdateStreak({ userId, date, progress });
      if (kept.didUpdate) {
        // If the streak reset (e.g. missed a day), allow future 5+ rewards again by resetting lastAwarded.
        if (kept.didReset) {
          try {
            await redisRW.set(keyDolphinStreakLastAwarded(userId), '0');
          } catch {
            // best-effort
          }
        }

        // Server-side streak dolphin reward:
        // once streak is 5+, grant 1 Dolphin each time the streak increases (idempotent via lastAwarded).
        const streakDays = kept.streak.current;
        if (streakDays >= 5) {
          try {
            const lastAwardedRaw = await redisRO.get(keyDolphinStreakLastAwarded(userId));
            const lastAwarded = lastAwardedRaw ? Number.parseInt(String(lastAwardedRaw), 10) : 0;
            if (!Number.isFinite(lastAwarded) || streakDays > lastAwarded) {
              await addSavedDolphins(redisRW, userId, 1, { type: 'streak', meta: { streakDays } });
              await redisRW.set(keyDolphinStreakLastAwarded(userId), String(streakDays));
              streakReward = { dolphin: 1, streakDays };
            }
          } catch {
            // best-effort
          }
        }
      }
    }

    await redisRW.set(progressKey, JSON.stringify(progress));

    // ── Achievement evaluation (run_end only) ──
    let newAchievements: string[] = [];
    if (body.type === 'run_end') {
      try {
        const achState = await getAchievementState(redisRO, userId);
        const skinState = await getSkinState(redisRO, userId);

        // Get weekly top score for "beat weekly high score" achievement
        let weeklyTopScore = 0;
        try {
          const store = await readWeeklyStore();
          const weekId = currentWeekIdPst();
          const week = store.weeks[weekId];
          if (week && week.entries.length > 0) {
            weeklyTopScore = week.entries[0].score;
          }
        } catch {
          // best-effort
        }

        const score = typeof body.score === 'number' ? body.score : 0;
        const result = evaluateRunEndAchievements(
          achState,
          {
            score,
            deathCause: typeof body.deathCause === 'string' ? body.deathCause : null,
            perfectPlatformer: body.perfectPlatformer === true,
            allOxygenCollected: body.allOxygenCollected === true,
            urchinDodges: typeof body.urchinDodges === 'number' ? body.urchinDodges : 0,
            swordfishCollected: body.swordfishCollected === true,
            swordfishDodged: body.swordfishDodged === true,
          },
          skinState.equipped,
          progress.runs,
          date,
          weeklyTopScore,
        );
        newAchievements = result.newlyUnlocked;
        if (newAchievements.length > 0) {
          await saveAchievementState(redisRW, userId, result.state);
          // Award coins for newly unlocked achievements
          const achCoins = getAchievementRewardCoins(newAchievements);
          if (achCoins > 0) {
            try {
              await addCoins(redisRW, userId, achCoins, { type: 'achievement', meta: { achievements: newAchievements } });
              coinsEarned += achCoins;
            } catch {
              // best-effort
            }
          }
        } else {
          // Still save state for progress tracking (streaks, personal best, etc.)
          await saveAchievementState(redisRW, userId, result.state);
        }
      } catch {
        // best-effort — don't break the main response
      }
    }

    // Include latest inventory snapshot (best-effort).
    let inventory: { dolphinSaved: number; coins: number; tube?: TubeState; skins?: SkinState } | undefined = undefined;
    try {
      await migratePendingDolphins(redisRW, userId);
      const saved = await getSavedDolphins(redisRW, userId);
      const coins = await getCoinBalance(redisRW, userId);
      const tube = await getTubeState(redisRW, userId);
      const skins = await getSkinState(redisRW, userId);
      inventory = { dolphinSaved: saved, coins, tube, skins };
    } catch {
      // best-effort
    }

    return res.status(200).json({
      date,
      progress,
      rewards: streakReward ? { streak: streakReward } : undefined,
      coinsEarned: coinsEarned > 0 ? coinsEarned : undefined,
      inventory,
      newAchievements: newAchievements.length > 0 ? newAchievements : undefined,
    });
  } catch (error) {
    console.error('Missions event API error:', error);
    return res.status(500).json({
      error: 'Internal server error',
      details: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}

export function isCanonicalMissionEventRejection(req: VercelRequest) {
  return req.method === 'POST' && Boolean(getCanonicalSessionToken(req));
}

export const createMissionEventRoute = (dependencies: Parameters<typeof withProductionControl>[2] = {}) =>
  withProductionControl('api/missions/event.ts', handler, dependencies, isCanonicalMissionEventRejection);
export default createMissionEventRoute();
