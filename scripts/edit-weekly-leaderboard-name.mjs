import { Redis } from '@upstash/redis';
import { getPstCurrentWeekId } from '../shared/week.js';

const WEEKLY_KEY = 'submarine-dash:leaderboards:weekly:v1';
const LEGACY_KEY = 'submarine-dash:leaderboard';

function usageAndExit(msg) {
  if (msg) console.error(msg);
  console.error(
    [
      '',
      'Usage:',
      '  node scripts/edit-weekly-leaderboard-name.mjs --name "NEW NAME" [--week YYYY-MM-DD] [--rank N] [--dry-run]',
      '',
      'Notes:',
      '- --week is the weekId (Monday start). If omitted, uses current PST week.',
      '- --rank is 1-based (default 1). Only edits that rank entry if it exists.',
      '- Also updates legacy key (current leaderboard) when editing the current PST week.',
      '',
      'Example:',
      '  node scripts/edit-weekly-leaderboard-name.mjs --name "Claire cannot beat dad Lol :P" --rank 1',
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

function assertWeekId(weekId) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(weekId)) usageAndExit(`Invalid --week: ${weekId}`);
}

async function main() {
  const args = parseArgs(process.argv);
  const newName = args.name?.toString() || '';
  if (!newName.trim()) usageAndExit('Missing --name');

  const weekId = (args.week?.toString() || getPstCurrentWeekId()).trim();
  assertWeekId(weekId);

  const rank = args.rank ? Number.parseInt(String(args.rank), 10) : 1;
  if (!Number.isFinite(rank) || rank < 1 || rank > 5) usageAndExit('Invalid --rank (must be 1..5)');

  const dryRun = !!args['dry-run'];

  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url) usageAndExit('Missing Redis URL env. Set KV_REST_API_URL (or UPSTASH_REDIS_REST_URL).');
  if (!token) usageAndExit('Missing Redis token env. Set KV_REST_API_TOKEN (or UPSTASH_REDIS_REST_TOKEN).');

  const redis = new Redis({ url, token });

  const storeRaw = await redis.get(WEEKLY_KEY);
  const storeParsed = typeof storeRaw === 'string' ? safeJsonParse(storeRaw) : storeRaw;
  const store = ensureStoreShape(storeParsed);

  const week = store.weeks?.[weekId];
  if (!week || !Array.isArray(week.entries) || week.entries.length === 0) {
    usageAndExit(`No weekly entries found for weekId=${weekId}`);
  }
  const idx = rank - 1;
  if (!week.entries[idx]) usageAndExit(`Rank ${rank} does not exist for weekId=${weekId}`);

  const before = week.entries[idx];
  const after = { ...before, name: newName.trim().slice(0, 40) };

  // Apply update
  week.entries[idx] = after;
  week.updatedAt = Date.now();
  store.weeks[weekId] = week;

  console.log('[edit-weekly-leaderboard-name] Planned change:');
  console.log(`- weekId=${weekId} rank=${rank}`);
  console.log(`- before.name="${before.name}"`);
  console.log(`- after.name ="${after.name}"`);
  console.log(`- dryRun=${dryRun}`);

  if (dryRun) return;

  await redis.set(WEEKLY_KEY, JSON.stringify(store));

  // If editing the current PST week, also update the legacy key so old clients match.
  const currentWeekId = getPstCurrentWeekId();
  if (weekId === currentWeekId) {
    const legacyRaw = await redis.get(LEGACY_KEY);
    const legacyParsed = typeof legacyRaw === 'string' ? safeJsonParse(legacyRaw) : legacyRaw;
    if (Array.isArray(legacyParsed) && legacyParsed[idx]) {
      legacyParsed[idx] = { ...legacyParsed[idx], name: after.name };
      await redis.set(LEGACY_KEY, JSON.stringify(legacyParsed));
      console.log('[edit-weekly-leaderboard-name] Also updated legacy leaderboard key for current week.');
    }
  }

  console.log('[edit-weekly-leaderboard-name] Done.');
}

main().catch((e) => {
  console.error('[edit-weekly-leaderboard-name] Failed:', e);
  process.exit(1);
});




