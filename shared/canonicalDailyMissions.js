export const DAILY_MISSIONS_VERSION = 'submarine-daily-missions-v1';

const missionTypes = new Set(['reach_score', 'play_runs', 'collect_oxygen']);
const safeInteger = (value, minimum = 0) => Number.isSafeInteger(value) && value >= minimum;
const validDateKey = (value) => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
};

export function validateCanonicalDailyMissions(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.version !== DAILY_MISSIONS_VERSION || value.readOnly !== true
    || !validDateKey(value.date)
    || !Array.isArray(value.missions) || !value.user || typeof value.user !== 'object') {
    throw new Error('canonical daily missions response is invalid');
  }
  const ids = new Set();
  for (const mission of value.missions) {
    if (!mission || typeof mission !== 'object' || typeof mission.id !== 'string' || !mission.id || mission.id.length > 64
      || ids.has(mission.id) || !missionTypes.has(mission.type) || typeof mission.title !== 'string'
      || !mission.title || mission.title.length > 200 || !safeInteger(mission.target, 1) || mission.target > 1_000_000) throw new Error('canonical daily missions response is invalid');
    ids.add(mission.id);
  }
  const progress = value.user.progress;
  const streak = value.user.streak;
  const inventory = value.user.inventory;
  if (!progress || !safeInteger(progress.runs) || !safeInteger(progress.oxygenCollected)
    || !safeInteger(progress.maxScore) || !Array.isArray(progress.completedMissionIds)
    || progress.completedMissionIds.some((id) => typeof id !== 'string' || !ids.has(id))
    || new Set(progress.completedMissionIds).size !== progress.completedMissionIds.length
    || (progress.keptAt !== undefined && !safeInteger(progress.keptAt))
    || !streak || typeof streak !== 'object' || Array.isArray(streak)
    || (streak.current !== undefined && !safeInteger(streak.current))
    || (streak.updatedAt !== undefined && !safeInteger(streak.updatedAt))
    || (streak.lastKeptDate !== undefined && streak.lastKeptDate !== null && !validDateKey(streak.lastKeptDate))
    || !inventory || !safeInteger(inventory.coins) || !safeInteger(inventory.dolphinSaved)
    || !safeInteger(inventory.dolphinPending) || !inventory.tube || !safeInteger(inventory.tube.pieces) || inventory.tube.pieces > 3
    || !safeInteger(inventory.tube.charges) || !inventory.skins || !Array.isArray(inventory.skins.owned)
    || inventory.skins.owned.some((skin) => typeof skin !== 'string' || !skin || skin.length > 64)
    || new Set(inventory.skins.owned).size !== inventory.skins.owned.length
    || !(inventory.skins.equipped === null || (typeof inventory.skins.equipped === 'string'
      && inventory.skins.equipped.length > 0 && inventory.skins.equipped.length <= 64))) {
    throw new Error('canonical daily missions response is invalid');
  }
  return value;
}

export function isCanonicalDailyReadAdmission({ method, origin, expectedOrigin, canonicalToken, enabled, allowedOrigin }) {
  return method === 'GET' && enabled === true && allowedOrigin === true
    && Boolean(canonicalToken) && (origin === expectedOrigin || origin === undefined);
}

export async function executeExpressCanonicalDaily({ canonicalToken, roadcrosserRequest }) {
  return validateCanonicalDailyMissions(await roadcrosserRequest(
    '/api/internal/submarine-dash/daily-missions', { sessionToken: canonicalToken }));
}
