import { getPstCurrentWeekId, getWeekEndDate } from '../../shared/week.js';
import { getUpstashRedisClient } from './redis.js';

export const LEGACY_LEADERBOARD_KEY = 'submarine-dash:leaderboard';
export const WEEKLY_LEADERBOARDS_KEY = 'submarine-dash:leaderboards:weekly:v1';
export const WEEKLY_DOLPHIN_CLAIM_KEY_PREFIX = 'sd:reward:weeklyWinnerDolphin:claimed'; // sd:reward:...:<userId>

export const MAX_ENTRIES = 5;

export interface LeaderboardEntry {
  id: number;
  name: string;
  userId?: string; // loginId
  skinId?: string; // equipped skin at time of submission
  score: number;
}

export type WeeklyLeaderboard = {
  weekId: string; // YYYY-MM-DD (Monday start, PST/PDT)
  startDate: string; // YYYY-MM-DD (Monday)
  endDate: string; // YYYY-MM-DD (Sunday)
  entries: LeaderboardEntry[];
  createdAt: number;
  updatedAt: number;
  source?: 'legacy-bootstrap' | 'weekly';
};

type WeeklyStore = {
  version: 1;
  weeks: Record<string, WeeklyLeaderboard>;
};

function parseEntries(data: unknown): LeaderboardEntry[] {
  if (!data) return [];
  if (Array.isArray(data)) return data as LeaderboardEntry[];
  if (typeof data === 'string') {
    const trimmed = data.trim();
    if (!trimmed) return [];
    if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
      const parsed = JSON.parse(trimmed);
      return Array.isArray(parsed) ? (parsed as LeaderboardEntry[]) : [];
    }
    return [];
  }
  return [];
}

function parseStore(data: unknown): WeeklyStore | null {
  if (!data) return null;
  const raw = typeof data === 'string' ? safeJsonParse(data) : data;
  if (!raw || typeof raw !== 'object') return null;
  const v = (raw as any).version;
  const weeks = (raw as any).weeks;
  if (v !== 1 || !weeks || typeof weeks !== 'object') return null;
  return raw as WeeklyStore;
}

function safeJsonParse(s: string): any | null {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

export async function ensureWeeklyStoreBootstrapped(opts?: { nowMs?: number }) {
  const nowMs = opts?.nowMs ?? Date.now();
  const ro = getUpstashRedisClient(true);
  const rw = getUpstashRedisClient(false);

  const existing = parseStore(await ro.get(WEEKLY_LEADERBOARDS_KEY));
  const store: WeeklyStore = existing ?? { version: 1, weeks: {} };

  // Requirement: "현재 leaderboard 는 2025년 12월 마지막 주 리더보드로 기록"
  // We treat the legacy top-5 leaderboard as the last week of Dec 2025 (Mon 2025-12-29 .. Sun 2026-01-04).
  const legacyWeekId = '2025-12-29';
  if (!store.weeks[legacyWeekId]) {
    const legacyRaw = await ro.get(LEGACY_LEADERBOARD_KEY);
    const legacyEntries = parseEntries(legacyRaw);
    if (legacyEntries.length > 0) {
      store.weeks[legacyWeekId] = {
        weekId: legacyWeekId,
        startDate: legacyWeekId,
        endDate: getWeekEndDate(legacyWeekId),
        entries: legacyEntries,
        createdAt: nowMs,
        updatedAt: nowMs,
        source: 'legacy-bootstrap',
      };
    }
  }

  // If store is new or changed by bootstrap, write it back.
  if (!existing || (existing && !existing.weeks[legacyWeekId] && !!store.weeks[legacyWeekId])) {
    await rw.set(WEEKLY_LEADERBOARDS_KEY, JSON.stringify(store));
  }

  return store;
}

export async function readWeeklyStore() {
  const ro = getUpstashRedisClient(true);
  const data = await ro.get(WEEKLY_LEADERBOARDS_KEY);
  return parseStore(data) ?? { version: 1 as const, weeks: {} };
}

export function upsertWeek(store: WeeklyStore, weekId: string, entries: LeaderboardEntry[], nowMs = Date.now()): WeeklyStore {
  const prev = store.weeks[weekId];
  const next: WeeklyLeaderboard = {
    weekId,
    startDate: weekId,
    endDate: getWeekEndDate(weekId),
    entries,
    createdAt: prev?.createdAt ?? nowMs,
    updatedAt: nowMs,
    source: prev?.source ?? 'weekly',
  };
  return { ...store, weeks: { ...store.weeks, [weekId]: next } };
}

export function currentWeekIdPst() {
  return getPstCurrentWeekId();
}

export function claimKeyForWeeklyDolphin(userId: string) {
  return `${WEEKLY_DOLPHIN_CLAIM_KEY_PREFIX}:${userId}`;
}


