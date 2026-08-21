import express from 'express';
import cors from 'cors';
import Redis from 'ioredis';
import { validateCanaryEquipResponse } from '../../shared/canaryEquip.js';
import { SKIN_CATALOG_VERSION, SKIN_COSTS, validateCanaryPurchaseResponse } from '../../shared/canaryPurchase.js';
import { executeExpressCanonicalDolphin, isExpressDolphinCanaryAdmission } from '../../shared/canaryDolphinExpress.js';
import { executeExpressCanonicalDaily, isCanonicalDailyReadAdmission } from '../../shared/canonicalDailyMissions.js';
import { executeExpressCanonicalGameplay, isCanonicalGameplayAdmission } from '../../shared/canonicalGameplay.js';
import dotenv from 'dotenv';
import { sanitizeLeaderboardName } from '../../shared/profanity.js';
import { getPstCurrentWeekId, getPrevWeekId, getWeekEndDate } from '../../shared/week.js';
import { ACHIEVEMENT_CATALOG, getAchievementRewardCoins } from '../../shared/achievements.js';
import {
  acquireMutationLease,
  createControlledRedis,
  MaintenanceFreezeError,
  productionControlFlags,
  redactedMigrationEvent,
  releaseMutationLease,
  renewMutationLease,
  runWithMutationLease,
  startMutationLeaseRenewal,
} from '../../shared/productionControls.js';
import { localRouteClassification, requiresDurableAdmission } from '../../shared/productionRouteInventory.js';
import { productionRuntimeProbe } from '../../shared/productionRuntimeProbe.js';
import crypto from 'node:crypto';
import { sendGameEvent } from '../../api/_lib/telegram.js';

// Load environment variables from parent directory
dotenv.config({ path: '../.env' });

const app = express();
const PORT = process.env.PORT || 3001;
const LEGACY_LEADERBOARD_KEY = 'submarine-dash:leaderboard';
const WEEKLY_LEADERBOARDS_KEY = 'submarine-dash:leaderboards:weekly:v1';
const WEEKLY_DOLPHIN_CLAIM_KEY_PREFIX = 'sd:reward:weeklyWinnerDolphin:claimed';
const DOLPHIN_GRANT_KEY_PREFIX = 'sd:reward:dolphin:grant'; // legacy back-compat
const MAX_ENTRIES = 5;
const CLEAR_ALLOWED = process.env.ALLOW_LEADERBOARD_CLEAR === 'true';

const GAME_EVENT_TYPES = new Set(['game_started', 'game_died', 'leaderboard_name_submitted']);
const GAME_EVENT_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Auth (shared prefix with Vercel functions)
const KEY_PREFIX = 'sd:';
const SESSION_COOKIE_NAME = 'sd_session';
const CANONICAL_SESSION_COOKIE_NAME = 'sd_roadcrosser_session';
const ROAD_CROSSER_STATE_COOKIE_NAME = 'sd_rc_state';
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days

// Initialize Redis client
let rawRedis = null;
let redis = null;
try {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    console.warn('⚠️  REDIS_URL not set. Leaderboard will not persist.');
  } else {
    rawRedis = new Redis(redisUrl, {
      maxRetriesPerRequest: 3,
      enableOfflineQueue: false,
    });

    rawRedis.on('connect', () => {
      console.log('✅ Connected to Redis');
    });

    rawRedis.on('error', (err) => {
      console.error('❌ Redis error:', err.message);
    });

    const adapter = {
      eval: (script, keys, args) => rawRedis.eval(script, keys.length, ...keys, ...args.map(String)),
    };
    redis = createControlledRedis(rawRedis, adapter, productionControlFlags());
  }
} catch (error) {
  console.error('❌ Failed to initialize Redis:', error.message);
}

// Middleware
app.use(cors({
  origin: (origin, cb) => {
    // Allow same-origin and local dev origins
    if (!origin) return cb(null, true);
    if (origin === 'https://submarine-dash.roadcrosser.com') return cb(null, true);
    if (origin === 'http://localhost:5173') return cb(null, true);
    if (origin.startsWith('http://localhost:')) return cb(null, true);
    return cb(null, false);
  },
  credentials: true,
}));
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

app.use(async (req, res, next) => {
  const credentialMutationRoute = new Set([
    '/api/auth/login',
    '/api/auth/logout',
    '/api/auth/register',
    '/api/auth/change-password',
  ]).has(req.path);
  if (req.method === 'POST' && credentialMutationRoute && !isAllowedSubmarineMutationOrigin(req)) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  const canonicalToken = parseCookies(req)[CANONICAL_SESSION_COOKIE_NAME];
  const transitionRoute = new Set([
    '/api/auth/login',
    '/api/auth/logout',
    '/api/auth/roadcrosser/callback',
  ]).has(req.path);
  const mutationMethod = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
  const canaryMutationRoute = req.method === 'POST' && new Set([
    '/api/inventory/skin/equip',
    '/api/inventory/skin/purchase',
  ]).has(req.path);
  const dolphinCanaryRoute = req.method === 'POST' && new Set([
    '/api/inventory/dolphin/consume','/api/inventory/dolphin/import',
  ]).has(req.path);
  const expectedCanaryOrigin = process.env.SD_SUBMARINE_PUBLIC_ORIGIN || 'https://submarine-dash.roadcrosser.com';
  const canaryEquipOriginAllowed = req.headers.origin === expectedCanaryOrigin && isAllowedSubmarineMutationOrigin(req);
  if (canonicalToken && canaryMutationRoute && process.env.SD_SUPABASE_WRITE_CANARY_ENABLED === 'true'
    && !canaryEquipOriginAllowed) return res.status(403).json({ error: 'Origin not allowed' });
  const canaryMutationEnabled = canaryMutationRoute
    && process.env.SD_SUPABASE_WRITE_CANARY_ENABLED === 'true'
    && canaryEquipOriginAllowed;
  const dolphinCanaryEnabled = isExpressDolphinCanaryAdmission({method:req.method,path:req.path,origin:req.headers.origin,
    expectedOrigin:expectedCanaryOrigin,canonicalToken,enabled:process.env.SD_SUPABASE_DOLPHIN_WRITE_CANARY_ENABLED === 'true',
    allowedOrigin:isAllowedSubmarineMutationOrigin(req)});
  const dailyReadEnabled = req.path === '/api/missions/daily' && isCanonicalDailyReadAdmission({
    method:req.method,origin:req.headers.origin,expectedOrigin:expectedCanaryOrigin,canonicalToken,
    enabled:process.env.SD_SUPABASE_DAILY_READ_ENABLED === 'true',allowedOrigin:isAllowedSubmarineMutationOrigin(req),
  });
  const gameplayWriteEnabled = isCanonicalGameplayAdmission({
    method:req.method,path:req.path,origin:req.headers.origin,expectedOrigin:expectedCanaryOrigin,canonicalToken,
    enabled:process.env.SD_SUPABASE_GAMEPLAY_WRITES_ENABLED === 'true',allowedOrigin:isAllowedSubmarineMutationOrigin(req),
  });
  const canonicalDailyBoundary = Boolean(canonicalToken) && req.method === 'GET' && req.path === '/api/missions/daily';
  const canonicalGameplayBoundary = Boolean(canonicalToken) && req.method === 'POST' && req.path === '/api/missions/event';
  const leaderboardBootstrapRead = req.method === 'GET'
    && (req.path === '/api/leaderboard' || req.path === '/api/leaderboard/weekly');
  if (canonicalGameplayBoundary) {
    if (gameplayWriteEnabled) return next();
    return res.status(req.headers.origin !== expectedCanaryOrigin ? 403 : 409)
      .json({ error: 'Canonical gameplay settlement is not enabled' });
  }
  if (canonicalToken && !transitionRoute && !canaryMutationEnabled && !dolphinCanaryEnabled && !gameplayWriteEnabled
    && (mutationMethod || leaderboardBootstrapRead)) {
    return res.status(409).json({
      error: 'Canonical account progress is read-only in Submarine Dash',
      code: 'CANONICAL_READ_ONLY',
    });
  }
  if (canonicalDailyBoundary) {
    if (dailyReadEnabled) return next();
    return res.status(409).json({ error: 'Canonical daily missions are not enabled' });
  }
  if (canonicalToken && (canaryMutationEnabled || dolphinCanaryEnabled || gameplayWriteEnabled)) return next();

  const classification = localRouteClassification(req.path, req.method);
  const flags = productionControlFlags();
  if (!flags.admissionGate || !requiresDurableAdmission(classification) || !rawRedis) return next();

  const adapter = {
    eval: (script, keys, args) => rawRedis.eval(script, keys.length, ...keys, ...args.map(String)),
  };
  let lease;
  try {
    lease = await acquireMutationLease(adapter, `${req.method}:${req.path}`);
  } catch (error) {
    if (!(error instanceof MaintenanceFreezeError)) return next(error);
    res.setHeader('Retry-After', '30');
    redactedMigrationEvent({ event: 'mutation_rejected', phase: 0, route: req.path, outcome: 'maintenance' });
    return res.status(503).json({
      error: error.code,
      message: 'Game progress is temporarily paused for maintenance. Please retry shortly.',
      retryable: true,
    });
  }

  const renewal = startMutationLeaseRenewal(lease, {
    renew: renewMutationLease,
    onExpired: () => redactedMigrationEvent({ event: 'lease_expired', phase: 0, route: req.path, outcome: 'blocked' }),
    onError: () => redactedMigrationEvent({ event: 'lease_renewal_failed', phase: 0, route: req.path, outcome: 'blocked' }),
  });

  let releasePromise = null;
  const release = () => {
    if (releasePromise) return;
    releasePromise = renewal.stop().then(() => releaseMutationLease(lease)).catch(() => {
      redactedMigrationEvent({ event: 'lease_release_failed', phase: 0, route: req.path, outcome: 'blocked' });
    });
  };
  res.once('finish', release);
  res.once('close', release);
  return runWithMutationLease(lease, () => next());
});

function base64Url(bytes) {
  return bytes
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function generateId(prefix) {
  return `${prefix}_${base64Url(crypto.randomBytes(16))}`;
}

function generateRefCode() {
  return base64Url(crypto.randomBytes(6));
}

function parseCookies(req) {
  const header = req.headers.cookie;
  if (!header) return {};
  const out = {};
  const parts = header.split(/;\s*/g);
  for (const part of parts) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    out[k] = decodeURIComponent(v);
  }
  return out;
}

