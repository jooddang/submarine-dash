import express from 'express';
import cors from 'cors';
import Redis from 'ioredis';
import dotenv from 'dotenv';
import { sanitizeLeaderboardName } from '../../shared/profanity.js';
import crypto from 'node:crypto';

// Load environment variables from parent directory
dotenv.config({ path: '../.env' });

const app = express();
const PORT = process.env.PORT || 3001;
const LEADERBOARD_KEY = 'submarine-dash:leaderboard';
const MAX_ENTRIES = 5;

// Auth (shared prefix with Vercel functions)
const KEY_PREFIX = 'sd:';
const SESSION_COOKIE_NAME = 'sd_session';
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days

// Initialize Redis client
let redis = null;
try {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    console.warn('⚠️  REDIS_URL not set. Leaderboard will not persist.');
  } else {
    redis = new Redis(redisUrl, {
      maxRetriesPerRequest: 3,
      enableOfflineQueue: false,
    });

    redis.on('connect', () => {
      console.log('✅ Connected to Redis');
    });

    redis.on('error', (err) => {
      console.error('❌ Redis error:', err.message);
    });
  }
} catch (error) {
  console.error('❌ Failed to initialize Redis:', error.message);
}

// Middleware
app.use(cors({
  origin: (origin, cb) => {
    // Allow same-origin and local dev origins
    if (!origin) return cb(null, true);
    if (origin === 'http://localhost:5173') return cb(null, true);
    if (origin.startsWith('http://localhost:')) return cb(null, true);
    return cb(null, false);
  },
  credentials: true,
}));
app.use(express.json());

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
  res.setHeader('Set-Cookie', parts.join('; '));
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
  res.setHeader('Set-Cookie', parts.join('; '));
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

  if (streak.lastKeptDate === date) return streak;

  const yday = yesterdayKeyUTC();
  const next = streak.lastKeptDate === yday ? (streak.current + 1) : 1;
  const updated = { current: next, lastKeptDate: date, updatedAt: Date.now() };
  progress.keptAt = Date.now();
  await redis.set(streakKey, JSON.stringify(updated));
  return updated;
}

// Helper functions
async function getLeaderboard() {
  if (!redis) {
    return [];
  }
  try {
    const data = await redis.get(LEADERBOARD_KEY);
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
  await redis.set(LEADERBOARD_KEY, JSON.stringify(leaderboard));
}

// API Routes

// --- Auth routes (dev backend) ---
app.post('/api/auth/register', async (req, res) => {
  try {
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

    const token = generateId('sess');
    await redis.set(keySession(token), user.userId, 'EX', SESSION_TTL_SECONDS);
    setSessionCookie(req, res, token);

    return res.json({ userId: user.userId, loginId: user.loginId, refCode: user.refCode });
  } catch (e) {
    console.error('POST /api/auth/login error:', e);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/auth/logout', async (req, res) => {
  try {
    if (!redis) return res.json({ ok: true });
    const cookies = parseCookies(req);
    const token = cookies[SESSION_COOKIE_NAME];
    if (token) await redis.del(keySession(token));
    clearSessionCookie(req, res);
    return res.json({ ok: true });
  } catch (e) {
    console.error('POST /api/auth/logout error:', e);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/auth/me', async (req, res) => {
  try {
    if (!redis) return res.json({ user: null });
    const userId = await getUserIdForSession(req);
    if (!userId) return res.json({ user: null });
    const user = await getUser(userId);
    if (!user) return res.json({ user: null });
    return res.json({ user: { userId: user.userId, loginId: user.loginId, refCode: user.refCode } });
  } catch (e) {
    console.error('GET /api/auth/me error:', e);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/missions/daily', async (req, res) => {
  try {
    if (!redis) return res.status(503).json({ error: 'Redis not connected' });
    const date = todayKeyUTC();

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

    return res.json({ date, missions, user: { progress, streak } });
  } catch (e) {
    console.error('GET /api/missions/daily error:', e);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/missions/event', async (req, res) => {
  try {
    if (!redis) return res.status(503).json({ error: 'Redis not connected' });

    const userId = await getUserIdForSession(req);
    if (!userId) return res.status(401).json({ error: 'Login required' });

    const body = req.body || {};
    if (!body.type) return res.status(400).json({ error: 'Invalid event' });

    const date = todayKeyUTC();
    const missionsRaw = await redis.get(keyDailyMissions(date));
    const missions = missionsRaw ? JSON.parse(missionsRaw) : defaultMissions();

    const progressKey = keyUserDaily(userId, date);
    const progressRaw = await redis.get(progressKey);
    const progress = progressRaw
      ? JSON.parse(progressRaw)
      : { runs: 0, oxygenCollected: 0, maxScore: 0, completedMissionIds: [] };

    const completedBefore = computeCompleted(missions, progress);

    if (body.type === 'run_end') {
      const score = typeof body.score === 'number' ? body.score : 0;
      progress.runs += 1;
      progress.maxScore = Math.max(progress.maxScore, score);
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
    if (shouldKeepToday) {
      await keepTodayAndUpdateStreak(userId, date, progress);
    }

    await redis.set(progressKey, JSON.stringify(progress));
    return res.json({ date, progress });
  } catch (e) {
    console.error('POST /api/missions/event error:', e);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/leaderboard - Get top 5 scores
app.get('/api/leaderboard', async (req, res) => {
  try {
    const leaderboard = await getLeaderboard();
    res.json(leaderboard);
  } catch (error) {
    console.error('GET /api/leaderboard error:', error);
    res.status(500).json({ error: 'Failed to fetch leaderboard' });
  }
});

// POST /api/leaderboard - Submit a new score
app.post('/api/leaderboard', async (req, res) => {
  try {
    if (!redis) {
      return res.status(503).json({ error: 'Redis not connected' });
    }

    const { name, score } = req.body;

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

    const leaderboard = await getLeaderboard();
    const requestedName = typeof name === 'string' ? name.trim() : '';
    const newEntry = {
      id: Date.now(),
      name: requestedName ? await sanitizeLeaderboardName(requestedName) : user.loginId,
      userId: user.loginId,
      score
    };

    // Add new entry and sort by score (descending)
    leaderboard.push(newEntry);
    leaderboard.sort((a, b) => b.score - a.score);

    // Keep only top entries
    const topLeaderboard = leaderboard.slice(0, MAX_ENTRIES);
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
    await setLeaderboard([]);
    res.json({ message: 'Leaderboard cleared' });
  } catch (error) {
    console.error('DELETE /api/leaderboard error:', error);
    res.status(500).json({ error: 'Failed to clear leaderboard' });
  }
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    message: 'Submarine Dash API is running',
    redis: redis ? 'connected' : 'not connected'
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Submarine Dash API running on http://localhost:${PORT}`);
  console.log(`📊 Leaderboard endpoint: http://localhost:${PORT}/api/leaderboard`);
  console.log(`🔌 Redis: ${redis ? 'Connected' : 'Not connected'}`);
});
