import { Redis } from '@upstash/redis';

const KEY_PREFIX = 'sd:';
const SAVED_KEY_PREFIX = `${KEY_PREFIX}user:`;
const LEDGER_KEY_PREFIX = `${KEY_PREFIX}user:`;

function usageAndExit(msg) {
  if (msg) console.error(msg);
  console.error(
    [
      '',
      'Usage:',
      '  node scripts/revoke-dolphin.mjs --login-id LOGIN_ID [--amount N] [--dry-run]',
      '  node scripts/revoke-dolphin.mjs --user-id USER_ID [--amount N] [--dry-run]',
      '',
      'Notes:',
      '- Removes dolphins from saved (no negative values).',
      '',
      'Examples:',
      '  node scripts/revoke-dolphin.mjs --login-id jooddang --amount 1',
      '  node scripts/revoke-dolphin.mjs --user-id user_abc123 --amount 3 --dry-run',
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

function keyLoginId(loginIdLower) {
  return `${KEY_PREFIX}loginId:${loginIdLower}`;
}

function keyDolphinSaved(userId) {
  return `${SAVED_KEY_PREFIX}${userId}:dolphin:saved`;
}
function keyDolphinLedger(userId) {
  return `${LEDGER_KEY_PREFIX}${userId}:dolphin:ledger`;
}

function parseIntSafe(raw, fallback = 0) {
  if (raw === null || raw === undefined) return fallback;
  const n = Number.parseInt(String(raw), 10);
  return Number.isFinite(n) ? n : fallback;
}

async function main() {
  const args = parseArgs(process.argv);
  const dryRun = !!args['dry-run'];

  const loginId = (args['login-id'] || '').toString().trim();
  const userIdArg = (args['user-id'] || '').toString().trim();
  if (!loginId && !userIdArg) usageAndExit('Missing --login-id or --user-id');
  if (loginId && userIdArg) usageAndExit('Provide only one of --login-id or --user-id');

  const amount = Number.parseInt(String(args.amount || '1'), 10);
  if (!Number.isFinite(amount) || amount <= 0) usageAndExit('Invalid --amount (must be a positive integer)');

  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url) usageAndExit('Missing Redis URL env. Set KV_REST_API_URL (or UPSTASH_REDIS_REST_URL).');
  if (!token) usageAndExit('Missing Redis token env. Set KV_REST_API_TOKEN (or UPSTASH_REDIS_REST_TOKEN).');

  const redis = new Redis({ url, token });

  let userId = userIdArg;
  if (!userId) {
    const loginIdLower = loginId.toLowerCase();
    const found = await redis.get(keyLoginId(loginIdLower));
    userId = typeof found === 'string' ? found : (found ? String(found) : '');
    if (!userId) usageAndExit(`No userId found for login-id="${loginId}" (key=${keyLoginId(loginIdLower)})`);
  }

  const savedKey = keyDolphinSaved(userId);
  const ledgerKey = keyDolphinLedger(userId);

  const savedRaw = await redis.get(savedKey);
  const saved = Math.max(0, parseIntSafe(savedRaw, 0));

  const removeFromSaved = Math.min(saved, amount);

  console.log('[revoke-dolphin] Planned revoke:');
  console.log(`- userId=${userId}`);
  console.log(`- amount=${amount}`);
  console.log(`- removeFromSaved=${removeFromSaved}`);
  console.log(`- dryRun=${dryRun}`);

  if (dryRun) return;

  if (removeFromSaved > 0) {
    await redis.set(savedKey, String(saved - removeFromSaved));
    await redis.lpush(ledgerKey, JSON.stringify({ ts: Date.now(), type: 'manualRevokeSaved', delta: -removeFromSaved, meta: { via: 'revoke-dolphin.mjs' } }));
  }
  await redis.ltrim(ledgerKey, 0, 99);

  console.log('[revoke-dolphin] OK.');
  console.log(`- saved: ${saved} -> ${saved - removeFromSaved}`);
}

main().catch((e) => {
  console.error('[revoke-dolphin] Failed:', e?.message || e);
  process.exit(1);
});
