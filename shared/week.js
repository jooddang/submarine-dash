const PST_TZ = 'America/Los_Angeles';

const weekdayToIndex = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

function partsToMap(parts) {
  const out = {};
  for (const p of parts) out[p.type] = p.value;
  return out;
}

/**
 * Returns a week id in `YYYY-MM-DD` representing the Monday start date of the
 * current week in PST/PDT (America/Los_Angeles). Weeks end on Sunday night (PST/PDT).
 */
export function getPstWeekIdFromEpochMs(epochMs) {
  const d = new Date(epochMs);
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: PST_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
  });
  const map = partsToMap(fmt.formatToParts(d));
  const year = Number(map.year);
  const month = Number(map.month);
  const day = Number(map.day);
  const weekdayShort = map.weekday;
  const weekdayIdx = weekdayToIndex[weekdayShort];
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day) || typeof weekdayIdx !== 'number') {
    throw new Error('Failed to compute PST week id');
  }

  // Treat the PST calendar date as a UTC civil date for stable date math (avoid DST pitfalls).
  const utcMidnightMs = Date.UTC(year, month - 1, day);
  const deltaToMonday = (weekdayIdx + 6) % 7; // Mon => 0, Tue => 1, ... Sun => 6
  const mondayUtcMs = utcMidnightMs - deltaToMonday * 24 * 60 * 60 * 1000;
  return new Date(mondayUtcMs).toISOString().slice(0, 10);
}

export function weekIdToUtcMs(weekId) {
  // weekId is `YYYY-MM-DD` (Monday start). We interpret it as UTC midnight for safe math.
  const ms = Date.parse(`${weekId}T00:00:00Z`);
  if (!Number.isFinite(ms)) throw new Error(`Invalid weekId: ${weekId}`);
  return ms;
}

export function getPrevWeekId(weekId) {
  const ms = weekIdToUtcMs(weekId);
  return new Date(ms - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

export function getWeekEndDate(weekId) {
  const ms = weekIdToUtcMs(weekId);
  return new Date(ms + 6 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

export function getPstCurrentWeekId() {
  return getPstWeekIdFromEpochMs(Date.now());
}