function setSessionCookie(req, res, token) {
  const proto = (req.headers['x-forwarded-proto'] || '').toString();
  const isSecure = req.secure || proto === 'https';
  const parts = [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${SESSION_TTL_SECONDS}`,
  ];
  // Secure cookies won't be set on http://localhost
  if (isSecure) parts.push('Secure');
  appendCookie(res, parts.join('; '));
}

function clearSessionCookie(req, res) {
  const proto = (req.headers['x-forwarded-proto'] || '').toString();
  const isSecure = req.secure || proto === 'https';
  const parts = [
    `${SESSION_COOKIE_NAME}=`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=0',
  ];
  if (isSecure) parts.push('Secure');
  appendCookie(res, parts.join('; '));
}

function appendCookie(res, cookie) {
  const current = res.getHeader('Set-Cookie');
  const cookies = Array.isArray(current) ? current : current ? [String(current)] : [];
  res.setHeader('Set-Cookie', [...cookies, cookie]);
}

function secureCookiePart(req) {
  const proto = (req.headers['x-forwarded-proto'] || '').toString();
  return req.secure || proto === 'https' ? '; Secure' : '';
}

function setRoadcrosserStateCookie(req, res, state) {
  const secure = secureCookiePart(req);
  appendCookie(res, `${ROAD_CROSSER_STATE_COOKIE_NAME}=${encodeURIComponent(state)}; Path=/api/auth/roadcrosser/callback; HttpOnly; SameSite=${secure ? 'None' : 'Lax'}; Max-Age=300${secure}`);
}

function clearRoadcrosserStateCookie(req, res) {
  const secure = secureCookiePart(req);
  appendCookie(res, `${ROAD_CROSSER_STATE_COOKIE_NAME}=; Path=/api/auth/roadcrosser/callback; HttpOnly; SameSite=${secure ? 'None' : 'Lax'}; Max-Age=0${secure}`);
}

function setCanonicalSessionCookie(req, res, token) {
  appendCookie(res, `${CANONICAL_SESSION_COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_SECONDS}${secureCookiePart(req)}`);
}

function clearCanonicalSessionCookie(req, res) {
  appendCookie(res, `${CANONICAL_SESSION_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secureCookiePart(req)}`);
}

function roadcrosserBaseUrl() {
  const value = process.env.SD_ROADCROSSER_INTERNAL_BASE_URL || 'https://www.roadcrosser.com';
  if (value === 'https://www.roadcrosser.com' || (process.env.NODE_ENV !== 'production' && /^http:\/\/(?:localhost|127\.0\.0\.1):[0-9]+$/.test(value))) return value;
  throw new Error('Roadcrosser internal base URL is invalid');
}

async function roadcrosserRequest(path, body) {
  const allowed = new Set([
    '/api/internal/submarine-dash/tickets/consume',
    '/api/internal/submarine-dash/sessions/resolve',
    '/api/internal/submarine-dash/sessions/revoke',
    '/api/internal/submarine-dash/bootstrap',
    '/api/internal/submarine-dash/mutations/equip-skin',
    '/api/internal/submarine-dash/mutations/purchase-skin',
    '/api/internal/submarine-dash/mutations/consume-dolphin',
    '/api/internal/submarine-dash/mutations/import-dolphin',
    '/api/internal/submarine-dash/daily-missions',
    '/api/internal/submarine-dash/mutations/settle-gameplay',
  ]);
  if (!allowed.has(path)) throw new Error('Roadcrosser internal path is forbidden');
  const credential = process.env.SD_ROADCROSSER_INTERNAL_AUTH_TOKEN;
  if (!credential || credential.length < 32) throw new Error('Roadcrosser internal client is not configured');
  const response = await fetch(`${roadcrosserBaseUrl()}${path}`, {
    method: 'POST', headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json' },
    body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(5000),
  });
  const text = await response.text();
  if (!response.ok || text.length > 16 * 1024) throw new Error('Roadcrosser canonical auth request failed');
  return text ? JSON.parse(text) : {};
}

function normalizeOnlineRoomConfig(config) {
  const input = config && typeof config === 'object' ? config : {};
  const sanitizeBet = (bet) => {
    const raw = bet && typeof bet === 'object' ? bet : {};
    return {
      coins: Math.max(0, Math.floor(raw.coins || 0)),
      dolphins: Math.max(0, Math.floor(raw.dolphins || 0)),
      tubePieces: Math.max(0, Math.floor(raw.tubePieces || 0)),
    };
  };

  return {
    format: input.format === 'bo3' || input.format === 'bo5' || input.format === 'single' ? input.format : 'single',
    powerUpMode:
      input.powerUpMode === 'inventory' ||
      input.powerUpMode === 'earned' ||
      input.powerUpMode === 'none' ||
      input.powerUpMode === 'score_attack'
        ? input.powerUpMode
        : 'earned',
    betting: Boolean(input.betting),
    p1Bet: sanitizeBet(input.p1Bet),
    p2Bet: sanitizeBet(input.p2Bet),
  };
}

async function getActivePvpRoomMembership(userId) {
  if (!redis) return null;
  const key = `sd:pvp:room-membership:${userId}`;
  const roomId = await redis.get(key);
  if (!roomId) return null;
  const raw = await redis.get(`sd:pvp:room:${roomId}`);
  if (!raw) {
    await redis.del(key);
    return null;
  }
  try {
    const room = JSON.parse(raw);
    if (room && room.phase !== 'CANCELED' && room.phase !== 'COMPLETED') {
      return roomId;
    }
  } catch {}
  await redis.del(key);
  return null;
}

async function listJoinableRooms() {
  const roomIds = await redis.smembers('sd:pvp:rooms:all');
  const rooms = [];
  for (const roomId of roomIds || []) {
    const raw = await redis.get(`sd:pvp:room:${roomId}`);
    if (!raw) {
      await redis.srem('sd:pvp:rooms:all', roomId);
      continue;
    }
    try {
      const room = JSON.parse(raw);
      if (room.phase === 'OPEN' && room.slots?.guest === null) {
        rooms.push(room);
      } else if (room.phase === 'CANCELED' || room.phase === 'COMPLETED') {
        await redis.srem('sd:pvp:rooms:all', roomId);
      }
    } catch {
      await redis.srem('sd:pvp:rooms:all', roomId);
    }
  }
  rooms.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  return rooms;
}

function keyLoginId(loginIdLower) {
  return `${KEY_PREFIX}loginId:${loginIdLower}`;
}
function keyUser(userId) {
  return `${KEY_PREFIX}user:${userId}`;
}
function keySession(token) {
  return `${KEY_PREFIX}session:${token}`;
}

// Legacy-session dolphin inventory keys. Canonical accounts use Supabase.
function keyDolphinSaved(userId) {
  return `${KEY_PREFIX}user:${userId}:dolphin:saved`;
}
function keyDolphinPending(userId) {
  return `${KEY_PREFIX}user:${userId}:dolphin:pending`;
}
function keyDolphinLedger(userId) {
  return `${KEY_PREFIX}user:${userId}:dolphin:ledger`;
}
function keyDolphinStreakLastAwarded(userId) {
  return `${KEY_PREFIX}user:${userId}:reward:dolphin:streak:lastAwarded`;
}

function parseIntSafe(raw, fallback = 0) {
  if (raw === null || raw === undefined) return fallback;
  const n = Number.parseInt(String(raw), 10);
  return Number.isFinite(n) ? n : fallback;
}

async function pushDolphinLedger(userId, entry) {
  if (!redis) return;
  try {
    const key = keyDolphinLedger(userId);
    await redis.lpush(key, JSON.stringify(entry));
    await redis.ltrim(key, 0, 99);
  } catch {
    // best-effort
  }
}

async function addPendingDolphins(userId, amount, meta) {
  return addSavedDolphins(userId, amount, meta);
}

async function addSavedDolphins(userId, amount, meta) {
  if (!redis) return 0;
  const n = Math.max(0, Math.floor(amount || 0));
  if (n <= 0) return 0;
  await redis.incrby(keyDolphinSaved(userId), n);
  await pushDolphinLedger(userId, { ts: Date.now(), type: meta?.type || 'grant', delta: n, meta: meta?.meta });
  return n;
}

async function migratePendingDolphins(userId) {
  if (!redis) return { saved: 0, moved: 0 };
  const savedKey = keyDolphinSaved(userId);
  const pendingKey = keyDolphinPending(userId);
  const savedRaw = await redis.get(savedKey);
  const pendingRaw = await redis.get(pendingKey);
  const saved = Math.max(0, parseIntSafe(savedRaw, 0));
  const pending = Math.max(0, parseIntSafe(pendingRaw, 0));
  if (pending > 0) {
    const nextSaved = saved + pending;
    await redis.set(savedKey, String(nextSaved));
    await redis.set(pendingKey, '0');
    await pushDolphinLedger(userId, { ts: Date.now(), type: 'migratePending', delta: pending });
    return { saved: nextSaved, moved: pending };
  }
  if (savedRaw !== String(saved)) await redis.set(savedKey, String(saved));
  if (pendingRaw !== String(pending)) await redis.set(pendingKey, String(pending));
  return { saved, moved: 0 };
}

// Legacy-session coin inventory keys. Canonical accounts use Supabase.
function keyCoinBalance(userId) {
  return `${KEY_PREFIX}user:${userId}:coins`;
}
function keyCoinLedger(userId) {
  return `${KEY_PREFIX}user:${userId}:coin:ledger`;
}

async function pushCoinLedger(userId, entry) {
  if (!redis) return;
  try {
    const key = keyCoinLedger(userId);
    await redis.lpush(key, JSON.stringify(entry));
    await redis.ltrim(key, 0, 99);
  } catch {
    // best-effort
  }
}

async function getCoinBalance(userId) {
  if (!redis) return 0;
  const raw = await redis.get(keyCoinBalance(userId));
  return Math.max(0, parseIntSafe(raw, 0));
}

async function addCoins(userId, amount, meta) {
  if (!redis) return 0;
  const n = Math.max(0, Math.floor(amount || 0));
  if (n <= 0) return getCoinBalance(userId);
  await redis.incrby(keyCoinBalance(userId), n);
  await pushCoinLedger(userId, { ts: Date.now(), type: meta?.type || 'grant', delta: n, meta: meta?.meta });
  return getCoinBalance(userId);
}

// Legacy-session tube inventory keys. Canonical accounts use Supabase.
function keyTubeState(userId) {
  return `${KEY_PREFIX}user:${userId}:tube`;
}

async function getTubeState(userId) {
  if (!redis) return { pieces: 0, charges: 0 };
  const raw = await redis.get(keyTubeState(userId));
  if (!raw) return { pieces: 0, charges: 0 };
  try {
    const state = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return {
      pieces: Math.max(0, Math.min(3, Math.floor(state?.pieces ?? 0))),
      charges: Math.max(0, Math.min(3, Math.floor(state?.charges ?? 0))),
    };
  } catch {
    return { pieces: 0, charges: 0 };
  }
}

async function saveTubeState(userId, pieces, charges) {
  if (!redis) return { pieces: 0, charges: 0 };
  const state = {
    pieces: Math.max(0, Math.min(3, Math.floor(pieces))),
    charges: Math.max(0, Math.min(3, Math.floor(charges))),
  };
  await redis.set(keyTubeState(userId), JSON.stringify(state));
  return state;
}

// ── Skin inventory helpers ──
function keySkinOwned(userId) {
  return `${KEY_PREFIX}user:${userId}:skins:owned`;
}
function keySkinEquipped(userId) {
  return `${KEY_PREFIX}user:${userId}:skins:equipped`;
}
async function getSkinState(userId) {
  if (!redis) return { owned: ['default'], equipped: 'default' };
  const [ownedRaw, equippedRaw] = await Promise.all([
    redis.smembers(keySkinOwned(userId)),
    redis.get(keySkinEquipped(userId)),
  ]);
  const owned = Array.isArray(ownedRaw) ? ownedRaw : [];
  if (!owned.includes('default')) owned.push('default');
  const equipped = typeof equippedRaw === 'string' && equippedRaw ? equippedRaw : 'default';
  return { owned, equipped };
}
async function addOwnedSkin(userId, skinId) {
  if (!redis) return;
  await redis.sadd(keySkinOwned(userId), skinId);
}
async function equipSkin(userId, skinId) {
  if (!redis) return { ok: false, equipped: '' };
  const isOwned = await redis.sismember(keySkinOwned(userId), skinId);
  if (!isOwned && skinId !== 'default') return { ok: false, equipped: '' };
  await redis.set(keySkinEquipped(userId), skinId);
  return { ok: true, equipped: skinId };
}
// ── Achievement helpers ──

const SKIN_RARITIES = {
  default: 'common', gold: 'common', golden: 'common', ocean_blue: 'common',
  coral_red: 'common', neon_green: 'common', royal_purple: 'common',
  whale: 'rare', orca: 'rare',
  scary_orca: 'epic', octopus: 'epic', jellyfish: 'epic',
  mystical_fish: 'legendary', kraken: 'legendary',
};

function keyAchievements(userId) {
  return `${KEY_PREFIX}user:${userId}:achievements`;
}

function defaultAchievementState() {
  return {
    unlocked: {},
    progress: {
      scoreStreak500: 0, scoreStreak1000: 0, scoreStreak2000: 0, scoreStreak3000: 0,
      personalBest: 0, highScoreBeatenStreak: 0,
      deathStreakUrchin: 0, deathStreakQuicksand: 0,
      dailyGrinder: { lastDate: null, consecutiveDays: 0 },
    },
  };
}

async function getAchievementState(userId) {
  if (!redis) return defaultAchievementState();
  const raw = await redis.get(keyAchievements(userId));
  if (!raw) return defaultAchievementState();
  const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
  const def = defaultAchievementState();
  return {
    unlocked: { ...def.unlocked, ...(parsed.unlocked || {}) },
    progress: { ...def.progress, ...(parsed.progress || {}), dailyGrinder: { ...def.progress.dailyGrinder, ...(parsed.progress?.dailyGrinder || {}) } },
  };
}

async function saveAchievementState(userId, state) {
  if (!redis) return;
  await redis.set(keyAchievements(userId), JSON.stringify(state));
}

function evaluateRunEndAchievements(state, run, equippedSkinId, dailyRunCount, todayDate, weeklyTopScore) {
  const newlyUnlocked = [];
  const p = state.progress;

  function unlock(id) {
    if (!state.unlocked[id]) {
      state.unlocked[id] = Date.now();
      newlyUnlocked.push(id);
    }
  }

  // Score streaks
  const streakConfigs = [
    [500, 5, 'scoreStreak500', 'score_streak_500'],
    [1000, 5, 'scoreStreak1000', 'score_streak_1000'],
    [2000, 3, 'scoreStreak2000', 'score_streak_2000'],
    [3000, 3, 'scoreStreak3000', 'score_streak_3000'],
  ];
  for (const [threshold, required, key, achId] of streakConfigs) {
    if (run.score >= threshold) { p[key] = (p[key] || 0) + 1; }
    else { p[key] = 0; }
    if (p[key] >= required) unlock(achId);
  }

  // Beat weekly high score
  if (run.score >= 2000 && weeklyTopScore > 0 && run.score > weeklyTopScore) {
    unlock('beat_high_score');
    p.highScoreBeatenStreak += 1;
    if (p.highScoreBeatenStreak >= 2) unlock('beat_high_score_x2');
  } else {
    p.highScoreBeatenStreak = 0;
  }
  p.personalBest = Math.max(p.personalBest, run.score);

  // Perfect Platformer
  if (run.perfectPlatformer && run.score >= 1500) unlock('perfect_platformer');

  // Oxygen Master
  if (run.allOxygenCollected && run.score >= 1000) unlock('oxygen_master');

  // Skin-score achievements
  const rarity = SKIN_RARITIES[equippedSkinId] || 'common';
  if (run.score >= 2500) {
    if (rarity === 'epic') unlock('epic_explorer');
    if (rarity === 'rare') unlock('rare_voyager');
    if (rarity === 'legendary') unlock('legendary_captain');
  }

  // Death streaks
  if (run.deathCause === 'urchin') { p.deathStreakUrchin += 1; p.deathStreakQuicksand = 0; }
  else if (run.deathCause === 'quicksand') { p.deathStreakQuicksand += 1; p.deathStreakUrchin = 0; }
  else { p.deathStreakUrchin = 0; p.deathStreakQuicksand = 0; }
  if (p.deathStreakUrchin >= 3) unlock('urchin_magnet');
  if (p.deathStreakQuicksand >= 3) unlock('quicksand_victim');

  // Daily grinder
  if (dailyRunCount >= 25) {
    const dg = p.dailyGrinder;
    if (dg.lastDate !== todayDate) {
      if (dg.lastDate) {
        const prev = new Date(`${dg.lastDate}T00:00:00Z`);
        prev.setUTCDate(prev.getUTCDate() + 1);
        const nextDay = prev.toISOString().slice(0, 10);
        dg.consecutiveDays = nextDay === todayDate ? dg.consecutiveDays + 1 : 1;
      } else { dg.consecutiveDays = 1; }
      dg.lastDate = todayDate;
    }
    if (dg.consecutiveDays >= 1) unlock('daily_grinder_1');
    if (dg.consecutiveDays >= 2) unlock('daily_grinder_2');
    if (dg.consecutiveDays >= 3) unlock('daily_grinder_3');
  }

  return { state, newlyUnlocked };
}

function computeCoinsForScore(score) {
  if (score < 500) return 0;
  if (score < 1000) return 5;
  if (score < 3000) return 10;
  if (score < 5000) return 20;
  if (score < 7000) return 35;
  if (score < 9000) return 50;
  return 75;
}

async function consumeOneSavedDolphin(userId) {
  await migratePendingDolphins(userId);
  const savedRaw = await redis.get(keyDolphinSaved(userId));
  const saved = Math.max(0, parseIntSafe(savedRaw, 0));
  if (saved <= 0) return { ok: false, saved };
  const next = Math.max(0, saved - 1);
  await redis.set(keyDolphinSaved(userId), String(next));
  await pushDolphinLedger(userId, { ts: Date.now(), type: 'consume', delta: -1 });
  return { ok: true, saved: next };
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = await new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 64, { N: 16384, r: 8, p: 1 }, (err, derivedKey) => {
      if (err) reject(err);
      else resolve(derivedKey);
    });
  });
  return { saltB64: salt.toString('base64'), hashB64: Buffer.from(hash).toString('base64') };
}

async function verifyPassword(password, saltB64, hashB64) {
  const salt = Buffer.from(saltB64, 'base64');
  const expected = Buffer.from(hashB64, 'base64');
  const actual = await new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 64, { N: 16384, r: 8, p: 1 }, (err, derivedKey) => {
      if (err) reject(err);
      else resolve(derivedKey);
    });
  });
  const actualBuf = Buffer.from(actual);
  if (actualBuf.length !== expected.length) return false;
  return crypto.timingSafeEqual(actualBuf, expected);
}

async function isRateLimited(key, limit, windowSeconds) {
  if (!redis) return false;
  const k = `${KEY_PREFIX}rl:${key}`;
  const count = await redis.incr(k);
  if (count === 1) await redis.expire(k, windowSeconds);
  return count > limit;
}

async function getUserIdForSession(req) {
  if (!redis) return null;
  const cookies = parseCookies(req);
  if (cookies[CANONICAL_SESSION_COOKIE_NAME]) return null;
  const token = cookies[SESSION_COOKIE_NAME];
  if (!token) return null;
  const userId = await redis.get(keySession(token));
  return userId || null;
}

async function getUser(userId) {
  if (!redis) return null;
  const raw = await redis.get(keyUser(userId));
  if (!raw) return null;
  return JSON.parse(raw);
}

// --- Missions (dev backend) ---
function todayKeyUTC(d = new Date()) {
  return d.toISOString().slice(0, 10);
}

function yesterdayKeyUTC(d = new Date()) {
  const t = new Date(d);
  t.setUTCDate(t.getUTCDate() - 1);
  return t.toISOString().slice(0, 10);
}

function tzOffsetFromReq(req) {
  const raw = req?.headers?.['x-tz-offset-min'];
  const v = Array.isArray(raw) ? raw[0] : raw;
  if (!v) return null;
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return null;
  if (n < -14 * 60 || n > 14 * 60) return null;
  return n;
}

function dateKeyFromOffsetMinutes(offsetMin, nowMs = Date.now()) {
  // offsetMin is minutes to add to local time to get UTC (Date.getTimezoneOffset()).
  // local = utc - offsetMin
  const localMs = nowMs - offsetMin * 60_000;
  return new Date(localMs).toISOString().slice(0, 10);
}

function todayKeyForReq(req) {
  const off = tzOffsetFromReq(req);
  return off !== null ? dateKeyFromOffsetMinutes(off) : todayKeyUTC();
}

function keyDailyMissions(date) {
  return `${KEY_PREFIX}missions:daily:${date}`;
}

function keyUserDaily(userId, date) {
  return `${KEY_PREFIX}user:${userId}:daily:${date}`;
}

function keyUserStreak(userId) {
  return `${KEY_PREFIX}user:${userId}:streak`;
}

function defaultMissions() {
  return [
    { id: 'reach_800', type: 'reach_score', title: 'Reach 800 points', target: 800 },
    { id: 'runs_3', type: 'play_runs', title: 'Play 3 runs', target: 3 },
    { id: 'oxygen_3', type: 'collect_oxygen', title: 'Collect 3 oxygen tanks', target: 3 },
  ];
}

function computeCompleted(missions, progress) {
  const out = new Set(progress.completedMissionIds || []);
  for (const m of missions) {
    if (m.type === 'reach_score' && (progress.maxScore || 0) >= m.target) out.add(m.id);
    if (m.type === 'play_runs' && (progress.runs || 0) >= m.target) out.add(m.id);
    if (m.type === 'collect_oxygen' && (progress.oxygenCollected || 0) >= m.target) out.add(m.id);
  }
  return [...out];
}

function hasAnyCompletion(before, after) {
  if (!after || after.length === 0) return false;
  if (!before || before.length === 0) return after.length > 0;
  const b = new Set(before);
  for (const a of after) if (!b.has(a)) return true;
  return false;
}

function areAllMissionsCompleted(missions, completedMissionIds) {
  if (!missions || missions.length === 0) return false;
  const done = new Set(completedMissionIds || []);
  return missions.every((m) => done.has(m.id));
}

async function keepTodayAndUpdateStreak(userId, date, progress) {
  const streakKey = keyUserStreak(userId);
  const streakRaw = await redis.get(streakKey);
  const streak = streakRaw ? JSON.parse(streakRaw) : { current: 0, lastKeptDate: null, updatedAt: Date.now() };

  if (streak.lastKeptDate === date) return { streak, didUpdate: false, didReset: false };

  // Compute "yesterday" based on the provided `date` to avoid edge cases around midnight.
  const yday = yesterdayKeyUTC(new Date(`${date}T00:00:00Z`));
  const continues = streak.lastKeptDate === yday;
  const next = continues ? (streak.current + 1) : 1;
  const didReset = !continues && streak.current > 0;
  const updated = { current: next, lastKeptDate: date, updatedAt: Date.now() };
  progress.keptAt = Date.now();
  await redis.set(streakKey, JSON.stringify(updated));
  return { streak: updated, didUpdate: true, didReset };
}

// Helper functions
async function getLeaderboard() {
  if (!redis) {
    return [];
  }
  try {
    const data = await redis.get(LEGACY_LEADERBOARD_KEY);
    return data ? JSON.parse(data) : [];
  } catch (error) {
    console.error('Error reading leaderboard:', error);
    return [];
  }
}

async function setLeaderboard(leaderboard) {
  if (!redis) {
    throw new Error('Redis not connected');
  }
  await redis.set(LEGACY_LEADERBOARD_KEY, JSON.stringify(leaderboard));
}

function parseEntries(data) {
  if (!data) return [];
  try {
    const parsed = typeof data === 'string' ? JSON.parse(data) : data;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseWeeklyStore(data) {
  if (!data) return null;
  try {
    const parsed = typeof data === 'string' ? JSON.parse(data) : data;
    if (!parsed || typeof parsed !== 'object') return null;
    if (parsed.version !== 1) return null;
    if (!parsed.weeks || typeof parsed.weeks !== 'object') return null;
    return parsed;
  } catch {
    return null;
  }
}

async function ensureWeeklyStoreBootstrapped(nowMs = Date.now()) {
  if (!redis) return { version: 1, weeks: {} };
  const existing = parseWeeklyStore(await redis.get(WEEKLY_LEADERBOARDS_KEY));
  const store = existing || { version: 1, weeks: {} };

  const legacyWeekId = '2025-12-29';
  if (!store.weeks[legacyWeekId]) {
    const legacyRaw = await redis.get(LEGACY_LEADERBOARD_KEY);
    const legacyEntries = parseEntries(legacyRaw);
    if (legacyEntries.length > 0) {
      store.weeks[legacyWeekId] = {
        weekId: legacyWeekId,
        startDate: legacyWeekId,
        endDate: getWeekEndDate(legacyWeekId),
        entries: legacyEntries,
        createdAt: nowMs,
        updatedAt: nowMs,
        source: 'legacy-bootstrap',
      };
    }
  }

  if (!existing || (existing && !existing.weeks[legacyWeekId] && !!store.weeks[legacyWeekId])) {
    await redis.set(WEEKLY_LEADERBOARDS_KEY, JSON.stringify(store));
  }
  return store;
}

function upsertWeek(store, weekId, entries, nowMs = Date.now()) {
  const prev = store.weeks[weekId];
  const next = {
    weekId,
    startDate: weekId,
    endDate: getWeekEndDate(weekId),
    entries,
    createdAt: prev?.createdAt ?? nowMs,
    updatedAt: nowMs,
    source: prev?.source ?? 'weekly',
  };
  return { ...store, weeks: { ...store.weeks, [weekId]: next } };
}

// API Routes

// --- Auth routes (dev backend) ---
function roadcrosserPublicOrigin() {
  const value = process.env.SD_ROADCROSSER_PUBLIC_ORIGIN || 'https://www.roadcrosser.com';
  if (value === 'https://www.roadcrosser.com' || (process.env.NODE_ENV !== 'production' && /^http:\/\/(?:localhost|127\.0\.0\.1):[0-9]+$/.test(value))) return value;
  throw new Error('Roadcrosser public origin is invalid');
}

function isAllowedSubmarineMutationOrigin(req) {
  const expected = process.env.SD_SUBMARINE_PUBLIC_ORIGIN || 'https://submarine-dash.roadcrosser.com';
  if (expected !== 'https://submarine-dash.roadcrosser.com'
    && !(process.env.NODE_ENV !== 'production' && /^http:\/\/(?:localhost|127\.0\.0\.1):[0-9]+$/.test(expected))) return false;
  const origin = Array.isArray(req.headers.origin) ? req.headers.origin[0] : req.headers.origin;
  if (origin) {
    if (origin === expected) return true;
    return process.env.NODE_ENV !== 'production'
      && /^http:\/\/(?:localhost|127\.0\.0\.1):[0-9]+$/.test(origin)
      && origin === `${req.protocol}://${req.get('host')}`;
  }
  const site = Array.isArray(req.headers['sec-fetch-site']) ? req.headers['sec-fetch-site'][0] : req.headers['sec-fetch-site'];
  return site === 'same-origin';
}

