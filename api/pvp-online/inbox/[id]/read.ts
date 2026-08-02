import type { VercelRequest, VercelResponse } from '@vercel/node';
import { withProductionControl } from './../../../_lib/productionControls.js';
import { getUserIdForSession } from '../../../_lib/auth.js';
import { markRead } from '../../../_lib/pvpOnlineInbox.js';

export const config = { runtime: 'nodejs' };

async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const userId = await getUserIdForSession(req);
  if (!userId) return res.status(401).json({ error: 'Not authenticated' });

  const inboxId = req.query.id as string;
  if (!inboxId) return res.status(400).json({ error: 'Missing inboxId' });

  const result = await markRead(userId, inboxId);
  return res.status(200).json({ ok: result.ok, inboxId, readAt: result.readAt });
}

export default withProductionControl('api/pvp-online/inbox/[id]/read.ts', handler);
