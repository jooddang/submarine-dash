import { Redis } from '@upstash/redis';

const WEEKLY_KEY = 'submarine-dash:leaderboards:weekly:v1';
const LEGACY_KEY = 'submarine-dash:leaderboard';

function usageAndExit(msg) {
  if (msg) console.error(msg);
  console.error(
    [
      '',
      'Usage:',
      '  node scripts/migrate-weekly-leaderboard.mjs --to-week YYYY-MM-DD [--source legacy|week --from-week YYYY-MM-DD] [--clear-week YYYY-MM-DD] [--dry-run]',
      '',
      'Examples:',
      '  # Copy legacy leaderboard into 2025-12-22 (dry-run)',
      '  node scripts/migrate-weekly-leaderboard.mjs --source legacy --to-week 2025-12-22 --dry-run',
      '',
      '  # Copy existing weekly week 2025-12-29 into 2025-12-22',
      '  node scripts/migrate-weekly-leaderboard.mjs --source week --from-week 2025-12-29 --to-week 2025-12-22',
      '',
      '  # After that, clear the current week only',
      '  node scripts/migrate-weekly-leaderboard.mjs --clear-week 2025-12-29',
      '',
    ].join('\n')
  );
  process.exit(1);
}

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const k = a.slice(2);
    if (k === 'dry-run') {
      out.dryRun = true;
      continue;
    }
    const v = argv[i + 1];
    if (!v || v.startsWith('--')) usageAndExit(`Missing value for --${k}`);
    out[k] = v;
    i++;
  }
  return out;
}

function safeJsonParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function ensureStoreShape(x) {
  if (!x || typeof x !== 'object') return { version: 1, weeks: {} };
  if (x.version !== 1) return { version: 1, weeks: {} };
  if (!x.weeks || typeof x.weeks !== 'object') return { version: 1, weeks: {} };
  return x;
}

function assertWeekId(weekId, flagName) {
  if (!weekId) return;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(weekId)) usageAndExit(`Invalid ${flagName}: ${weekId}`);
}

async function main() {
  const args = parseArgs(process.argv);
  const source = (args.source || 'legacy').toString();
  const fromWeek = args['from-week']?.toString() || null;
  const toWeek = args['to-week']?.toString() || null;
  const clearWeek = args['clear-week']?.toString() || null;
  const dryRun = !!args['dry-run'];

  if (!toWeek && !clearWeek) usageAndExit('You must provide --to-week and/or --clear-week');
  if (toWeek) assertWeekId(toWeek, '--to-week');
  if (fromWeek) assertWeekId(fromWeek, '--from-week');
  if (clearWeek) assertWeekId(clearWeek, '--clear-week');
  if (source !== 'legacy' && source !== 'week') usageAndExit(`Invalid --source: ${source}`);
  if (source === 'week' && !fromWeek) usageAndExit('When --source week, you must provide --from-week');

  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url) usageAndExit('Missing Redis URL env. Set KV_REST_API_URL (or UPSTASH_REDIS_REST_URL).');
  if (!token) usageAndExit('Missing Redis token env. Set KV_REST_API_TOKEN (or UPSTASH_REDIS_REST_TOKEN).');

  const redis = new Redis({ url, token });

  const storeRaw = await redis.get(WEEKLY_KEY);
  const storeParsed = typeof storeRaw === 'string' ? safeJsonParse(storeRaw) : storeRaw;
  const store = ensureStoreShape(storeParsed);

  const now = Date.now();

  const updates = [];

  if (toWeek) {
    let entries = [];
    let sourceLabel = 'legacy';
    if (source === 'legacy') {
      const legacyRaw = await redis.get(LEGACY_KEY);
      const legacyParsed = typeof legacyRaw === 'string' ? safeJsonParse(legacyRaw) : legacyRaw;
      entries = Array.isArray(legacyParsed) ? legacyParsed : [];
      sourceLabel = 'legacy';
    } else {
      entries = store.weeks?.[fromWeek]?.entries || [];
      sourceLabel = `week:${fromWeek}`;
    }

    if (!Array.isArray(entries) || entries.length === 0) {
      usageAndExit(`No entries found from source (${sourceLabel}). Aborting.`);
    }

    const prev = store.weeks[toWeek];
    store.weeks[toWeek] = {
      weekId: toWeek,
      startDate: toWeek,
      endDate: prev?.endDate || prev?.startDate || prev?.weekId || undefined,
      entries,
      createdAt: prev?.createdAt ?? now,
      updatedAt: now,
      source: prev?.source ?? 'manual-migrate',
    };

    // Ensure endDate is correct-ish (Mon + 6 days). We avoid importing shared code here.
    // If you want perfect endDate, rely on the API read path which already computes week range.
    try {
      const ms = Date.parse(`${toWeek}T00:00:00Z`);
      if (Number.isFinite(ms)) {
        store.weeks[toWeek].endDate = new Date(ms + 6 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      }
    } catch {
      // ignore
    }

    updates.push(`Copied ${entries.length} entries from ${sourceLabel} -> week ${toWeek}`);
  }

  if (clearWeek) {
    const prev = store.weeks[clearWeek];
    store.weeks[clearWeek] = {
      weekId: clearWeek,
      startDate: clearWeek,
      endDate: prev?.endDate || (() => {
        const ms = Date.parse(`${clearWeek}T00:00:00Z`);
        return Number.isFinite(ms) ? new Date(ms + 6 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10) : clearWeek;
      })(),
      entries: [],
      createdAt: prev?.createdAt ?? now,
      updatedAt: now,
      source: prev?.source ?? 'manual-clear',
    };
    updates.push(`Cleared week ${clearWeek} (entries -> [])`);
  }

  if (updates.length === 0) usageAndExit('Nothing to do.');

  console.log('[migrate-weekly-leaderboard] Planned changes:');
  for (const u of updates) console.log(`- ${u}`);
  console.log(`- dryRun=${dryRun}`);

  if (dryRun) return;

  await redis.set(WEEKLY_KEY, JSON.stringify(store));
  console.log('[migrate-weekly-leaderboard] Done. Wrote weekly store key:', WEEKLY_KEY);
}

main().catch((e) => {
  console.error('[migrate-weekly-leaderboard] Failed:', e);
  process.exit(1);
});



