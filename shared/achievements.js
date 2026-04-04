// Achievement catalog — single source of truth for IDs, names, and rewards.
// Shared between client (via import) and server (via require/import).

/** @typedef {'score' | 'skill' | 'skin' | 'death' | 'daily'} AchievementCategory */

/**
 * @typedef {{
 *   id: string;
 *   name: string;
 *   description: string;
 *   category: AchievementCategory;
 *   reward: { type: 'coins'; amount: number };
 * }} AchievementDef
 */

/** @type {AchievementDef[]} */
const ACHIEVEMENT_CATALOG = [
  // ── Score streaks ──
  {
    id: 'score_streak_500',
    name: 'Consistent Swimmer',
    description: 'Score 500+ five times in a row',
    category: 'score',
    reward: { type: 'coins', amount: 30 },
  },
  {
    id: 'score_streak_1000',
    name: 'Endurance Diver',
    description: 'Score 1000+ five times in a row',
    category: 'score',
    reward: { type: 'coins', amount: 55 },
  },
  {
    id: 'score_streak_2000',
    name: 'Deep Sea Pro',
    description: 'Score 2000+ three times in a row',
    category: 'score',
    reward: { type: 'coins', amount: 75 },
  },
  {
    id: 'score_streak_3000',
    name: 'Abyssal Legend',
    description: 'Score 3000+ three times in a row',
    category: 'score',
    reward: { type: 'coins', amount: 75 },
  },
  // ── Weekly high score ──
  {
    id: 'beat_high_score',
    name: 'Personal Best',
    description: 'Beat the #1 weekly leaderboard score (min 2000)',
    category: 'score',
    reward: { type: 'coins', amount: 175 },
  },
  {
    id: 'beat_high_score_x2',
    name: 'On Fire',
    description: 'Beat the weekly high score 2 times in a row',
    category: 'score',
    reward: { type: 'coins', amount: 250 },
  },
  // ── Skill ──
  {
    id: 'perfect_platformer',
    name: 'Perfect Platformer',
    description: 'Land on every island without skipping until score 1500',
    category: 'skill',
    reward: { type: 'coins', amount: 20 },
  },
  {
    id: 'oxygen_master',
    name: 'Oxygen Master',
    description: 'Collect every oxygen tank until score 1000',
    category: 'skill',
    reward: { type: 'coins', amount: 15 },
  },
  // ── Skin score ──
  {
    id: 'epic_explorer',
    name: 'Epic Explorer',
    description: 'Score 2500+ with an epic skin equipped',
    category: 'skin',
    reward: { type: 'coins', amount: 300 },
  },
  {
    id: 'rare_voyager',
    name: 'Rare Voyager',
    description: 'Score 2500+ with a rare skin equipped',
    category: 'skin',
    reward: { type: 'coins', amount: 250 },
  },
  {
    id: 'legendary_captain',
    name: 'Legendary Captain',
    description: 'Score 2500+ with a legendary skin equipped',
    category: 'skin',
    reward: { type: 'coins', amount: 500 },
  },
  // ── Death ──
  {
    id: 'urchin_magnet',
    name: 'Urchin Magnet',
    description: 'Die from an urchin 3 times in a row',
    category: 'death',
    reward: { type: 'coins', amount: 10 },
  },
  {
    id: 'quicksand_victim',
    name: 'Quicksand Victim',
    description: 'Die from quicksand 3 times in a row',
    category: 'death',
    reward: { type: 'coins', amount: 10 },
  },
  // ── Death (oxygen) ──
  {
    id: 'oxygen_choker',
    name: 'Oxygen Choker',
    description: 'Die from oxygen shortage 3 times in a row',
    category: 'death',
    reward: { type: 'coins', amount: 10 },
  },
  // ── Skill (urchin dodge) ──
  {
    id: 'urchin_dodger',
    name: 'Urchin Dodger',
    description: 'Jump over urchins twice in a single game',
    category: 'skill',
    reward: { type: 'coins', amount: 40 },
  },
  {
    id: 'urchin_acrobat',
    name: 'Urchin Acrobat',
    description: 'Jump over urchins three times in a single game',
    category: 'skill',
    reward: { type: 'coins', amount: 80 },
  },
  // ── Skill (swordfish dodge) ──
  {
    id: 'swordfish_dodger',
    name: 'Swordfish Dodger',
    description: 'Jump over a swordfish in 2 games in a row',
    category: 'skill',
    reward: { type: 'coins', amount: 50 },
  },
  // ── Skill (no-swordfish score) ──
  {
    id: 'purist_3000',
    name: 'Purist Diver',
    description: 'Reach score 3000 without using swordfish',
    category: 'skill',
    reward: { type: 'coins', amount: 100 },
  },
  {
    id: 'purist_5000',
    name: 'True Purist',
    description: 'Reach score 5000 without using swordfish',
    category: 'skill',
    reward: { type: 'coins', amount: 200 },
  },
  // ── Streak (swordfish collection) ──
  {
    id: 'swordfish_collector',
    name: 'Swordfish Collector',
    description: 'Collect at least one swordfish in 3 games in a row',
    category: 'skill',
    reward: { type: 'coins', amount: 60 },
  },
  // ── PvP ──
  {
    id: 'pvp_win_streak_3',
    name: 'PvP Champion',
    description: 'Win PvP 3 times in a row',
    category: 'skill',
    reward: { type: 'coins', amount: 150 },
  },
  // ── Daily grinder ──
  {
    id: 'daily_grinder_1',
    name: 'Daily Grinder',
    description: 'Play 25 games in a single day',
    category: 'daily',
    reward: { type: 'coins', amount: 300 },
  },
  {
    id: 'daily_grinder_2',
    name: 'Weekend Warrior',
    description: 'Play 25 games/day for 2 days in a row',
    category: 'daily',
    reward: { type: 'coins', amount: 450 },
  },
  {
    id: 'daily_grinder_3',
    name: 'Marathon Player',
    description: 'Play 25 games/day for 3 days in a row',
    category: 'daily',
    reward: { type: 'coins', amount: 550 },
  },
  {
    id: 'daily_grinder_4',
    name: 'Iron Will',
    description: 'Play 25 games/day for 4 days in a row',
    category: 'daily',
    reward: { type: 'coins', amount: 650 },
  },
  {
    id: 'daily_grinder_5',
    name: 'Unstoppable',
    description: 'Play 25 games/day for 5 days in a row',
    category: 'daily',
    reward: { type: 'coins', amount: 800 },
  },
];

// Lookup helpers
const ACHIEVEMENT_MAP = Object.fromEntries(ACHIEVEMENT_CATALOG.map((a) => [a.id, a]));

function getAchievementById(id) {
  return ACHIEVEMENT_MAP[id] || null;
}

function getAchievementRewardCoins(achievementIds) {
  let total = 0;
  for (const id of achievementIds) {
    const a = ACHIEVEMENT_MAP[id];
    if (a && a.reward.type === 'coins') total += a.reward.amount;
  }
  return total;
}

export { ACHIEVEMENT_CATALOG, ACHIEVEMENT_MAP, getAchievementById, getAchievementRewardCoins };
