import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getUserIdForSession, KEY_PREFIX } from '../_lib/auth.js';
import { getUpstashRedisClient } from '../_lib/redis.js';
import { settleDolphins } from '../_lib/dolphinInventory.js';

export const config = { runtime: 'nodejs' };

type MissionType = 'reach_score' | 'play_runs' | 'collect_oxygen';

export type DailyMission = {
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

function todayKeyUTC(d = new Date()): string {
  return d.toISOString().slice(0, 10);
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

function defaultMissions(): DailyMission[] {
  return [
    { id: 'reach_800', type: 'reach_score', title: 'Reach 800 points', target: 800 },
    { id: 'runs_3', type: 'play_runs', title: 'Play 3 runs', target: 3 },
    { id: 'oxygen_3', type: 'collect_oxygen', title: 'Collect 3 oxygen tanks', target: 3 },
  ];
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

function computeCompleted(missions: DailyMission[], progress: DailyProgress): string[] {
  const out = new Set(progress.completedMissionIds || []);
  for (const m of missions) {
    if (m.type === 'reach_score' && progress.maxScore >= m.target) out.add(m.id);
    if (m.type === 'play_runs' && progress.runs >= m.target) out.add(m.id);
    if (m.type === 'collect_oxygen' && progress.oxygenCollected >= m.target) out.add(m.id);
  }
  return [...out];
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-TZ-Offset-Min');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const tzOffsetMin = tzOffsetFromReq(req);
    const date = tzOffsetMin !== null ? dateKeyFromOffsetMinutes(tzOffsetMin) : todayKeyUTC();

    const userId = await getUserIdForSession(req);
    if (!userId) {
      // Guests can still fetch the mission definitions for UI (progress requires login).
      const redisRO = getUpstashRedisClient(true);
      const missionsRaw = await redisRO.get(keyDailyMissions(date));
      const missions = parseJson<DailyMission[]>(missionsRaw, defaultMissions());
      return res.status(200).json({
        date,
        missions,
        user: null,
      });
    }

    const redisRO = getUpstashRedisClient(true);
    const missionsRaw = await redisRO.get(keyDailyMissions(date));
    const progressRaw = await redisRO.get(keyUserDaily(userId, date));
    const streakRaw = await redisRO.get(keyUserStreak(userId));

    const missions = parseJson<DailyMission[]>(missionsRaw, defaultMissions());
    const progress = parseJson<DailyProgress>(
      progressRaw,
      { runs: 0, oxygenCollected: 0, maxScore: 0, completedMissionIds: [] }
    );
    const streak = parseJson<StreakRecord>(streakRaw, { current: 0, lastKeptDate: null, updatedAt: Date.now() });

    const completedMissionIds = computeCompleted(missions, progress);

    // Source of truth: dolphin inventory in Redis (settle pending -> saved up to cap).
    let inventory: { dolphinSaved: number; dolphinPending: number } | undefined = undefined;
    try {
      const rw = getUpstashRedisClient(false);
      const settled = await settleDolphins(rw, userId);
      inventory = { dolphinSaved: settled.saved, dolphinPending: settled.pending };
    } catch {
      // best-effort
    }

    return res.status(200).json({
      date,
      missions,
      user: {
        progress: { ...progress, completedMissionIds },
        streak,
        inventory,
      },
    });
  } catch (error) {
    console.error('Missions daily API error:', error);
    return res.status(500).json({
      error: 'Internal server error',
      details: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}


