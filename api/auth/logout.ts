import type { VercelRequest, VercelResponse } from '@vercel/node';
import { clearSessionCookie, deleteSession } from '../_lib/auth';
import { RedisConfigError } from '../_lib/redis';

export const config = { runtime: 'nodejs' };

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    await deleteSession(req);
    clearSessionCookie(res);
    return res.status(200).json({ ok: true });
  } catch (error) {
    if (error instanceof RedisConfigError) {
      console.error('Auth logout API redis config error:', error.message);
      // Logout is best-effort; if storage isn't configured, just clear the cookie.
      clearSessionCookie(res);
      return res.status(200).json({ ok: true });
    }
    console.error('Auth logout API error:', error);
    return res.status(500).json({
      error: 'Internal server error',
      details: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}


