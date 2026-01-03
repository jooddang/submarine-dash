// Game Physics Constants
export const GRAVITY = 0.6;
export const JUMP_FORCE_INITIAL = -9;
export const JUMP_BOOST_FORCE = 0.6;
export const JUMP_BOOST_MAX_DURATION = 0.4; // Seconds
export const JUMP_BUFFER_TIME = 0.15; // Seconds

// Game Speed Constants
export const GAME_SPEED_START = 6;
export const MAX_SPEED = 14;

// Oxygen Constants
export const OXYGEN_MAX = 30;
export const OXYGEN_DEPLETION_RATE = 1.0;
export const OXYGEN_RESTORE = 8;

// Platform Constants
export const TILE_SIZE = 50;

// Item Spawn Constants
export const TANK_CHANCE = 0.15;
export const SWORDFISH_CHANCE = 0.03;
export const SWORDFISH_DURATION = 5000; // milliseconds
export const SWORDFISH_SPEED_MULT = 3.0;
export const URCHIN_CHANCE = 0.05;
export const URCHIN_SCORE_THRESHOLD = 1000;

// Turtle Shell Item (rescue-from-quicksand)
export const TURTLE_SHELL_UNLOCK_SCORE = 1500;
// "1.5x higher rarity than swordfish" => 1.5x rarer => lower spawn chance
export const TURTLE_SHELL_BASE_CHANCE = SWORDFISH_CHANCE;
// Gets rarer every time user uses it (monotonic decrease)
export const TURTLE_SHELL_RARITY_DECAY_PER_USE = 1; // chance = baseChance / (1 + uses * decay)

// --- Dev / Testing toggles (turn off before shipping) ---
export const DEV_FORCE_TURTLE_SHELL_ON_START = false;
export const DEV_FORCE_DOLPHIN_ON_START = false;
// Dev/testing: force-show the "5 day streak reward" moment + grant dolphin (does NOT mark the reward as claimed,
// so you can repeatedly debug the effect on reload).
export const DEV_FORCE_DOLPHIN_STREAK_REWARD_MOMENT = false;
export const DEV_FORCE_LONG_QUICKSAND_AFTER_TURTLE_SHELL = false;
export const DEV_LONG_QUICKSAND_TILES = 18;