app.get('/api/auth/roadcrosser/start', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  if (process.env.SD_CANONICAL_AUTH_TICKETS_ENABLED !== 'true') return res.status(404).json({ error: 'Canonical account connection is disabled' });
  const state = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(state, 'utf8').digest('base64url');
  setRoadcrosserStateCookie(req, res, state);
  return res.redirect(303, `${roadcrosserPublicOrigin()}/games/submarine-dash/connect?stateChallenge=${encodeURIComponent(challenge)}`);
});

app.post('/api/auth/roadcrosser/callback', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  if (process.env.SD_CANONICAL_AUTH_TICKETS_ENABLED !== 'true') return res.status(404).json({ error: 'Canonical account connection is disabled' });
  if (req.headers.origin !== roadcrosserPublicOrigin()) return res.status(403).json({ error: 'Forbidden' });
  const ticket = typeof req.body?.ticket === 'string' ? req.body.ticket : '';
  const state = parseCookies(req)[ROAD_CROSSER_STATE_COOKIE_NAME] || '';
  const opaque = /^[A-Za-z0-9_-]{43}$/;
  if (!opaque.test(ticket) || !opaque.test(state)) return res.status(400).json({ error: 'Invalid account handoff' });
  const stateChallenge = crypto.createHash('sha256').update(state, 'utf8').digest('base64url');
  const cookies = parseCookies(req);
  try {
    const canonical = await roadcrosserRequest('/api/internal/submarine-dash/tickets/consume', { ticket, stateChallenge });
    if (!opaque.test(canonical.sessionToken || '')) throw new Error('invalid session');
    try {
      if (cookies[SESSION_COOKIE_NAME]) {
        if (!redis) throw new Error('legacy session store unavailable');
        const legacyKey = keySession(cookies[SESSION_COOKIE_NAME]);
        await redis.del(legacyKey);
      }
      if (cookies[CANONICAL_SESSION_COOKIE_NAME] && cookies[CANONICAL_SESSION_COOKIE_NAME] !== canonical.sessionToken) {
        await roadcrosserRequest('/api/internal/submarine-dash/sessions/revoke', { sessionToken: cookies[CANONICAL_SESSION_COOKIE_NAME] });
      }
    } catch {
      await roadcrosserRequest('/api/internal/submarine-dash/sessions/revoke', { sessionToken: canonical.sessionToken }).catch(() => undefined);
      return res.status(503).json({ error: 'Existing session could not be replaced' });
    }
    setCanonicalSessionCookie(req, res, canonical.sessionToken);
    if (cookies[SESSION_COOKIE_NAME]) clearSessionCookie(req, res);
    clearRoadcrosserStateCookie(req, res);
    return res.redirect(303, '/');
  } catch {
    return res.status(401).json({ error: 'Account handoff is invalid or expired' });
  }
});

