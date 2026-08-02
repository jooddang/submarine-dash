import type { VercelRequest, VercelResponse } from '@vercel/node';
import { withProductionControl } from './_lib/productionControls.js';
import { productionRuntimeProbe } from '../shared/productionRuntimeProbe.js';

export const config = { runtime: 'nodejs' };

async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  return res.status(200).json({
    status: 'ok',
    message: 'Submarine Dash API is running',
    timestamp: new Date().toISOString(),
    migrationControl: productionRuntimeProbe(),
  });
}

export default withProductionControl('api/health.ts', handler);
