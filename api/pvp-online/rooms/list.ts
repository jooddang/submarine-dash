import type { VercelRequest, VercelResponse } from '@vercel/node';
import { withProductionControl } from './../../_lib/productionControls.js';
import { getUserIdForSession } from '../../_lib/auth.js';
import { listJoinableRooms } from '../../_lib/pvpOnlineRooms.js';

export const config = { runtime: 'nodejs' };

async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const userId = await getUserIdForSession(req);
  if (!userId) return res.status(401).json({ error: 'Not authenticated' });

  const rooms = await listJoinableRooms();
  return res.status(200).json({ rooms, asOf: Date.now() });
}

export default withProductionControl('api/pvp-online/rooms/list.ts', handler);
