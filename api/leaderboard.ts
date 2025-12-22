import type { VercelRequest, VercelResponse } from '@vercel/node';
import { kv } from '@vercel/kv';

const LEADERBOARD_KEY = 'submarine-dash:leaderboard';
const MAX_ENTRIES = 5;

interface LeaderboardEntry {
  id: number;
  name: string;
  score: number;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Enable CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  try {
    if (req.method === 'GET') {
      // Get leaderboard
      const leaderboard = await kv.get<LeaderboardEntry[]>(LEADERBOARD_KEY) || [];
      return res.status(200).json(leaderboard);
    }

    if (req.method === 'POST') {
      // Submit new score
      const { name, score } = req.body;

      if (!name || typeof score !== 'number') {
        return res.status(400).json({ error: 'Invalid name or score' });
      }

      const leaderboard = await kv.get<LeaderboardEntry[]>(LEADERBOARD_KEY) || [];

      const newEntry: LeaderboardEntry = {
        id: Date.now(),
        name: name.trim() || 'Anonymous',
        score
      };

      // Add new entry and sort
      leaderboard.push(newEntry);
      leaderboard.sort((a, b) => b.score - a.score);

      // Keep only top entries
      const topLeaderboard = leaderboard.slice(0, MAX_ENTRIES);
      await kv.set(LEADERBOARD_KEY, topLeaderboard);

      const rank = topLeaderboard.findIndex(e => e.id === newEntry.id) + 1;

      return res.status(200).json({
        entry: newEntry,
        leaderboard: topLeaderboard,
        rank
      });
    }

    if (req.method === 'DELETE') {
      // Clear leaderboard (for testing)
      await kv.set(LEADERBOARD_KEY, []);
      return res.status(200).json({ message: 'Leaderboard cleared' });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (error) {
    console.error('Leaderboard API error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
