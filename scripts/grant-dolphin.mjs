import { Redis } from '@upstash/redis';

const KEY_PREFIX = 'sd:';
const PENDING_KEY_PREFIX = `${KEY_PREFIX}user:`;
const LEDGER_KEY_PREFIX = `${KEY_PREFIX}user:`;

function usageAndExit(msg) {
  if (msg) console.error(msg);
  console.error(
    [
      '',
      'Usage:',
      '  node scripts/grant-dolphin.mjs --login-id LOGIN_ID --amount N [--dry-run]',
      '  node scripts/grant-dolphin.mjs --user-id USER_ID --amount N [--dry-run]',
      '',
      'Notes:',
      '- This writes Dolphins into Redis pending inventory. They will be settled into saved (max 5) on next /api/auth/me or /api/missions/daily.',
      '- Saved Dolphins are capped at 5, but pending can exceed 5 (no loss).',
      '',
      'Examples:',
      '  node scripts/grant-dolphin.mjs --login-id jooddang --amount 3',
      '  node scripts/grant-dolphin.mjs --user-id user_abc123 --amount 1 --dry-run',
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

function keyDolphinPending(userId) {
  return `${PENDING_KEY_PREFIX}${userId}:dolphin:pending`;
}
function keyDolphinLedger(userId) {
  return `${LEDGER_KEY_PREFIX}${userId}:dolphin:ledger`;
}

async function main() {
  const args = parseArgs(process.argv);
  const dryRun = !!args['dry-run'];

  const loginId = (args['login-id'] || '').toString().trim();
  const userIdArg = (args['user-id'] || '').toString().trim();
  if (!loginId && !userIdArg) usageAndExit('Missing --login-id or --user-id');
  if (loginId && userIdArg) usageAndExit('Provide only one of --login-id or --user-id');

  const amount = Number.parseInt(String(args.amount || ''), 10);
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

  const pendingKey = keyDolphinPending(userId);
  const ledgerKey = keyDolphinLedger(userId);
  console.log('[grant-dolphin] Planned grant:');
  console.log(`- userId=${userId}`);
  console.log(`- amount=${amount}`);
  console.log(`- pendingKey=${pendingKey}`);
  console.log(`- dryRun=${dryRun}`);

  if (dryRun) return;

  const next = await redis.incrby(pendingKey, amount);
  const entry = { ts: Date.now(), type: 'manualGrant', delta: amount, meta: { via: 'grant-dolphin.mjs' } };
  await redis.lpush(ledgerKey, JSON.stringify(entry));
  await redis.ltrim(ledgerKey, 0, 99);
  console.log(`[grant-dolphin] OK. Pending dolphins now: ${next}`);
}

main().catch((e) => {
  console.error('[grant-dolphin] Failed:', e?.message || e);
  process.exit(1);
});

