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
  deathStreakQuicksand: number;
  deathStreakOxygen: number;
  swordfishCollectedStreak: number;
  swordfishDodgeStreak: number;
  pvpWinStreak: number;
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
      deathStreakQuicksand: 0,
      deathStreakOxygen: 0,
      swordfishCollectedStreak: 0,
      swordfishDodgeStreak: 0,
      pvpWinStreak: 0,
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
  urchinDodges: number;
  swordfishCollected: boolean;
  swordfishDodged: boolean;
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
    p.deathStreakQuicksand = 0;
    p.deathStreakOxygen = 0;
  } else if (run.deathCause === 'quicksand') {
    p.deathStreakQuicksand += 1;
    p.deathStreakUrchin = 0;
    p.deathStreakOxygen = 0;
  } else if (run.deathCause === 'oxygen') {
    p.deathStreakOxygen += 1;
    p.deathStreakUrchin = 0;
    p.deathStreakQuicksand = 0;
  } else {
    p.deathStreakUrchin = 0;
    p.deathStreakQuicksand = 0;
    p.deathStreakOxygen = 0;
  }
  if (p.deathStreakUrchin >= 3) unlock('urchin_magnet');
  if (p.deathStreakQuicksand >= 3) unlock('quicksand_victim');
  if (p.deathStreakOxygen >= 3) unlock('oxygen_choker');

  // ── Urchin dodge (per-run) ──
  if (run.urchinDodges >= 2) unlock('urchin_dodger');
  if (run.urchinDodges >= 3) unlock('urchin_acrobat');

  // ── No-swordfish score ──
  if (!run.swordfishCollected && run.score >= 3000) unlock('purist_3000');
  if (!run.swordfishCollected && run.score >= 5000) unlock('purist_5000');

  // ── Swordfish collection streak (cross-game) ──
  if (run.swordfishCollected) {
    p.swordfishCollectedStreak += 1;
  } else {
    p.swordfishCollectedStreak = 0;
  }
  if (p.swordfishCollectedStreak >= 3) unlock('swordfish_collector');

  // ── Swordfish dodge streak (cross-game) ──
  if (run.swordfishDodged) {
    p.swordfishDodgeStreak += 1;
  } else {
    p.swordfishDodgeStreak = 0;
  }
  if (p.swordfishDodgeStreak >= 2) unlock('swordfish_dodger');

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
    if (dg.consecutiveDays >= 4) unlock('daily_grinder_4');
    if (dg.consecutiveDays >= 5) unlock('daily_grinder_5');
  }

  return { state, newlyUnlocked };
}

// ── Pure evaluation: pvp result ──

export function evaluatePvpResultAchievements(
  state: AchievementState,
  won: boolean,
): { state: AchievementState; newlyUnlocked: string[] } {
  const newlyUnlocked: string[] = [];
  const p = state.progress;

  function unlock(id: string) {
    if (!state.unlocked[id]) {
      state.unlocked[id] = Date.now();
      newlyUnlocked.push(id);
    }
  }

  if (won) {
    p.pvpWinStreak += 1;
  } else {
    p.pvpWinStreak = 0;
  }
  if (p.pvpWinStreak >= 3) unlock('pvp_win_streak_3');

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