app.post('/api/auth/register', async (req, res) => {
  try {
    if (process.env.SD_CANONICAL_AUTH_TICKETS_ENABLED === 'true') {
      return res.status(409).json({ error: 'New accounts use Roadcrosser Account', roadcrosserConnect: '/api/auth/roadcrosser/start' });
    }
    if (!redis) return res.status(503).json({ error: 'Redis not connected' });

    const ip = (req.headers['x-forwarded-for'] || '').toString().split(',')[0]?.trim() || req.ip || 'unknown';
    if (await isRateLimited(`register:${ip}`, 10, 60)) return res.status(429).json({ error: 'Too many requests' });

    const loginId = (req.body?.loginId || '').toString().trim();
    const password = (req.body?.password || '').toString();
    if (!loginId || loginId.length < 3 || loginId.length > 32) return res.status(400).json({ error: 'Invalid loginId' });
    if (!password || password.length < 8 || password.length > 72) return res.status(400).json({ error: 'Invalid password' });

    const loginIdLower = loginId.toLowerCase();
    const exists = await redis.get(keyLoginId(loginIdLower));
    if (exists) return res.status(409).json({ error: 'loginId already exists' });

    const { saltB64, hashB64 } = await hashPassword(password);
    const user = {
      userId: generateId('user'),
      loginId,
      loginIdLower,
      passwordHash: hashB64,
      passwordSalt: saltB64,
      createdAt: Date.now(),
      refCode: generateRefCode(),
    };

    await redis.set(keyUser(user.userId), JSON.stringify(user));
    await redis.set(keyLoginId(user.loginIdLower), user.userId);

    const token = generateId('sess');
    await redis.set(keySession(token), user.userId, 'EX', SESSION_TTL_SECONDS);
    setSessionCookie(req, res, token);

    return res.json({ userId: user.userId, loginId: user.loginId, refCode: user.refCode });
  } catch (e) {
    console.error('POST /api/auth/register error:', e);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    if (!redis) return res.status(503).json({ error: 'Redis not connected' });

    const ip = (req.headers['x-forwarded-for'] || '').toString().split(',')[0]?.trim() || req.ip || 'unknown';
    if (await isRateLimited(`login:${ip}`, 20, 60)) return res.status(429).json({ error: 'Too many requests' });

    const loginId = (req.body?.loginId || '').toString().trim();
    const password = (req.body?.password || '').toString();
    if (!loginId || !password) return res.status(400).json({ error: 'Invalid credentials' });

    const loginIdLower = loginId.toLowerCase();
    const userId = await redis.get(keyLoginId(loginIdLower));
    if (!userId) return res.status(401).json({ error: 'Invalid credentials' });

    const user = await getUser(userId);
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });

    const ok = await verifyPassword(password, user.passwordSalt, user.passwordHash);
    if (!ok) return res.status(401).json({ error: 'Invalid credentials' });

    const cookies = parseCookies(req);
    if (cookies[CANONICAL_SESSION_COOKIE_NAME]) {
      try {
        await roadcrosserRequest('/api/internal/submarine-dash/sessions/revoke', { sessionToken: cookies[CANONICAL_SESSION_COOKIE_NAME] });
      } catch {
        return res.status(503).json({ error: 'Canonical session could not be revoked' });
      }
      clearCanonicalSessionCookie(req, res);
    }
    if (cookies[SESSION_COOKIE_NAME]) await redis.del(keySession(cookies[SESSION_COOKIE_NAME]));

    const token = generateId('sess');
    await redis.set(keySession(token), user.userId, 'EX', SESSION_TTL_SECONDS);
    setSessionCookie(req, res, token);

    return res.json({ userId: user.userId, loginId: user.loginId, refCode: user.refCode, canonical: false, readOnly: false });
  } catch (e) {
    console.error('POST /api/auth/login error:', e);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/auth/change-password', async (req, res) => {
  try {
    if (parseCookies(req)[CANONICAL_SESSION_COOKIE_NAME]) return res.status(409).json({ error: 'Canonical session cannot change a legacy password' });
    if (!redis) return res.status(503).json({ error: 'Redis not connected' });

    const ip = (req.headers['x-forwarded-for'] || '').toString().split(',')[0]?.trim() || req.ip || 'unknown';
    if (await isRateLimited(`changePassword:${ip}`, 10, 60)) return res.status(429).json({ error: 'Too many requests' });

    const loginId = (req.body?.loginId || '').toString().trim();
    const currentPassword = (req.body?.currentPassword || '').toString();
    const newPassword = (req.body?.newPassword || '').toString();

    if (!loginId || !currentPassword || !newPassword) return res.status(400).json({ error: 'Invalid request' });
    if (newPassword.length < 8 || newPassword.length > 72) return res.status(400).json({ error: 'Invalid new password' });

    const loginIdLower = loginId.toLowerCase();
    if (await isRateLimited(`changePassword:${ip}:${loginIdLower}`, 5, 60)) return res.status(429).json({ error: 'Too many requests' });

    const userId = await redis.get(keyLoginId(loginIdLower));
    if (!userId) return res.status(401).json({ error: 'Invalid credentials' });

    const user = await getUser(userId);
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });

    const ok = await verifyPassword(currentPassword, user.passwordSalt, user.passwordHash);
    if (!ok) return res.status(401).json({ error: 'Invalid credentials' });

    const { saltB64, hashB64 } = await hashPassword(newPassword);
    user.passwordSalt = saltB64;
    user.passwordHash = hashB64;
    await redis.set(keyUser(user.userId), JSON.stringify(user));

    const token = generateId('sess');
    await redis.set(keySession(token), user.userId, 'EX', SESSION_TTL_SECONDS);
    setSessionCookie(req, res, token);

    return res.json({ userId: user.userId, loginId: user.loginId, refCode: user.refCode });
  } catch (e) {
    console.error('POST /api/auth/change-password error:', e);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/auth/logout', async (req, res) => {
  try {
    const expectedOrigin = process.env.SD_SUBMARINE_PUBLIC_ORIGIN || 'https://submarine-dash.roadcrosser.com';
    if ((req.headers.origin && req.headers.origin !== expectedOrigin) || (!req.headers.origin && req.headers['sec-fetch-site'] !== 'same-origin')) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const cookies = parseCookies(req);
    const canonicalToken = cookies[CANONICAL_SESSION_COOKIE_NAME];
    if (canonicalToken) await roadcrosserRequest('/api/internal/submarine-dash/sessions/revoke', { sessionToken: canonicalToken });
    if (!redis) {
      clearSessionCookie(req, res);
      clearCanonicalSessionCookie(req, res);
      return res.json({ ok: true });
    }
    const token = cookies[SESSION_COOKIE_NAME];
    if (token) await redis.del(keySession(token));
    clearSessionCookie(req, res);
    clearCanonicalSessionCookie(req, res);
    return res.json({ ok: true });
  } catch (e) {
    console.error('POST /api/auth/logout error:', e);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/auth/me', async (req, res) => {
  try {
    const canonicalToken = parseCookies(req)[CANONICAL_SESSION_COOKIE_NAME];
    if (canonicalToken) {
      try {
        const canonical = await roadcrosserRequest('/api/internal/submarine-dash/bootstrap', { sessionToken: canonicalToken });
        return res.json({
          user: { userId: canonical.user.externalUserId, loginId: canonical.user.loginId, refCode: '' },
          inventory: canonical.inventory, achievements: canonical.achievements, streak: canonical.streak,
          unreadInboxCount: canonical.unreadInboxCount, readOnly: canonical.readOnly === true,
          readCapabilities: Array.isArray(canonical.readCapabilities) ? canonical.readCapabilities : [],
          writeCapabilities: Array.isArray(canonical.writeCapabilities) ? canonical.writeCapabilities : [], canonical: true,
        });
      } catch {
        clearCanonicalSessionCookie(req, res);
        clearSessionCookie(req, res);
        return res.json({ user: null });
      }
    }
    if (!redis) return res.json({ user: null });
    const userId = await getUserIdForSession(req);
    if (!userId) return res.json({ user: null });
    const user = await getUser(userId);
    if (!user) return res.json({ user: null });
    // Weekly winner dolphin reward (best-effort)
    let rewards = undefined;
    try {
      const store = await ensureWeeklyStoreBootstrapped();
      const currentWeekId = getPstCurrentWeekId();
      const prevWeekId = getPrevWeekId(currentWeekId);
      const winner = store.weeks?.[prevWeekId]?.entries?.[0];
      const winnerLoginId = typeof winner?.userId === 'string' ? winner.userId : null;
      if (winnerLoginId && winnerLoginId.toLowerCase() === user.loginIdLower) {
        const claimKey = `${WEEKLY_DOLPHIN_CLAIM_KEY_PREFIX}:${user.userId}`;
        const lastClaimed = await redis.get(claimKey);
        if (lastClaimed !== prevWeekId) {
          await addSavedDolphins(user.userId, 1, { type: 'weeklyWinner', meta: { weekId: prevWeekId } });
          await redis.set(claimKey, prevWeekId);
          rewards = { weeklyWinner: { dolphin: true, weekId: prevWeekId } };
        }
      }
    } catch (e) {
      console.warn('Weekly winner reward check failed:', e?.message || e);
    }

    // Legacy manual grants (best-effort): sd:reward:dolphin:grant:<userId> -> saved
    try {
      const grantKey = `${DOLPHIN_GRANT_KEY_PREFIX}:${user.userId}`;
      const raw = await redis.get(grantKey);
      const n = raw ? Number.parseInt(String(raw), 10) : 0;
      if (Number.isFinite(n) && n > 0) {
        await addSavedDolphins(user.userId, n, { type: 'manualGrant', meta: { source: 'legacyGrantKey' } });
        await redis.set(grantKey, '0');
        rewards = { ...(rewards || {}), grants: { dolphin: n } };
      }
    } catch (e) {
      console.warn('Dolphin grant check failed:', e?.message || e);
    }

    // Inventory snapshot (saved only; migrate legacy pending).
    let inventory = undefined;
    try {
      await migratePendingDolphins(user.userId);
      const savedRaw = await redis.get(keyDolphinSaved(user.userId));
      const saved = Math.max(0, parseIntSafe(savedRaw, 0));
      const coins = await getCoinBalance(user.userId);
      const tube = await getTubeState(user.userId);
      const skins = await getSkinState(user.userId);
      inventory = { dolphinSaved: saved, coins, tube, skins };
    } catch {
      // best-effort
    }

    return res.json({ user: { userId: user.userId, loginId: user.loginId, refCode: user.refCode }, inventory, rewards });
  } catch (e) {
    console.error('GET /api/auth/me error:', e);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/missions/daily', async (req, res) => {
  try {
    const canonicalToken = parseCookies(req)[CANONICAL_SESSION_COOKIE_NAME];
    if (canonicalToken) {
      const expectedOrigin = process.env.SD_SUBMARINE_PUBLIC_ORIGIN || 'https://submarine-dash.roadcrosser.com';
      if (!isCanonicalDailyReadAdmission({method:req.method,origin:req.headers.origin,expectedOrigin,canonicalToken,
        enabled:process.env.SD_SUPABASE_DAILY_READ_ENABLED === 'true',allowedOrigin:isAllowedSubmarineMutationOrigin(req)})) {
        return res.status(409).json({ error: 'Canonical daily missions are not enabled' });
      }
      const canonical = await executeExpressCanonicalDaily({canonicalToken,roadcrosserRequest});
      return res.json({date:canonical.date,missions:canonical.missions,user:canonical.user});
    }
    if (!redis) return res.status(503).json({ error: 'Redis not connected' });
    const date = todayKeyForReq(req);

    const missionsRaw = await redis.get(keyDailyMissions(date));
    const missions = missionsRaw ? JSON.parse(missionsRaw) : defaultMissions();

    const userId = await getUserIdForSession(req);
    if (!userId) {
      return res.json({ date, missions, user: null });
    }

    const progressRaw = await redis.get(keyUserDaily(userId, date));
    const progress = progressRaw
      ? JSON.parse(progressRaw)
      : { runs: 0, oxygenCollected: 0, maxScore: 0, completedMissionIds: [] };
    progress.completedMissionIds = computeCompleted(missions, progress);

    const streakRaw = await redis.get(keyUserStreak(userId));
    const streak = streakRaw ? JSON.parse(streakRaw) : { current: 0, lastKeptDate: null, updatedAt: Date.now() };

    let inventory = undefined;
    try {
      await migratePendingDolphins(userId);
      const savedRaw = await redis.get(keyDolphinSaved(userId));
      const saved = Math.max(0, parseIntSafe(savedRaw, 0));
      const coins = await getCoinBalance(userId);
      const tube = await getTubeState(userId);
      const skins = await getSkinState(userId);
      inventory = { dolphinSaved: saved, coins, tube, skins };
    } catch {
      // best-effort
    }

    return res.json({ date, missions, user: { progress, streak, inventory } });
  } catch (e) {
    console.error('GET /api/missions/daily error:', e);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/missions/event', async (req, res) => {
  try {
    const canonicalToken = parseCookies(req)[CANONICAL_SESSION_COOKIE_NAME];
    if (canonicalToken) {
      const result = await executeExpressCanonicalGameplay({
        canonicalToken, expectedExternalUserId:req.get('expected-external-user-id') || '',
        idempotencyKey:req.get('idempotency-key') || '',
        runEvidenceId:req.body?.type === 'run_end' ? req.get('run-evidence-id') || '' : null,
        event:req.body || {}, roadcrosserRequest,
      });
      return res.json(result);
    }
    if (!redis) return res.status(503).json({ error: 'Redis not connected' });

    const userId = await getUserIdForSession(req);
    if (!userId) return res.status(401).json({ error: 'Login required' });

    const body = req.body || {};
    if (!body.type) return res.status(400).json({ error: 'Invalid event' });

    const date = todayKeyForReq(req);
    const missionsRaw = await redis.get(keyDailyMissions(date));
    const missions = missionsRaw ? JSON.parse(missionsRaw) : defaultMissions();

    const progressKey = keyUserDaily(userId, date);
    const progressRaw = await redis.get(progressKey);
    const progress = progressRaw
      ? JSON.parse(progressRaw)
      : { runs: 0, oxygenCollected: 0, maxScore: 0, completedMissionIds: [] };

    const completedBefore = computeCompleted(missions, progress);

    let coinsEarned = 0;

    if (body.type === 'run_end') {
      const score = typeof body.score === 'number' ? body.score : 0;
      progress.runs += 1;
      progress.maxScore = Math.max(progress.maxScore, score);

      // Award coins based on score bracket
      coinsEarned = computeCoinsForScore(score);
      if (coinsEarned > 0) {
        try {
          await addCoins(userId, coinsEarned, { type: 'run_end', meta: { score } });
        } catch {
          // best-effort
        }
      }

      // Persist tube state (pieces + rescue charges) server-side
      if (typeof body.tubePieces === 'number' || typeof body.tubeCharges === 'number') {
        try {
          await saveTubeState(
            userId,
            typeof body.tubePieces === 'number' ? body.tubePieces : 0,
            typeof body.tubeCharges === 'number' ? body.tubeCharges : 0
          );
        } catch {
          // best-effort
        }
      }
    } else if (body.type === 'oxygen_collected') {
      const count = typeof body.count === 'number' && body.count > 0 ? Math.floor(body.count) : 1;
      progress.oxygenCollected += count;
    } else {
      return res.status(400).json({ error: 'Invalid event' });
    }

    const completedAfter = computeCompleted(missions, progress);
    progress.completedMissionIds = completedAfter;

    // Kept/Streak rule (per ticket): only when ALL daily missions are completed.
    const shouldKeepToday = areAllMissionsCompleted(missions, completedAfter);
    let streakReward = null;
    if (shouldKeepToday) {
      const kept = await keepTodayAndUpdateStreak(userId, date, progress);
      if (kept?.didUpdate && kept?.didReset) {
        try {
          await redis.set(keyDolphinStreakLastAwarded(userId), '0');
        } catch {
          // best-effort
        }
      }

      const streak = kept?.streak;
      if (streak && typeof streak.current === 'number' && streak.current >= 5) {
        try {
          const lastAwardedRaw = await redis.get(keyDolphinStreakLastAwarded(userId));
          const lastAwarded = lastAwardedRaw ? Number.parseInt(String(lastAwardedRaw), 10) : 0;
          if (!Number.isFinite(lastAwarded) || streak.current > lastAwarded) {
            await addSavedDolphins(userId, 1, { type: 'streak', meta: { streakDays: streak.current } });
            await redis.set(keyDolphinStreakLastAwarded(userId), String(streak.current));
            streakReward = { dolphin: 1, streakDays: streak.current };
          }
        } catch {
          // best-effort
        }
      }
    }

    await redis.set(progressKey, JSON.stringify(progress));

    // Achievement evaluation (run_end only)
    let newAchievements = [];
    if (body.type === 'run_end') {
      try {
        const achState = await getAchievementState(userId);
        const skinState = await getSkinState(userId);

        // Get weekly top score
        let weeklyTopScore = 0;
        try {
          const storeRaw = parseWeeklyStore(await redis.get(WEEKLY_LEADERBOARDS_KEY)) || { version: 1, weeks: {} };
          const weekId = getPstCurrentWeekId();
          const week = storeRaw.weeks[weekId];
          if (week && week.entries.length > 0) weeklyTopScore = week.entries[0].score;
        } catch { /* best-effort */ }

        const score = typeof body.score === 'number' ? body.score : 0;
        const result = evaluateRunEndAchievements(
          achState,
          {
            score,
            deathCause: typeof body.deathCause === 'string' ? body.deathCause : null,
            perfectPlatformer: body.perfectPlatformer === true,
            allOxygenCollected: body.allOxygenCollected === true,
          },
          skinState.equipped,
          progress.runs,
          date,
          weeklyTopScore,
        );
        newAchievements = result.newlyUnlocked;
        if (newAchievements.length > 0) {
          await saveAchievementState(userId, result.state);
          const achCoins = getAchievementRewardCoins(newAchievements);
          if (achCoins > 0) {
            try { await addCoins(userId, achCoins, { type: 'achievement', meta: { achievements: newAchievements } }); coinsEarned += achCoins; }
            catch { /* best-effort */ }
          }
        } else {
          await saveAchievementState(userId, result.state);
        }
      } catch { /* best-effort */ }
    }

    let inventory = undefined;
    try {
      await migratePendingDolphins(userId);
      const savedRaw = await redis.get(keyDolphinSaved(userId));
      const saved = Math.max(0, parseIntSafe(savedRaw, 0));
      const coins = await getCoinBalance(userId);
      const tube = await getTubeState(userId);
      const skins = await getSkinState(userId);
      inventory = { dolphinSaved: saved, coins, tube, skins };
    } catch {
      // best-effort
    }
    return res.json({ date, progress, rewards: streakReward ? { streak: streakReward } : undefined, coinsEarned: coinsEarned > 0 ? coinsEarned : undefined, inventory, newAchievements: newAchievements.length > 0 ? newAchievements : undefined });
  } catch (e) {
    console.error('POST /api/missions/event error:', e);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// Dolphin endpoints dispatch canonical sessions to Supabase and legacy sessions to Redis.
app.post('/api/inventory/dolphin/consume', async (req, res) => {
  try {
    const canonicalToken=parseCookies(req)[CANONICAL_SESSION_COOKIE_NAME];
    if (canonicalToken) {
      const out=await executeExpressCanonicalDolphin({operation:'consume_dolphin',canonicalToken,
        idempotencyKey:req.get('idempotency-key')||'',roadcrosserRequest});
      return res.status(out.status).json(out.body);
    }
    if (!redis) return res.status(503).json({ error: 'Redis not connected' });
    const userId = await getUserIdForSession(req);
    if (!userId) return res.status(401).json({ error: 'Login required' });
    const out = await consumeOneSavedDolphin(userId);
    return res.json({ ok: out.ok, inventory: { dolphinSaved: out.saved } });
  } catch (e) {
    console.error('POST /api/inventory/dolphin/consume error:', e);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/inventory/dolphin/import', async (req, res) => {
  try {
    const canonicalToken=parseCookies(req)[CANONICAL_SESSION_COOKIE_NAME];
    if (canonicalToken) {
      const key=req.get('idempotency-key')||''; const count=req.body?.count;
      const out=await executeExpressCanonicalDolphin({operation:'import_dolphin',canonicalToken,idempotencyKey:key,count,roadcrosserRequest});
      return res.status(out.status).json(out.body);
    }
    if (!redis) return res.status(503).json({ error: 'Redis not connected' });
    const userId = await getUserIdForSession(req);
    if (!userId) return res.status(401).json({ error: 'Login required' });
    const countRaw = req.body?.count;
    const n = typeof countRaw === 'number' ? countRaw : Number.parseInt(String(countRaw || '0'), 10);
    const count = Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
    if (count > 0) {
      await addSavedDolphins(userId, count, { type: 'importLocal', meta: { source: 'localStorage' } });
    }
    await migratePendingDolphins(userId);
    const savedRaw = await redis.get(keyDolphinSaved(userId));
    const saved = Math.max(0, parseIntSafe(savedRaw, 0));
    return res.json({ ok: true, inventory: { dolphinSaved: saved } });
  } catch (e) {
    console.error('POST /api/inventory/dolphin/import error:', e);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/inventory/skin/purchase
app.post('/api/inventory/skin/purchase', async (req, res) => {
  try {
    const canonicalToken = parseCookies(req)[CANONICAL_SESSION_COOKIE_NAME];
    if (canonicalToken) {
      const idempotencyKey = req.get('idempotency-key') || '';
      const skinId = typeof req.body?.skinId === 'string' ? req.body.skinId : '';
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(idempotencyKey)) {
        return res.status(400).json({ error: 'Valid Idempotency-Key required' });
      }
      if (!Object.hasOwn(SKIN_COSTS, skinId)) return res.status(400).json({ error: 'Invalid skin ID' });
      const result = await roadcrosserRequest('/api/internal/submarine-dash/mutations/purchase-skin', {
        sessionToken: canonicalToken, idempotencyKey, skinId, catalogVersion: SKIN_CATALOG_VERSION,
      });
      validateCanaryPurchaseResponse(result, skinId);
      if (result.rejected === 'already_owned') return res.status(400).json({ error: 'Already owned' });
      if (result.rejected === 'insufficient_coins') {
        return res.status(400).json({ error: 'Insufficient coins', required: result.required, balance: result.balance });
      }
      return res.json({
        ok: true, skinId: result.skinId, cost: result.cost, coins: result.coins,
        skins: result.skins, stateVersion: result.stateVersion, idempotent: result.idempotent,
      });
    }
    if (!redis) return res.status(503).json({ error: 'Redis not connected' });
    const userId = await getUserIdForSession(req);
    if (!userId) return res.status(401).json({ error: 'Login required' });
    const skinId = typeof req.body?.skinId === 'string' ? req.body.skinId.trim() : '';
    if (!skinId || !Object.hasOwn(SKIN_COSTS, skinId)) return res.status(400).json({ error: 'Invalid skin ID' });
    const cost = SKIN_COSTS[skinId];
    const state = await getSkinState(userId);
    if (state.owned.includes(skinId)) return res.status(400).json({ error: 'Already owned' });
    const balance = await getCoinBalance(userId);
    if (balance < cost) return res.status(400).json({ error: 'Insufficient coins', required: cost, balance });
    const newBalance = await redis.decrby(keyCoinBalance(userId), cost);
    if (newBalance < 0) {
      await redis.incrby(keyCoinBalance(userId), cost);
      return res.status(400).json({ error: 'Insufficient coins' });
    }
    await addOwnedSkin(userId, skinId);
    const updatedState = await getSkinState(userId);
    return res.json({ ok: true, skinId, cost, coins: newBalance, skins: updatedState });
  } catch (e) {
    console.error('POST /api/inventory/skin/purchase error:', e);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/inventory/skin/equip
app.post('/api/inventory/skin/equip', async (req, res) => {
  try {
    const canonicalToken = parseCookies(req)[CANONICAL_SESSION_COOKIE_NAME];
    if (canonicalToken) {
      const idempotencyKey = req.get('idempotency-key') || '';
      const skinId = typeof req.body?.skinId === 'string' ? req.body.skinId : '';
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(idempotencyKey)) {
        return res.status(400).json({ error: 'Valid Idempotency-Key required' });
      }
      if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(skinId)) return res.status(400).json({ error: 'Missing skinId' });
      const result = await roadcrosserRequest('/api/internal/submarine-dash/mutations/equip-skin', {
        sessionToken: canonicalToken, idempotencyKey, skinId,
      });
      validateCanaryEquipResponse(result, skinId);
      return res.json({ ok: true, skins: result.skins, stateVersion: result.stateVersion, idempotent: result.idempotent });
    }
    if (!redis) return res.status(503).json({ error: 'Redis not connected' });
    const userId = await getUserIdForSession(req);
    if (!userId) return res.status(401).json({ error: 'Login required' });
    const skinId = typeof req.body?.skinId === 'string' ? req.body.skinId.trim() : '';
    if (!skinId) return res.status(400).json({ error: 'Missing skinId' });
    const result = await equipSkin(userId, skinId);
    if (!result.ok) return res.status(400).json({ error: 'Skin not owned' });
    const state = await getSkinState(userId);
    return res.json({ ok: true, skins: state });
  } catch (e) {
    console.error('POST /api/inventory/skin/equip error:', e);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/achievements - Get achievement catalog + user unlock state
app.get('/api/achievements', async (req, res) => {
  try {
    let unlocked = {};
    if (redis) {
      const userId = await getUserIdForSession(req);
      if (userId) {
        const state = await getAchievementState(userId);
        unlocked = state.unlocked;
      }
    }
    const achievements = ACHIEVEMENT_CATALOG.map((a) => ({
      id: a.id,
      name: a.name,
      description: a.description,
      category: a.category,
      reward: a.reward,
      unlocked: !!unlocked[a.id],
      unlockedAt: unlocked[a.id] || null,
    }));
    return res.json({ achievements });
  } catch (e) {
    console.error('GET /api/achievements error:', e);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/achievements/users - Get achievement summaries for multiple users by loginId
app.get('/api/achievements/users', async (req, res) => {
  try {
    if (!redis) return res.json({ users: {} });

    const raw = req.query.loginIds;
    const loginIdsParam = typeof raw === 'string' ? raw : '';
    if (!loginIdsParam) return res.status(400).json({ error: 'loginIds query parameter required' });

    const loginIds = [...new Set(loginIdsParam.split(',').map(id => id.trim()).filter(Boolean))];
    if (loginIds.length === 0) return res.status(400).json({ error: 'No valid loginIds provided' });
    if (loginIds.length > 20) return res.status(400).json({ error: 'Too many loginIds (max 20)' });

    const ACHIEVEMENT_NAME_MAP = Object.fromEntries(
      ACHIEVEMENT_CATALOG.map((a) => [a.id, { name: a.name, category: a.category }])
    );

    const result = {};
    for (const loginId of loginIds) {
      const userId = await redis.get(keyLoginId(loginId.toLowerCase()));
      if (!userId) {
        result[loginId] = { count: 0, achievements: [] };
        continue;
      }
      const state = await getAchievementState(userId);
      const unlockedIds = Object.keys(state.unlocked);
      result[loginId] = {
        count: unlockedIds.length,
        achievements: unlockedIds
          .map(id => {
            const meta = ACHIEVEMENT_NAME_MAP[id];
            return meta ? { id, name: meta.name, category: meta.category } : null;
          })
          .filter(a => a !== null),
      };
    }

    return res.json({ users: result });
  } catch (e) {
    console.error('GET /api/achievements/users error:', e);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/game-events', async (req, res) => {
  const body = req.body || {};
  const valid = GAME_EVENT_UUID.test(String(body.eventId || ''))
    && GAME_EVENT_TYPES.has(String(body.event || ''))
    && (body.score === undefined || (Number.isInteger(body.score) && body.score >= 0 && body.score <= 1_000_000))
    && (body.displayName === undefined || (typeof body.displayName === 'string' && body.displayName.length <= 64))
    && (body.detail === undefined || (typeof body.detail === 'string' && body.detail.length <= 160));
  if (!valid) return res.status(400).json({ error: 'Invalid game event' });
  try {
    await sendGameEvent({
      eventId: String(body.eventId),
      event: String(body.event),
      ...(typeof body.score === 'number' ? { score: body.score } : {}),
      ...(typeof body.displayName === 'string' ? { displayName: body.displayName } : {}),
      ...(typeof body.detail === 'string' ? { detail: body.detail } : {}),
    });
  } catch (error) {
    console.warn('submarine_telegram_event_failed', error instanceof Error ? error.message : 'unknown');
  }
  return res.status(202).json({ accepted: true });
});

// GET /api/leaderboard - Get top 5 scores
app.get('/api/leaderboard', async (req, res) => {
  try {
    if (!redis) return res.json([]);
    const store = await ensureWeeklyStoreBootstrapped();
    const weekId = getPstCurrentWeekId();
    res.json(store.weeks?.[weekId]?.entries ?? []);
  } catch (error) {
    console.error('GET /api/leaderboard error:', error);
    res.status(500).json({ error: 'Failed to fetch leaderboard' });
  }
});

// GET /api/leaderboard/weekly - Get current + historical weekly leaderboards
app.get('/api/leaderboard/weekly', async (req, res) => {
  try {
    if (!redis) return res.json({ currentWeekId: getPstCurrentWeekId(), current: [], weeks: [] });
    const store = await ensureWeeklyStoreBootstrapped();
    const currentWeekId = getPstCurrentWeekId();
    const rawLimit = req.query?.limit;
    const limit = rawLimit ? Math.max(1, Math.min(260, parseInt(String(rawLimit), 10))) : 52;
    const weekIds = Object.keys(store.weeks || {}).sort().reverse().slice(0, limit);
    const weeks = weekIds.map((id) => store.weeks[id]);
    const current = store.weeks?.[currentWeekId]?.entries ?? [];
    res.json({ currentWeekId, current, weeks });
  } catch (e) {
    console.error('GET /api/leaderboard/weekly error:', e);
    res.status(500).json({ error: 'Failed to fetch weekly leaderboards' });
  }
});

// POST /api/leaderboard - Submit a new score
app.post('/api/leaderboard', async (req, res) => {
  try {
    if (!redis) {
      return res.status(503).json({ error: 'Redis not connected' });
    }

    const { name, score, skinId } = req.body;

    // Require login for submit in dev backend too (aligns with Vercel function)
    const sessionUserId = await getUserIdForSession(req);
    if (!sessionUserId) {
      return res.status(401).json({ error: 'Login required' });
    }
    const user = await getUser(sessionUserId);
    if (!user) {
      return res.status(401).json({ error: 'Login required' });
    }

    if (typeof score !== 'number') {
      return res.status(400).json({ error: 'Invalid name or score' });
    }

    await ensureWeeklyStoreBootstrapped();
    const storeRaw = parseWeeklyStore(await redis.get(WEEKLY_LEADERBOARDS_KEY)) || { version: 1, weeks: {} };
    const weekId = getPstCurrentWeekId();
    const leaderboard = [...(storeRaw.weeks?.[weekId]?.entries ?? [])];
    const requestedName = typeof name === 'string' ? name.trim() : '';
    const newEntry = {
      id: Date.now(),
      name: requestedName ? await sanitizeLeaderboardName(requestedName) : user.loginId,
      userId: user.loginId,
      skinId: typeof skinId === 'string' ? skinId : undefined,
      score
    };

    // Add new entry and sort by score (descending)
    leaderboard.push(newEntry);
    leaderboard.sort((a, b) => b.score - a.score);

    // Keep only top entries
    const topLeaderboard = leaderboard.slice(0, MAX_ENTRIES);
    const updatedStore = upsertWeek(storeRaw, weekId, topLeaderboard);
    await redis.set(WEEKLY_LEADERBOARDS_KEY, JSON.stringify(updatedStore));
    // Keep legacy key pointing at current leaderboard for compatibility.
    await setLeaderboard(topLeaderboard);

    const rank = topLeaderboard.findIndex(e => e.id === newEntry.id) + 1;

    res.json({
      entry: newEntry,
      leaderboard: topLeaderboard,
      rank
    });
  } catch (error) {
    console.error('POST /api/leaderboard error:', error);
    res.status(500).json({ error: 'Failed to submit score' });
  }
});

// DELETE /api/leaderboard - Clear leaderboard (for testing)
app.delete('/api/leaderboard', async (req, res) => {
  try {
    if (!redis) {
      return res.status(503).json({ error: 'Redis not connected' });
    }
    if (!CLEAR_ALLOWED) {
      return res.status(403).json({ error: 'Leaderboard clear disabled' });
    }
    const storeRaw = parseWeeklyStore(await redis.get(WEEKLY_LEADERBOARDS_KEY)) || { version: 1, weeks: {} };
    const weekId = getPstCurrentWeekId();
    const updatedStore = upsertWeek(storeRaw, weekId, []);
    await redis.set(WEEKLY_LEADERBOARDS_KEY, JSON.stringify(updatedStore));
    await setLeaderboard([]);
    res.json({ message: 'Leaderboard cleared (current week only)' });
  } catch (error) {
    console.error('DELETE /api/leaderboard error:', error);
    res.status(500).json({ error: 'Failed to clear leaderboard' });
  }
});

// ─── PVP: Settle Bet ──────────────────────────────────────────
app.post('/api/pvp/settle-bet', async (req, res) => {
  if (!redis) return res.status(500).json({ error: 'No Redis' });
  try {
    const userId = await getUserIdForSession(req);
    if (!userId) return res.status(401).json({ error: 'Login required' });

    const { winnerUserId, loserUserId, bet } = req.body || {};
    if (!winnerUserId || !loserUserId || !bet) {
      return res.status(400).json({ error: 'Missing winnerUserId, loserUserId, or bet' });
    }
    if (userId !== winnerUserId && userId !== loserUserId) {
      return res.status(403).json({ error: 'Not authorized' });
    }

    const transferred = { coins: 0, dolphins: 0, tubePieces: 0 };

    // Coins
    const requestedCoins = Math.max(0, Math.floor(bet.coins || 0));
    if (requestedCoins > 0) {
      const loserCoins = await getCoinBalance(loserUserId);
      const actual = Math.min(requestedCoins, loserCoins);
      if (actual > 0) {
        await redis.decrby(keyCoinBalance(loserUserId), actual);
        await redis.incrby(keyCoinBalance(winnerUserId), actual);
        transferred.coins = actual;
      }
    }

    // Dolphins
    const requestedDolphins = Math.max(0, Math.floor(bet.dolphins || 0));
    if (requestedDolphins > 0) {
      const loserDolphinsRaw = await redis.get(keyDolphinSaved(loserUserId));
      const loserDolphins = Math.max(0, parseInt(loserDolphinsRaw) || 0);
      const actual = Math.min(requestedDolphins, loserDolphins);
      if (actual > 0) {
        await redis.decrby(keyDolphinSaved(loserUserId), actual);
        await redis.incrby(keyDolphinSaved(winnerUserId), actual);
        transferred.dolphins = actual;
      }
    }

    // Tube pieces
    const requestedTubes = Math.max(0, Math.floor(bet.tubePieces || 0));
    if (requestedTubes > 0) {
      const keyTube = (uid) => `${KEY_PREFIX}user:${uid}:tube`;
      const loserTubeRaw = await redis.get(keyTube(loserUserId));
      const loserTube = loserTubeRaw ? JSON.parse(loserTubeRaw) : { pieces: 0, charges: 0 };
      const actual = Math.min(requestedTubes, loserTube.pieces || 0);
      if (actual > 0) {
        loserTube.pieces -= actual;
        await redis.set(keyTube(loserUserId), JSON.stringify(loserTube));
        const winnerTubeRaw = await redis.get(keyTube(winnerUserId));
        const winnerTube = winnerTubeRaw ? JSON.parse(winnerTubeRaw) : { pieces: 0, charges: 0 };
        winnerTube.pieces += actual;
        await redis.set(keyTube(winnerUserId), JSON.stringify(winnerTube));
        transferred.tubePieces = actual;
      }
    }

    return res.json({ ok: true, transferred });
  } catch (error) {
    console.error('POST /api/pvp/settle-bet error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// =============================================
// Online PvP REST endpoints
// =============================================

app.post('/api/pvp-online/ws-ticket', async (req, res) => {
  try {
    if (!redis) return res.status(503).json({ error: 'Redis not connected' });
    const userId = await getUserIdForSession(req);
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });
    const userRaw = await redis.get(`${KEY_PREFIX}user:${userId}`);
    if (!userRaw) return res.status(401).json({ error: 'User not found' });
    const user = JSON.parse(userRaw);

    const ticket = 'wst_' + crypto.randomBytes(16).toString('hex');
    const expiresAt = Date.now() + 60000;
    await redis.set(`sd:pvp:ws-ticket:${ticket}`, JSON.stringify({ userId: user.userId, loginId: user.loginId }), 'EX', 60);

    return res.json({ ticket, user: { userId: user.userId, loginId: user.loginId }, expiresAt });
  } catch (error) {
    console.error('POST /api/pvp-online/ws-ticket error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/pvp-online/bootstrap', async (req, res) => {
  try {
    if (!redis) return res.status(503).json({ error: 'Redis not connected' });
    const userId = await getUserIdForSession(req);
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });
    const userRaw = await redis.get(`${KEY_PREFIX}user:${userId}`);
    if (!userRaw) return res.status(401).json({ error: 'User not found' });
    const user = JSON.parse(userRaw);

    const [coinsRaw, dolphinsRaw, tubeRaw, skinsOwnedRaw, skinsEquipped, unreadRaw, activeRoomId] = await Promise.all([
      redis.get(`sd:user:${userId}:coins`),
      redis.get(`sd:user:${userId}:dolphin:saved`),
      redis.get(`sd:user:${userId}:tube`),
      redis.smembers(`sd:user:${userId}:skins:owned`),
      redis.get(`sd:user:${userId}:skins:equipped`),
      redis.get(`sd:inbox:unread:${userId}`),
      getActivePvpRoomMembership(userId),
    ]);

    const tube = tubeRaw ? JSON.parse(tubeRaw) : { pieces: 0, charges: 0 };
    const skins = { owned: skinsOwnedRaw && skinsOwnedRaw.length > 0 ? skinsOwnedRaw : ['default'], equipped: skinsEquipped || 'default' };

    let activeRoomSummary = null;
    if (activeRoomId) {
      const roomRaw = await redis.get(`sd:pvp:room:${activeRoomId}`);
      if (roomRaw) activeRoomSummary = JSON.parse(roomRaw);
    }

    return res.json({
      user: { userId: user.userId, loginId: user.loginId, refCode: user.refCode },
      inventory: {
        coins: parseInt(coinsRaw || '0', 10) || 0,
        dolphinSaved: parseInt(dolphinsRaw || '0', 10) || 0,
        tube,
        skins,
      },
      inboxUnreadCount: parseInt(unreadRaw || '0', 10) || 0,
      activeRoomSummary,
    });
  } catch (error) {
    console.error('GET /api/pvp-online/bootstrap error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/pvp-online/inbox', async (req, res) => {
  try {
    if (!redis) return res.status(503).json({ error: 'Redis not connected' });
    const userId = await getUserIdForSession(req);
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });

    const cursor = typeof req.query.cursor === 'string' ? parseInt(req.query.cursor, 10) : 0;
    const limit = Math.min(typeof req.query.limit === 'string' ? parseInt(req.query.limit, 10) : 20, 50);

    const rawItems = await redis.lrange(`sd:inbox:${userId}`, cursor, cursor + limit - 1);
    const items = rawItems.map(raw => { try { return JSON.parse(raw); } catch { return null; } }).filter(Boolean);
    const totalLen = await redis.llen(`sd:inbox:${userId}`);
    const nextCursor = cursor + limit < totalLen ? String(cursor + limit) : null;

    return res.json({ items, nextCursor });
  } catch (error) {
    console.error('GET /api/pvp-online/inbox error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/pvp-online/inbox/:inboxId/read', async (req, res) => {
  try {
    if (!redis) return res.status(503).json({ error: 'Redis not connected' });
    const userId = await getUserIdForSession(req);
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });

    const { inboxId } = req.params;
    const key = `sd:inbox:${userId}`;
    const readAt = Date.now();
    const len = await redis.llen(key);
    for (let i = 0; i < len; i++) {
      const raw = await redis.lindex(key, i);
      if (!raw) continue;
      try {
        const item = JSON.parse(raw);
        if (item.inboxId === inboxId && item.readAt === null) {
          item.readAt = readAt;
          await redis.lset(key, i, JSON.stringify(item));
          const current = parseInt(await redis.get(`sd:inbox:unread:${userId}`) || '0', 10);
          if (current > 0) await redis.decr(`sd:inbox:unread:${userId}`);
          return res.json({ ok: true, inboxId, readAt });
        }
      } catch { continue; }
    }
    return res.json({ ok: false, inboxId, readAt });
  } catch (error) {
    console.error('POST /api/pvp-online/inbox/:id/read error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/pvp-online/inbox/read-all', async (req, res) => {
  try {
    if (!redis) return res.status(503).json({ error: 'Redis not connected' });
    const userId = await getUserIdForSession(req);
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });

    const key = `sd:inbox:${userId}`;
    const readAt = Date.now();
    const len = await redis.llen(key);
    for (let i = 0; i < len; i++) {
      const raw = await redis.lindex(key, i);
      if (!raw) continue;
      try {
        const item = JSON.parse(raw);
        if (item.readAt === null) {
          item.readAt = readAt;
          await redis.lset(key, i, JSON.stringify(item));
        }
      } catch { continue; }
    }
    await redis.set(`sd:inbox:unread:${userId}`, '0');
    return res.json({ ok: true, readAt });
  } catch (error) {
    console.error('POST /api/pvp-online/inbox/read-all error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/pvp-online/lobby/enter', async (req, res) => {
  try {
    if (!redis) return res.status(503).json({ error: 'Redis not connected' });
    const userId = await getUserIdForSession(req);
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });
    const userRaw = await redis.get(`${KEY_PREFIX}user:${userId}`);
    if (!userRaw) return res.status(401).json({ error: 'User not found' });
    const user = JSON.parse(userRaw);

    const now = Date.now();
    const presence = JSON.stringify({
      userId: user.userId, loginId: user.loginId,
      status: 'IN_PVP_LOBBY', roomId: null, matchId: null,
      enteredLobbyAt: now, lastSeenAt: now,
    });
    await redis.set(`sd:pvp:presence:${user.userId}`, presence, 'EX', 30);
    await redis.sadd('sd:pvp:lobby:online', user.userId);
    return res.json({ ok: true });
  } catch (error) {
    console.error('POST /api/pvp-online/lobby/enter error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/pvp-online/lobby/leave', async (req, res) => {
  try {
    if (!redis) return res.status(503).json({ error: 'Redis not connected' });
    const userId = await getUserIdForSession(req);
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });

    await redis.del(`sd:pvp:presence:${userId}`);
    await redis.srem('sd:pvp:lobby:online', userId);
    return res.json({ ok: true });
  } catch (error) {
    console.error('POST /api/pvp-online/lobby/leave error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/pvp-online/lobby', async (req, res) => {
  try {
    if (!redis) return res.status(503).json({ error: 'Redis not connected' });
    const userId = await getUserIdForSession(req);
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });

    const userIds = await redis.smembers('sd:pvp:lobby:online');
    const users = [];
    for (const uid of (userIds || [])) {
      const activeRoomId = await getActivePvpRoomMembership(uid);
      if (activeRoomId) {
        await redis.srem('sd:pvp:lobby:online', uid);
        continue;
      }
      const raw = await redis.get(`sd:pvp:presence:${uid}`);
      if (raw) { try { users.push(JSON.parse(raw)); } catch {} }
    }
    return res.json({ users, asOf: Date.now() });
  } catch (error) {
    console.error('GET /api/pvp-online/lobby error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/pvp-online/lobby/rooms', async (req, res) => {
  try {
    if (!redis) return res.status(503).json({ error: 'Redis not connected' });
    const userId = await getUserIdForSession(req);
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });

    const rooms = await listJoinableRooms();
    return res.json({ rooms, asOf: Date.now() });
  } catch (error) {
    console.error('GET /api/pvp-online/lobby/rooms error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/pvp-online/rooms/:roomId', async (req, res) => {
  try {
    if (!redis) return res.status(503).json({ error: 'Redis not connected' });
    const userId = await getUserIdForSession(req);
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });

    const raw = await redis.get(`sd:pvp:room:${req.params.roomId}`);
    if (!raw) return res.status(404).json({ error: 'Room not found' });
    return res.json({ room: JSON.parse(raw) });
  } catch (error) {
    console.error('GET /api/pvp-online/rooms/:roomId error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/pvp-online/rooms/list', async (req, res) => {
  try {
    if (!redis) return res.status(503).json({ error: 'Redis not connected' });
    const userId = await getUserIdForSession(req);
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });

    const rooms = await listJoinableRooms();
    return res.json({ rooms, asOf: Date.now() });
  } catch (error) {
    console.error('GET /api/pvp-online/rooms/list error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/pvp-online/matches/:matchId', async (req, res) => {
  try {
    if (!redis) return res.status(503).json({ error: 'Redis not connected' });
    const userId = await getUserIdForSession(req);
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });

    const raw = await redis.get(`sd:pvp:match:${req.params.matchId}`);
    if (!raw) return res.status(404).json({ error: 'Match not found' });
    return res.json({ match: JSON.parse(raw) });
  } catch (error) {
    console.error('GET /api/pvp-online/matches/:matchId error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/pvp-online/matches/:matchId/input', async (req, res) => {
  try {
    if (!redis) return res.status(503).json({ error: 'Redis not connected' });
    const userId = await getUserIdForSession(req);
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });

    const raw = await redis.get(`sd:pvp:match:${req.params.matchId}`);
    if (!raw) return res.status(404).json({ error: 'MATCH_NOT_FOUND' });

    const match = JSON.parse(raw);
    const { seq, action } = req.body || {};
    if (typeof seq !== 'number') return res.status(400).json({ error: 'seq required' });
    if (action !== 'down' && action !== 'up') return res.status(400).json({ error: 'INVALID_ACTION' });

    const role = match.players?.host?.userId === userId
      ? 'host'
      : match.players?.guest?.userId === userId
        ? 'guest'
        : null;
    if (!role) return res.status(403).json({ error: 'NOT_MATCH_PARTICIPANT' });

    match.inputs = match.inputs || { host: [], guest: [] };
    const inputList = role === 'host' ? match.inputs.host : match.inputs.guest;
    const lastSeq = inputList.length > 0 ? inputList[inputList.length - 1].seq : -1;
    if (seq > lastSeq) {
      inputList.push({ seq, action, at: Date.now() });
      if (inputList.length > 120) {
        inputList.splice(0, inputList.length - 120);
      }
    }

    match.updatedAt = Date.now();
    await redis.set(`sd:pvp:match:${req.params.matchId}`, JSON.stringify(match));
    return res.json({ ok: true });
  } catch (error) {
    console.error('POST /api/pvp-online/matches/:matchId/input error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/pvp-online/matches/:matchId/state', async (req, res) => {
  try {
    if (!redis) return res.status(503).json({ error: 'Redis not connected' });
    const userId = await getUserIdForSession(req);
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });

    const raw = await redis.get(`sd:pvp:match:${req.params.matchId}`);
    if (!raw) return res.status(404).json({ error: 'MATCH_NOT_FOUND' });
    const match = JSON.parse(raw);
    if (match.players?.host?.userId !== userId) {
      return res.status(403).json({ error: 'ONLY_HOST_CAN_UPDATE_MATCH' });
    }

    const { phase, snapshot, series, winnerSlot = null } = req.body || {};
    if (phase) match.phase = phase;
    if (snapshot !== undefined) match.snapshot = snapshot;
    if (series) match.series = series;
    if (winnerSlot === 1 || winnerSlot === 2 || winnerSlot === null) {
      match.winnerSlot = winnerSlot;
    }
    match.updatedAt = Date.now();

    if (phase === 'MATCH_RESULT') {
      match.completedAt = Date.now();
      const roomRaw = await redis.get(`sd:pvp:room:${match.roomId}`);
      if (roomRaw) {
        const room = JSON.parse(roomRaw);
        room.phase = room.slots?.guest ? 'READY_CHECK' : 'OPEN';
        room.matchId = null;
        room.slots.host.ready = false;
        if (room.slots.guest) {
          room.slots.guest.ready = false;
        }
        room.updatedAt = Date.now();
        room.version += 1;
        await redis.set(`sd:pvp:room:${match.roomId}`, JSON.stringify(room));
      }
    }

    await redis.set(`sd:pvp:match:${req.params.matchId}`, JSON.stringify(match));
    return res.json({ match });
  } catch (error) {
    console.error('POST /api/pvp-online/matches/:matchId/state error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// Room endpoints
app.post('/api/pvp-online/rooms/create', async (req, res) => {
  try {
    if (!redis) return res.status(503).json({ error: 'Redis not connected' });
    const userId = await getUserIdForSession(req);
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });
    const userRaw = await redis.get(`${KEY_PREFIX}user:${userId}`);
    if (!userRaw) return res.status(401).json({ error: 'User not found' });
    const user = JSON.parse(userRaw);
    const { skinId = 'default', config } = req.body || {};

    const existing = await getActivePvpRoomMembership(userId);
    if (existing) return res.status(409).json({ error: 'ALREADY_IN_ROOM' });

    const roomId = 'room_' + crypto.randomBytes(8).toString('hex');
    const now = Date.now();
    const room = {
      roomId, ownerUserId: userId, phase: 'OPEN', version: 1,
      config: normalizeOnlineRoomConfig(config),
      slots: { host: { userId, loginId: user.loginId, connected: true, ready: false, skinId }, guest: null },
      pendingInviteId: null, matchId: null, escrow: { status: 'NONE' },
      createdAt: now, updatedAt: now,
    };
    await redis.set(`sd:pvp:room:${roomId}`, JSON.stringify(room));
    await redis.set(`sd:pvp:room-membership:${userId}`, roomId);
    await redis.sadd('sd:pvp:rooms:all', roomId);
    await redis.srem('sd:pvp:lobby:online', userId);
    await redis.del(`sd:pvp:presence:${userId}`);
    return res.json({ room });
  } catch (error) {
    console.error('POST /api/pvp-online/rooms/create error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/pvp-online/rooms/join', async (req, res) => {
  try {
    if (!redis) return res.status(503).json({ error: 'Redis not connected' });
    const userId = await getUserIdForSession(req);
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });
    const userRaw = await redis.get(`${KEY_PREFIX}user:${userId}`);
    if (!userRaw) return res.status(401).json({ error: 'User not found' });
    const user = JSON.parse(userRaw);
    const { roomId, skinId = 'default' } = req.body || {};
    if (!roomId) return res.status(400).json({ error: 'roomId required' });
    const existing = await getActivePvpRoomMembership(userId);
    if (existing) return res.status(409).json({ error: 'ALREADY_IN_ROOM' });
    const raw = await redis.get(`sd:pvp:room:${roomId}`);
    if (!raw) return res.status(404).json({ error: 'ROOM_NOT_FOUND' });
    const room = JSON.parse(raw);
    if (room.phase !== 'OPEN') return res.status(409).json({ error: 'INVALID_PHASE' });
    if (room.slots.guest !== null) return res.status(409).json({ error: 'ROOM_FULL' });
    if (room.ownerUserId === userId) return res.status(409).json({ error: 'ALREADY_HOST' });
    room.slots.guest = { userId, loginId: user.loginId, connected: true, ready: false, skinId };
    room.phase = 'READY_CHECK';
    room.pendingInviteId = null;
    room.updatedAt = Date.now();
    room.version += 1;
    await redis.set(`sd:pvp:room:${roomId}`, JSON.stringify(room));
    await redis.set(`sd:pvp:room-membership:${userId}`, roomId);
    await redis.srem('sd:pvp:lobby:online', userId);
    await redis.del(`sd:pvp:presence:${userId}`);
    return res.json({ room });
  } catch (error) {
    console.error('POST /api/pvp-online/rooms/join error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/pvp-online/rooms/config', async (req, res) => {
  try {
    if (!redis) return res.status(503).json({ error: 'Redis not connected' });
    const userId = await getUserIdForSession(req);
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });
    const { roomVersion, config } = req.body || {};
    if (typeof roomVersion !== 'number') return res.status(400).json({ error: 'roomVersion required' });
    const roomId = await getActivePvpRoomMembership(userId);
    if (!roomId) return res.status(404).json({ error: 'NOT_IN_ROOM' });
    const raw = await redis.get(`sd:pvp:room:${roomId}`);
    if (!raw) return res.status(404).json({ error: 'ROOM_NOT_FOUND' });
    const room = JSON.parse(raw);
    if (room.version !== roomVersion) return res.status(409).json({ error: 'ROOM_VERSION_CONFLICT' });
    if (room.ownerUserId !== userId) return res.status(403).json({ error: 'NOT_HOST' });
    if (!['OPEN', 'READY_CHECK', 'WAITING_FOR_INVITEE'].includes(room.phase)) {
      return res.status(400).json({ error: 'INVALID_PHASE' });
    }
    room.config = normalizeOnlineRoomConfig(config);
    room.slots.host.ready = false;
    if (room.slots.guest) room.slots.guest.ready = false;
    room.updatedAt = Date.now();
    room.version += 1;
    await redis.set(`sd:pvp:room:${roomId}`, JSON.stringify(room));
    return res.json({ room });
  } catch (error) {
    console.error('POST /api/pvp-online/rooms/config error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/pvp-online/rooms/skin', async (req, res) => {
  try {
    if (!redis) return res.status(503).json({ error: 'Redis not connected' });
    const userId = await getUserIdForSession(req);
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });
    const { roomVersion, skinId } = req.body || {};
    if (typeof roomVersion !== 'number') return res.status(400).json({ error: 'roomVersion required' });
    if (typeof skinId !== 'string' || !skinId.trim()) return res.status(400).json({ error: 'skinId required' });

    const roomId = await getActivePvpRoomMembership(userId);
    if (!roomId) return res.status(404).json({ error: 'NOT_IN_ROOM' });
    const skins = await getSkinState(userId);
    if (!skins.owned.includes(skinId)) return res.status(403).json({ error: 'SKIN_NOT_OWNED' });

    const raw = await redis.get(`sd:pvp:room:${roomId}`);
    if (!raw) return res.status(404).json({ error: 'ROOM_NOT_FOUND' });
    const room = JSON.parse(raw);
    if (room.version !== roomVersion) return res.status(409).json({ error: 'ROOM_VERSION_CONFLICT' });
    if (!['OPEN', 'READY_CHECK', 'WAITING_FOR_INVITEE'].includes(room.phase)) {
      return res.status(400).json({ error: 'INVALID_PHASE' });
    }
    if (room.slots.host.userId === userId) room.slots.host.skinId = skinId;
    else if (room.slots.guest?.userId === userId) room.slots.guest.skinId = skinId;
    else return res.status(400).json({ error: 'NOT_IN_ROOM' });

    room.updatedAt = Date.now();
    room.version += 1;
    await redis.set(`sd:pvp:room:${roomId}`, JSON.stringify(room));
    return res.json({ room });
  } catch (error) {
    console.error('POST /api/pvp-online/rooms/skin error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/pvp-online/rooms/leave', async (req, res) => {
  try {
    if (!redis) return res.status(503).json({ error: 'Redis not connected' });
    const userId = await getUserIdForSession(req);
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });
    const roomId = await getActivePvpRoomMembership(userId);
    if (!roomId) return res.status(404).json({ error: 'NOT_IN_ROOM' });
    const raw = await redis.get(`sd:pvp:room:${roomId}`);
    if (!raw) return res.status(404).json({ error: 'ROOM_NOT_FOUND' });
    const room = JSON.parse(raw);
    const now = Date.now();
    room.phase = 'CANCELED'; room.updatedAt = now; room.version += 1;
    await redis.set(`sd:pvp:room:${roomId}`, JSON.stringify(room));
    await redis.del(`sd:pvp:room-membership:${room.slots.host.userId}`);
    if (room.slots.guest) await redis.del(`sd:pvp:room-membership:${room.slots.guest.userId}`);
    await redis.srem('sd:pvp:rooms:all', roomId);
    return res.json({ ok: true, room });
  } catch (error) {
    console.error('POST /api/pvp-online/rooms/leave error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/pvp-online/rooms/ready', async (req, res) => {
  try {
    if (!redis) return res.status(503).json({ error: 'Redis not connected' });
    const userId = await getUserIdForSession(req);
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });
    const { ready = true, roomVersion } = req.body || {};
    if (typeof roomVersion !== 'number') return res.status(400).json({ error: 'roomVersion required' });
    const roomId = await getActivePvpRoomMembership(userId);
    if (!roomId) return res.status(404).json({ error: 'NOT_IN_ROOM' });
    const raw = await redis.get(`sd:pvp:room:${roomId}`);
    if (!raw) return res.status(404).json({ error: 'ROOM_NOT_FOUND' });
    const room = JSON.parse(raw);
    if (room.version !== roomVersion) return res.status(409).json({ error: 'ROOM_VERSION_CONFLICT' });
    if (room.phase !== 'READY_CHECK') return res.status(400).json({ error: 'INVALID_PHASE' });
    if (room.slots.host.userId === userId) room.slots.host.ready = ready;
    else if (room.slots.guest?.userId === userId) room.slots.guest.ready = ready;
    else return res.status(400).json({ error: 'NOT_IN_ROOM' });
    if (room.slots.host.ready && room.slots.guest?.ready) {
      room.phase = 'IN_MATCH';
      room.matchId = room.matchId || `match_${crypto.randomBytes(8).toString('hex')}`;
      await redis.set(`sd:pvp:match:${room.matchId}`, JSON.stringify({
        matchId: room.matchId,
        roomId,
        phase: 'COUNTDOWN',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        seed: Math.floor(Math.random() * 2147483647),
        countdownStartedAt: Date.now(),
        config: room.config,
        players: {
          host: room.slots.host,
          guest: room.slots.guest,
        },
        inputs: { host: [], guest: [] },
        snapshot: null,
        winnerSlot: null,
        completedAt: null,
        series: {
          roundsPlayed: 0,
          p1Wins: 0,
          p2Wins: 0,
          roundsNeeded: room.config.format === 'bo5' ? 3 : room.config.format === 'bo3' ? 2 : 1,
          currentRound: 1,
          roundResults: [],
        },
      }));
    }
    room.updatedAt = Date.now(); room.version += 1;
    await redis.set(`sd:pvp:room:${roomId}`, JSON.stringify(room));
    return res.json({ room });
  } catch (error) {
    console.error('POST /api/pvp-online/rooms/ready error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/pvp-online/rooms/cancel', async (req, res) => {
  try {
    if (!redis) return res.status(503).json({ error: 'Redis not connected' });
    const userId = await getUserIdForSession(req);
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });
    const { roomVersion } = req.body || {};
    if (typeof roomVersion !== 'number') return res.status(400).json({ error: 'roomVersion required' });
    const roomId = await getActivePvpRoomMembership(userId);
    if (!roomId) return res.status(404).json({ error: 'NOT_IN_ROOM' });
    const raw = await redis.get(`sd:pvp:room:${roomId}`);
    if (!raw) return res.status(404).json({ error: 'ROOM_NOT_FOUND' });
    const room = JSON.parse(raw);
    if (room.version !== roomVersion) return res.status(409).json({ error: 'ROOM_VERSION_CONFLICT' });
    if (room.ownerUserId !== userId) return res.status(403).json({ error: 'NOT_HOST' });
    room.phase = 'CANCELED'; room.updatedAt = Date.now(); room.version += 1;
    await redis.set(`sd:pvp:room:${roomId}`, JSON.stringify(room));
    await redis.del(`sd:pvp:room-membership:${userId}`);
    if (room.slots.guest) await redis.del(`sd:pvp:room-membership:${room.slots.guest.userId}`);
    await redis.srem('sd:pvp:rooms:all', roomId);
    return res.json({ ok: true, room });
  } catch (error) {
    console.error('POST /api/pvp-online/rooms/cancel error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// Invite endpoints
app.post('/api/pvp-online/invites/send', async (req, res) => {
  try {
    if (!redis) return res.status(503).json({ error: 'Redis not connected' });
    const userId = await getUserIdForSession(req);
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });
    const userRaw = await redis.get(`${KEY_PREFIX}user:${userId}`);
    if (!userRaw) return res.status(401).json({ error: 'User not found' });
    const user = JSON.parse(userRaw);
    const { targetUserId, targetLoginId, roomVersion } = req.body || {};
    if ((!targetUserId && !targetLoginId) || typeof roomVersion !== 'number')
      return res.status(400).json({ error: 'targetUserId or targetLoginId, and roomVersion required' });
    const roomId = await getActivePvpRoomMembership(userId);
    if (!roomId) return res.status(404).json({ error: 'NOT_IN_ROOM' });
    let toUserId = typeof targetUserId === 'string' && targetUserId.trim() ? targetUserId.trim() : null;
    if (!toUserId && typeof targetLoginId === 'string' && targetLoginId.trim()) {
      toUserId = await redis.get(`${KEY_PREFIX}loginId:${targetLoginId.trim().toLowerCase()}`);
    }
    if (!toUserId) return res.status(400).json({ error: 'INVITE_TARGET_NOT_FOUND' });
    const targetUserRaw = await redis.get(`${KEY_PREFIX}user:${toUserId}`);
    if (!targetUserRaw) return res.status(400).json({ error: 'INVITE_TARGET_NOT_FOUND' });
    const targetUser = JSON.parse(targetUserRaw);
    const raw = await redis.get(`sd:pvp:room:${roomId}`);
    if (!raw) return res.status(404).json({ error: 'ROOM_NOT_FOUND' });
    const room = JSON.parse(raw);
    if (room.version !== roomVersion) return res.status(409).json({ error: 'ROOM_VERSION_CONFLICT' });
    if (room.ownerUserId !== userId) return res.status(403).json({ error: 'NOT_HOST' });
    if (room.phase !== 'OPEN') return res.status(400).json({ error: 'INVALID_PHASE_TRANSITION' });
    if (room.slots.guest !== null) return res.status(400).json({ error: 'ROOM_FULL' });
    const now = Date.now();
    const inviteId = 'inv_' + crypto.randomBytes(8).toString('hex');
    const invite = {
      inviteId, roomId, fromUserId: userId, fromLoginId: user.loginId,
      toUserId, toLoginId: targetUser.loginId, status: 'PENDING',
      createdAt: now, expiresAt: now + 60000, resolvedAt: null,
    };
    room.pendingInviteId = inviteId; room.phase = 'WAITING_FOR_INVITEE';
    room.updatedAt = now; room.version += 1;
    await redis.set(`sd:pvp:invite:${inviteId}`, JSON.stringify(invite));
    await redis.sadd(`sd:pvp:user-invites:${toUserId}`, inviteId);
    await redis.set(`sd:pvp:room:${roomId}`, JSON.stringify(room));
    return res.json({ invite });
  } catch (error) {
    console.error('POST /api/pvp-online/invites/send error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/pvp-online/invites/accept', async (req, res) => {
  try {
    if (!redis) return res.status(503).json({ error: 'Redis not connected' });
    const userId = await getUserIdForSession(req);
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });
    const userRaw = await redis.get(`${KEY_PREFIX}user:${userId}`);
    if (!userRaw) return res.status(401).json({ error: 'User not found' });
    const user = JSON.parse(userRaw);
    const { inviteId, skinId = 'default' } = req.body || {};
    if (!inviteId) return res.status(400).json({ error: 'inviteId required' });
    const inviteRaw = await redis.get(`sd:pvp:invite:${inviteId}`);
    if (!inviteRaw) return res.status(404).json({ error: 'INVITE_NOT_FOUND' });
    const invite = JSON.parse(inviteRaw);
    if (invite.status !== 'PENDING') return res.status(400).json({ error: 'INVITE_NOT_PENDING' });
    if (invite.toUserId !== userId) return res.status(403).json({ error: 'NOT_INVITE_TARGET' });
    const now = Date.now();
    if (invite.expiresAt <= now) return res.status(400).json({ error: 'INVITE_EXPIRED' });
    const roomRaw = await redis.get(`sd:pvp:room:${invite.roomId}`);
    if (!roomRaw) return res.status(404).json({ error: 'ROOM_NOT_FOUND' });
    const room = JSON.parse(roomRaw);
    if (room.slots.guest !== null) return res.status(400).json({ error: 'ROOM_FULL' });
    if (room.phase !== 'WAITING_FOR_INVITEE') return res.status(400).json({ error: 'INVALID_PHASE_TRANSITION' });
    invite.status = 'ACCEPTED'; invite.resolvedAt = now;
    room.slots.guest = { userId, loginId: user.loginId, connected: true, ready: false, skinId };
    room.phase = 'READY_CHECK'; room.pendingInviteId = null; room.updatedAt = now; room.version += 1;
    await redis.set(`sd:pvp:invite:${inviteId}`, JSON.stringify(invite));
    await redis.set(`sd:pvp:room:${invite.roomId}`, JSON.stringify(room));
    await redis.set(`sd:pvp:room-membership:${userId}`, invite.roomId);
    await redis.srem(`sd:pvp:user-invites:${userId}`, inviteId);
    await redis.srem('sd:pvp:lobby:online', userId);
    await redis.del(`sd:pvp:presence:${userId}`);
    return res.json({ room, invite });
  } catch (error) {
    console.error('POST /api/pvp-online/invites/accept error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/pvp-online/invites/decline', async (req, res) => {
  try {
    if (!redis) return res.status(503).json({ error: 'Redis not connected' });
    const userId = await getUserIdForSession(req);
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });
    const { inviteId } = req.body || {};
    if (!inviteId) return res.status(400).json({ error: 'inviteId required' });
    const inviteRaw = await redis.get(`sd:pvp:invite:${inviteId}`);
    if (!inviteRaw) return res.status(404).json({ error: 'INVITE_NOT_FOUND' });
    const invite = JSON.parse(inviteRaw);
    if (invite.status !== 'PENDING') return res.status(400).json({ error: 'INVITE_NOT_PENDING' });
    if (invite.toUserId !== userId) return res.status(403).json({ error: 'NOT_INVITE_TARGET' });
    const now = Date.now();
    invite.status = 'DECLINED'; invite.resolvedAt = now;
    const roomRaw = await redis.get(`sd:pvp:room:${invite.roomId}`);
    if (roomRaw) {
      const room = JSON.parse(roomRaw);
      if (room.phase === 'WAITING_FOR_INVITEE') {
        room.phase = 'OPEN'; room.pendingInviteId = null; room.updatedAt = now; room.version += 1;
        await redis.set(`sd:pvp:room:${invite.roomId}`, JSON.stringify(room));
      }
    }
    await redis.set(`sd:pvp:invite:${inviteId}`, JSON.stringify(invite));
    await redis.srem(`sd:pvp:user-invites:${userId}`, inviteId);
    return res.json({ ok: true });
  } catch (error) {
    console.error('POST /api/pvp-online/invites/decline error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/pvp-online/invites/cancel', async (req, res) => {
  try {
    if (!redis) return res.status(503).json({ error: 'Redis not connected' });
    const userId = await getUserIdForSession(req);
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });
    const { inviteId } = req.body || {};
    if (!inviteId) return res.status(400).json({ error: 'inviteId required' });
    const inviteRaw = await redis.get(`sd:pvp:invite:${inviteId}`);
    if (!inviteRaw) return res.status(404).json({ error: 'INVITE_NOT_FOUND' });
    const invite = JSON.parse(inviteRaw);
    if (invite.status !== 'PENDING') return res.status(400).json({ error: 'INVITE_NOT_PENDING' });
    if (invite.fromUserId !== userId) return res.status(403).json({ error: 'NOT_INVITE_SENDER' });
    const now = Date.now();
    invite.status = 'CANCELED'; invite.resolvedAt = now;
    const roomRaw = await redis.get(`sd:pvp:room:${invite.roomId}`);
    if (roomRaw) {
      const room = JSON.parse(roomRaw);
      if (room.phase === 'WAITING_FOR_INVITEE') {
        room.phase = 'OPEN'; room.pendingInviteId = null; room.updatedAt = now; room.version += 1;
        await redis.set(`sd:pvp:room:${invite.roomId}`, JSON.stringify(room));
      }
    }
    await redis.set(`sd:pvp:invite:${inviteId}`, JSON.stringify(invite));
    await redis.srem(`sd:pvp:user-invites:${invite.toUserId}`, inviteId);
    return res.json({ ok: true });
  } catch (error) {
    console.error('POST /api/pvp-online/invites/cancel error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/pvp-online/invites/pending', async (req, res) => {
  try {
    if (!redis) return res.status(503).json({ error: 'Redis not connected' });
    const userId = await getUserIdForSession(req);
    if (!userId) return res.status(401).json({ error: 'Not authenticated' });
    const inviteIds = await redis.smembers(`sd:pvp:user-invites:${userId}`);
    const now = Date.now();
    const invites = [];
    const stale = [];
    for (const id of (inviteIds || [])) {
      const raw = await redis.get(`sd:pvp:invite:${id}`);
      if (!raw) { stale.push(id); continue; }
      const invite = JSON.parse(raw);
      if (invite.status === 'PENDING' && invite.expiresAt > now) invites.push(invite);
      else stale.push(id);
    }
    for (const id of stale) await redis.srem(`sd:pvp:user-invites:${userId}`, id);
    return res.json({ invites });
  } catch (error) {
    console.error('GET /api/pvp-online/invites/pending error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    message: 'Submarine Dash API is running',
    redis: redis ? 'connected' : 'not connected',
    migrationControl: productionRuntimeProbe(),
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Submarine Dash API running on http://localhost:${PORT}`);
  console.log(`📊 Leaderboard endpoint: http://localhost:${PORT}/api/leaderboard`);
  console.log(`🔌 Redis: ${redis ? 'Connected' : 'Not connected'}`);
});
