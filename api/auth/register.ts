import type { VercelRequest, VercelResponse } from '@vercel/node';
import {
  createSession,
  generateId,
  generateRefCode,
  hashPassword,
  isRateLimited,
  keyLoginId,
  setUser,
  type UserRecord,
} from '../_lib/auth';
import { getUpstashRedisClient } from '../_lib/redis';

export const config = { runtime: 'nodejs' };

type RegisterBody = {
  loginId: string;
  password: string;
};

function bad(res: VercelResponse, status: number, message: string) {
  return res.status(status).json({ error: message });
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return bad(res, 405, 'Method not allowed');

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
    console.error('Auth register API error:', error);
    return res.status(500).json({
      error: 'Internal server error',
      details: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}


