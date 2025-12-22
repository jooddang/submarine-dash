import type { VercelRequest, VercelResponse } from '@vercel/node';
import Redis from 'ioredis';

const LEADERBOARD_KEY = 'submarine-dash:leaderboard';
const MAX_ENTRIES = 5;

interface LeaderboardEntry {
  id: number;
  name: string;
  score: number;
}

// Create Redis client
let redis: Redis | null = null;

function getRedisClient(): Redis {
  if (!redis) {
    const redisUrl = process.env.REDIS_URL;
    if (!redisUrl) {
      throw new Error('REDIS_URL environment variable is not set');
    }
    redis = new Redis(redisUrl, {
      maxRetriesPerRequest: 3,
      enableOfflineQueue: false,
    });
  }
  return redis;
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
    const client = getRedisClient();

    if (req.method === 'GET') {
      // Get leaderboard
      const data = await client.get(LEADERBOARD_KEY);
      const leaderboard: LeaderboardEntry[] = data ? JSON.parse(data) : [];
      return res.status(200).json(leaderboard);
    }

    if (req.method === 'POST') {
      // Submit new score
      const { name, score } = req.body;

      if (!name || typeof score !== 'number') {
        return res.status(400).json({ error: 'Invalid name or score' });
      }

      const data = await client.get(LEADERBOARD_KEY);
      const leaderboard: LeaderboardEntry[] = data ? JSON.parse(data) : [];

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
      await client.set(LEADERBOARD_KEY, JSON.stringify(topLeaderboard));

      const rank = topLeaderboard.findIndex(e => e.id === newEntry.id) + 1;

      return res.status(200).json({
        entry: newEntry,
        leaderboard: topLeaderboard,
        rank
      });
    }

    if (req.method === 'DELETE') {
      // Clear leaderboard (for testing)
      await client.set(LEADERBOARD_KEY, JSON.stringify([]));
      return res.status(200).json({ message: 'Leaderboard cleared' });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (error) {
    console.error('Leaderboard API error:', error);
    return res.status(500).json({
      error: 'Internal server error',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
}
