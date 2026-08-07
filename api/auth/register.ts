import type { VercelRequest, VercelResponse } from '@vercel/node';
import { withProductionControl } from './../_lib/productionControls.js';
import {
  createSession,
  getCanonicalSessionToken,
  generateId,
  generateRefCode,
  hashPassword,
  isRateLimited,
  isAllowedSubmarineMutationOrigin,
  keyLoginId,
  setUser,
  type UserRecord,
} from '../_lib/auth.js';
import { getUpstashRedisClient, RedisConfigError } from '../_lib/redis.js';

export const config = { runtime: 'nodejs' };

type RegisterBody = {
  loginId: string;
  password: string;
};

function bad(res: VercelResponse, status: number, message: string) {
  return res.status(status).json({ error: message });
}

async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return bad(res, 405, 'Method not allowed');
  if (!isAllowedSubmarineMutationOrigin(req)) return bad(res, 403, 'Forbidden');
  if (getCanonicalSessionToken(req)) return bad(res, 409, 'Canonical session must be logged out first');
  if (process.env.SD_CANONICAL_AUTH_TICKETS_ENABLED === 'true') {
    return res.status(409).json({
      error: 'New accounts use Roadcrosser Account',
      roadcrosserConnect: '/api/auth/roadcrosser/start',
    });
  }


  try {
    const ip = (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim() || 'unknown';
    if (await isRateLimited(`register:${ip}`, 10, 60)) {
      return bad(res, 429, 'Too many requests');
    }

    const body = (req.body || {}) as Partial<RegisterBody>;
    const loginId = (body.loginId || '').trim();
    const password = body.password || '';

    if (!loginId || loginId.length < 3 || loginId.length > 32) {
      return bad(res, 400, 'Invalid loginId');
    }
    if (!password || password.length < 8 || password.length > 72) {
      return bad(res, 400, 'Invalid password');
    }

    const loginIdLower = loginId.toLowerCase();
    const redis = getUpstashRedisClient(false);
    const exists = await redis.get<string>(keyLoginId(loginIdLower));
    if (exists) {
      // Avoid user enumeration; still return conflict-style message for UX
      return bad(res, 409, 'loginId already exists');
    }

    const { saltB64, hashB64 } = await hashPassword(password);
    const user: UserRecord = {
      userId: generateId('user'),
      loginId,
      loginIdLower,
      passwordHash: hashB64,
      passwordSalt: saltB64,
      createdAt: Date.now(),
      refCode: generateRefCode(),
    };

    await setUser(user);
    await createSession(res, user.userId);

    return res.status(200).json({
      userId: user.userId,
      loginId: user.loginId,
      refCode: user.refCode,
    });
  } catch (error) {
    if (error instanceof RedisConfigError) {
      console.error('Auth register API redis config error:', error.message);
      return res.status(503).json({ error: 'Server not configured', details: error.message });
    }
    console.error('Auth register API error:', error);
    return res.status(500).json({
      error: 'Internal server error',
      details: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}

export default withProductionControl('api/auth/register.ts', handler);
