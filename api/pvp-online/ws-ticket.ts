import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getUserIdForSession, getUser } from '../_lib/auth.js';
import { generateWsTicket } from '../_lib/pvpOnlineAuth.js';

export const config = { runtime: 'nodejs' };

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const userId = await getUserIdForSession(req);
  if (!userId) return res.status(401).json({ error: 'Not authenticated' });

  const user = await getUser(userId);
  if (!user) return res.status(401).json({ error: 'User not found' });

  const { ticket, expiresAt } = await generateWsTicket(user.userId, user.loginId);

  return res.status(200).json({
    ticket,
    user: { userId: user.userId, loginId: user.loginId },
    expiresAt,
  });
}
