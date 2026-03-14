import { KEY_PREFIX } from './auth.js';
import type { Redis } from '@upstash/redis';
import { getAchievementRewardCoins } from '../../shared/achievements.js';

// ── Skin rarity lookup (server-side, no rendering data) ──

const SKIN_RARITIES: Record<string, string> = {
  default: 'common', gold: 'common', golden: 'common', ocean_blue: 'common',
  coral_red: 'common', neon_green: 'common', royal_purple: 'common',
  whale: 'rare', orca: 'rare',
  scary_orca: 'epic', octopus: 'epic', jellyfish: 'epic',
  mystical_fish: 'legendary', kraken: 'legendary',
};

const RARE_SKINS = ['whale', 'orca'];
const EPIC_SKINS = ['scary_orca', 'octopus', 'jellyfish'];
const LEGENDARY_SKINS = ['mystical_fish', 'kraken'];

// ── Types ──

type DailyGrinderProgress = {
  lastDate: string | null;
  consecutiveDays: number;
};

export type AchievementProgress = {
  scoreStreak500: number;
  scoreStreak1000: number;
  scoreStreak2000: number;
  scoreStreak3000: number;
  personalBest: number;
  highScoreBeatenStreak: number;
  deathStreakUrchin: number;
  deathCountQuicksand: number;
  dailyGrinder: DailyGrinderProgress;
};

export type AchievementState = {
  unlocked: Record<string, number>; // achievement_id -> timestamp
  progress: AchievementProgress;
};

// ── Redis key ──

function keyAchievements(userId: string) {
  return `${KEY_PREFIX}user:${userId}:achievements`;
}

// ── Default state ──

function defaultState(): AchievementState {
  return {
    unlocked: {},
    progress: {
      scoreStreak500: 0,
      scoreStreak1000: 0,
      scoreStreak2000: 0,
      scoreStreak3000: 0,
      personalBest: 0,
      highScoreBeatenStreak: 0,
      deathStreakUrchin: 0,
      deathCountQuicksand: 0,
      dailyGrinder: { lastDate: null, consecutiveDays: 0 },
    },
  };
}

// ── Redis helpers ──

export async function getAchievementState(redis: Redis, userId: string): Promise<AchievementState> {
  const raw = await redis.get(keyAchievements(userId));
  if (!raw) return defaultState();
  const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
  // Merge with defaults for forward-compat
  const def = defaultState();
  return {
    unlocked: { ...def.unlocked, ...(parsed.unlocked || {}) },
    progress: { ...def.progress, ...(parsed.progress || {}), dailyGrinder: { ...def.progress.dailyGrinder, ...(parsed.progress?.dailyGrinder || {}) } },
  };
}

export async function saveAchievementState(redis: Redis, userId: string, state: AchievementState): Promise<void> {
  await redis.set(keyAchievements(userId), JSON.stringify(state));
}

// ── Pure evaluation: run_end ──

type RunEndData = {
  score: number;
  deathCause: string | null;
  perfectPlatformer: boolean;
  allOxygenCollected: boolean;
};

export function evaluateRunEndAchievements(
  state: AchievementState,
  run: RunEndData,
  equippedSkinId: string,
  dailyRunCount: number,
  todayDate: string,
  weeklyTopScore: number,
): { state: AchievementState; newlyUnlocked: string[] } {
  const newlyUnlocked: string[] = [];
  const p = state.progress;

  function unlock(id: string) {
    if (!state.unlocked[id]) {
      state.unlocked[id] = Date.now();
      newlyUnlocked.push(id);
    }
  }

  // ── Score streaks ──
  const streakConfigs: [number, number, keyof AchievementProgress, string][] = [
    [500, 5, 'scoreStreak500', 'score_streak_500'],
    [1000, 5, 'scoreStreak1000', 'score_streak_1000'],
    [2000, 3, 'scoreStreak2000', 'score_streak_2000'],
    [3000, 3, 'scoreStreak3000', 'score_streak_3000'],
  ];
  for (const [threshold, required, key, achId] of streakConfigs) {
    if (run.score >= threshold) {
      (p as any)[key] = ((p as any)[key] || 0) + 1;
    } else {
      (p as any)[key] = 0;
    }
    if ((p as any)[key] >= required) unlock(achId);
  }

  // ── Beat weekly high score ──
  if (run.score >= 2000 && weeklyTopScore > 0 && run.score > weeklyTopScore) {
    unlock('beat_high_score');
    p.highScoreBeatenStreak += 1;
    if (p.highScoreBeatenStreak >= 2) unlock('beat_high_score_x2');
  } else {
    p.highScoreBeatenStreak = 0;
  }
  p.personalBest = Math.max(p.personalBest, run.score);

  // ── Perfect Platformer ──
  if (run.perfectPlatformer && run.score >= 1500) {
    unlock('perfect_platformer');
  }

  // ── Oxygen Master ──
  if (run.allOxygenCollected && run.score >= 1000) {
    unlock('oxygen_master');
  }

  // ── Skin-score achievements ──
  const rarity = SKIN_RARITIES[equippedSkinId] || 'common';
  if (run.score >= 2500) {
    if (rarity === 'epic') unlock('epic_explorer');
    if (rarity === 'rare') unlock('rare_voyager');
    if (rarity === 'legendary') unlock('legendary_captain');
  }

  // ── Death streaks ──
  if (run.deathCause === 'urchin') {
    p.deathStreakUrchin += 1;
  } else {
    p.deathStreakUrchin = 0;
  }
  if (run.deathCause === 'quicksand') {
    p.deathCountQuicksand += 1;
  }
  if (p.deathStreakUrchin >= 3) unlock('urchin_magnet');
  if (p.deathCountQuicksand >= 3) unlock('quicksand_victim');

  // ── Daily grinder ──
  if (dailyRunCount >= 25) {
    const dg = p.dailyGrinder;
    if (dg.lastDate !== todayDate) {
      // Check if today is the day after lastDate
      if (dg.lastDate) {
        const prev = new Date(`${dg.lastDate}T00:00:00Z`);
        prev.setUTCDate(prev.getUTCDate() + 1);
        const nextDay = prev.toISOString().slice(0, 10);
        dg.consecutiveDays = nextDay === todayDate ? dg.consecutiveDays + 1 : 1;
      } else {
        dg.consecutiveDays = 1;
      }
      dg.lastDate = todayDate;
    }
    if (dg.consecutiveDays >= 1) unlock('daily_grinder_1');
    if (dg.consecutiveDays >= 2) unlock('daily_grinder_2');
    if (dg.consecutiveDays >= 3) unlock('daily_grinder_3');
  }

  return { state, newlyUnlocked };
}

// ── Pure evaluation: skin purchase ──

export function evaluateSkinPurchaseAchievements(
  state: AchievementState,
  ownedSkins: string[],
): { state: AchievementState; newlyUnlocked: string[] } {
  const newlyUnlocked: string[] = [];

  function unlock(id: string) {
    if (!state.unlocked[id]) {
      state.unlocked[id] = Date.now();
      newlyUnlocked.push(id);
    }
  }

  const owned = new Set(ownedSkins);
  if (RARE_SKINS.every((s) => owned.has(s))) unlock('rare_collector');
  if (EPIC_SKINS.every((s) => owned.has(s))) unlock('epic_collector');
  if (LEGENDARY_SKINS.every((s) => owned.has(s))) unlock('legendary_collector');

  return { state, newlyUnlocked };
}

export { getAchievementRewardCoins };
