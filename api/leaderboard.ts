import type { VercelRequest, VercelResponse } from '@vercel/node';
import { sanitizeLeaderboardName } from '../shared/profanity.js';
import { getUser, getUserIdForSession } from './_lib/auth';
import { getUpstashRedisClient } from './_lib/redis';

export const config = { runtime: 'nodejs' };

const LEADERBOARD_KEY = 'submarine-dash:leaderboard';
const MAX_ENTRIES = 5;

interface LeaderboardEntry {
  id: number;
  name: string;
  userId?: string; // loginId
  score: number;
}

function parseLeaderboard(data: unknown): LeaderboardEntry[] {
  if (!data) return [];

  // @upstash/redis may return already-parsed JSON (arrays/objects) for JSON values.
  if (Array.isArray(data)) return data as LeaderboardEntry[];

  if (typeof data === 'string') {
    const trimmed = data.trim();
    if (!trimmed) return [];
    // If it looks like JSON, parse it; otherwise treat as corrupt/legacy value.
    if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
      const parsed = JSON.parse(trimmed);
      return Array.isArray(parsed) ? (parsed as LeaderboardEntry[]) : [];
    }
    return [];
  }

  // Any other type: treat as invalid/corrupt
  return [];
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
      const client = getUpstashRedisClient(true);
      const data = await client.get(LEADERBOARD_KEY);
      const leaderboard = parseLeaderboard(data);
      // Sanitize names on read so previously-saved bad words don't show up.
      const sanitized = await Promise.all(
        leaderboard.map(async (e) => ({
          ...e,
          name: await sanitizeLeaderboardName(e.name),
        }))
      );
      return res.status(200).json(sanitized);
    }

    if (req.method === 'POST') {
      // Submit new score (requires login)
      const userId = await getUserIdForSession(req);
      if (!userId) {
        return res.status(401).json({ error: 'Login required' });
      }
      const user = await getUser(userId);
      if (!user) {
        return res.status(401).json({ error: 'Login required' });
      }

      const { name, score } = req.body;

      if (typeof score !== 'number') {
        return res.status(400).json({ error: 'Invalid name or score' });
      }

      const client = getUpstashRedisClient(false);
      const data = await client.get(LEADERBOARD_KEY);
      const leaderboard = parseLeaderboard(data);

      const requestedName = typeof name === 'string' ? name.trim() : '';
      const finalName = requestedName ? await sanitizeLeaderboardName(requestedName) : user.loginId;

      const newEntry: LeaderboardEntry = {
        id: Date.now(),
        name: finalName,
        userId: user.loginId,
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
      const client = getUpstashRedisClient(false);
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
