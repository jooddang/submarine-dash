import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getUser, getUserIdForSession } from '../_lib/auth';
import { RedisConfigError } from '../_lib/redis';

export const config = { runtime: 'nodejs' };

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const userId = await getUserIdForSession(req);
    if (!userId) return res.status(200).json({ user: null });

    const user = await getUser(userId);
    if (!user) return res.status(200).json({ user: null });

    return res.status(200).json({
      user: {
        userId: user.userId,
        loginId: user.loginId,
        refCode: user.refCode,
      },
    });
  } catch (error) {
    if (error instanceof RedisConfigError) {
      console.error('Auth me API redis config error:', error.message);
      return res.status(503).json({ error: 'Server not configured', details: error.message });
    }
    console.error('Auth me API error:', error);
    return res.status(500).json({
      error: 'Internal server error',
      details: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}


