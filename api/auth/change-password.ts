import type { VercelRequest, VercelResponse } from '@vercel/node';
import {
  createSession,
  getUser,
  hashPassword,
  isRateLimited,
  keyLoginId,
  setUser,
  verifyPassword,
} from '../_lib/auth.js';
import { getUpstashRedisClient, RedisConfigError } from '../_lib/redis.js';

export const config = { runtime: 'nodejs' };

type ChangePasswordBody = {
  loginId: string;
  currentPassword: string;
  newPassword: string;
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
    if (await isRateLimited(`changePassword:${ip}`, 10, 60)) {
      return bad(res, 429, 'Too many requests');
    }

    const body = (req.body || {}) as Partial<ChangePasswordBody>;
    const loginId = (body.loginId || '').trim();
    const currentPassword = body.currentPassword || '';
    const newPassword = body.newPassword || '';

    if (!loginId || !currentPassword || !newPassword) {
      return bad(res, 400, 'Invalid request');
    }
    if (newPassword.length < 8 || newPassword.length > 72) {
      return bad(res, 400, 'Invalid new password');
    }

    const loginIdLower = loginId.toLowerCase();
    if (await isRateLimited(`changePassword:${ip}:${loginIdLower}`, 5, 60)) {
      return bad(res, 429, 'Too many requests');
    }

    const redis = getUpstashRedisClient(true);
    const userId = await redis.get<string>(keyLoginId(loginIdLower));
    if (!userId) {
      // Avoid user enumeration
      return bad(res, 401, 'Invalid credentials');
    }

    const user = await getUser(userId);
    if (!user) {
      return bad(res, 401, 'Invalid credentials');
    }

    const ok = await verifyPassword(currentPassword, user.passwordSalt, user.passwordHash);
    if (!ok) {
      return bad(res, 401, 'Invalid credentials');
    }

    const { saltB64, hashB64 } = await hashPassword(newPassword);
    user.passwordSalt = saltB64;
    user.passwordHash = hashB64;
    await setUser(user);

    // UX: after changing password successfully, log the user in (set session cookie).
    await createSession(res, user.userId);

    return res.status(200).json({
      userId: user.userId,
      loginId: user.loginId,
      refCode: user.refCode,
    });
  } catch (error) {
    if (error instanceof RedisConfigError) {
      console.error('Auth change-password API redis config error:', error.message);
      return res.status(503).json({ error: 'Server not configured', details: error.message });
    }
    console.error('Auth change-password API error:', error);
    return res.status(500).json({
      error: 'Internal server error',
      details: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}



