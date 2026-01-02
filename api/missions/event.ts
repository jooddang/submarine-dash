import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getUserIdForSession, KEY_PREFIX } from '../_lib/auth';
import { getUpstashRedisClient } from '../_lib/redis';

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
  | { type: 'run_end'; score: number }
  | { type: 'oxygen_collected'; count?: number };

function todayKeyUTC(d = new Date()): string {
  return d.toISOString().slice(0, 10);
}

function yesterdayKeyUTC(d = new Date()): string {
  const t = new Date(d);
  t.setUTCDate(t.getUTCDate() - 1);
  return t.toISOString().slice(0, 10);
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
    return JSON.parse(t) as T;
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
  if (streak.lastKeptDate === today) return;

  const yday = yesterdayKeyUTC();
  const next = streak.lastKeptDate === yday ? (streak.current + 1) : 1;
  streak.current = next;
  streak.lastKeptDate = today;
  streak.updatedAt = Date.now();
  progress.keptAt = Date.now();
  await redisRW.set(streakKey, JSON.stringify(streak));
}

function areAllMissionsCompleted(missions: DailyMission[], completedMissionIds: string[]) {
  if (missions.length === 0) return false;
  const done = new Set(completedMissionIds || []);
  return missions.every((m) => done.has(m.id));
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const userId = await getUserIdForSession(req);
  if (!userId) return res.status(401).json({ error: 'Login required' });

  const body = (req.body || {}) as Partial<MissionEvent>;
  if (!body.type) return res.status(400).json({ error: 'Invalid event' });

  const date = todayKeyUTC();
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

  const completedBefore = computeCompleted(missions, progress);

  if (body.type === 'run_end') {
    const score = typeof body.score === 'number' ? body.score : 0;
    progress.runs += 1;
    progress.maxScore = Math.max(progress.maxScore, score);
  } else if (body.type === 'oxygen_collected') {
    const count = typeof body.count === 'number' && body.count > 0 ? Math.floor(body.count) : 1;
    progress.oxygenCollected += count;
  } else {
    return res.status(400).json({ error: 'Invalid event' });
  }

  const completedAfter = computeCompleted(missions, progress);
  progress.completedMissionIds = completedAfter;

  // Kept/Streak rule (per ticket): only when ALL daily missions are completed.
  const shouldKeepToday = areAllMissionsCompleted(missions, completedAfter);
  if (shouldKeepToday) {
    await keepTodayAndUpdateStreak({ userId, date, progress });
  }

  await redisRW.set(progressKey, JSON.stringify(progress));

  return res.status(200).json({
    date,
    progress,
  });
}


