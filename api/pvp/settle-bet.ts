import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getUpstashRedisClient } from '../_lib/redis.js';
import { getUserIdForSession, getUser } from '../_lib/auth.js';
import { getCoinBalance, addCoins } from '../_lib/coinInventory.js';
import { getSavedDolphins, addSavedDolphins, consumeOneSavedDolphin } from '../_lib/dolphinInventory.js';
import { getTubeState, saveTubeState } from '../_lib/tubeInventory.js';

export const config = { runtime: 'nodejs' };

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    // The caller must be authenticated (one of the two players)
    const callerUserId = await getUserIdForSession(req);
    if (!callerUserId) return res.status(401).json({ error: 'Login required' });

    const { winnerUserId, loserUserId, bet } = req.body || {};

    if (!winnerUserId || !loserUserId || !bet) {
      return res.status(400).json({ error: 'Missing winnerUserId, loserUserId, or bet' });
    }

    // Verify both users exist
    const winner = await getUser(winnerUserId);
    const loser = await getUser(loserUserId);
    if (!winner || !loser) {
      return res.status(400).json({ error: 'Invalid user IDs' });
    }

    // Verify caller is one of the two players
    if (callerUserId !== winnerUserId && callerUserId !== loserUserId) {
      return res.status(403).json({ error: 'Not authorized for this bet settlement' });
    }

    const rw = getUpstashRedisClient(false);
    const transferred = { coins: 0, dolphins: 0, tubePieces: 0 };

    // Transfer coins
    const requestedCoins = Math.max(0, Math.floor(bet.coins || 0));
    if (requestedCoins > 0) {
      const loserCoins = await getCoinBalance(rw, loserUserId);
      const actualCoins = Math.min(requestedCoins, loserCoins);
      if (actualCoins > 0) {
        // Deduct from loser
        const keyCoinBal = `sd:user:${loserUserId}:coins`;
        await rw.decrby(keyCoinBal, actualCoins);
        // Add to winner
        await addCoins(rw, winnerUserId, actualCoins, { type: 'pvp_bet_win', meta: { from: loserUserId } });
        transferred.coins = actualCoins;
      }
    }

    // Transfer dolphins
    const requestedDolphins = Math.max(0, Math.floor(bet.dolphins || 0));
    if (requestedDolphins > 0) {
      const loserDolphins = await getSavedDolphins(rw, loserUserId);
      const actualDolphins = Math.min(requestedDolphins, loserDolphins);
      for (let i = 0; i < actualDolphins; i++) {
        await consumeOneSavedDolphin(rw, loserUserId);
      }
      if (actualDolphins > 0) {
        await addSavedDolphins(rw, winnerUserId, actualDolphins, { type: 'pvp_bet_win', meta: { from: loserUserId } });
        transferred.dolphins = actualDolphins;
      }
    }

    // Transfer tube pieces
    const requestedTubes = Math.max(0, Math.floor(bet.tubePieces || 0));
    if (requestedTubes > 0) {
      const loserTube = await getTubeState(rw, loserUserId);
      const actualPieces = Math.min(requestedTubes, loserTube.pieces);
      if (actualPieces > 0) {
        await saveTubeState(rw, loserUserId, loserTube.pieces - actualPieces, loserTube.charges);
        const winnerTube = await getTubeState(rw, winnerUserId);
        await saveTubeState(rw, winnerUserId, winnerTube.pieces + actualPieces, winnerTube.charges);
        transferred.tubePieces = actualPieces;
      }
    }

    return res.status(200).json({ ok: true, transferred });
  } catch (e) {
    console.error('PVP settle-bet API error:', e);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
