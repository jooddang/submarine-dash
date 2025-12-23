import express from 'express';
import cors from 'cors';
import Redis from 'ioredis';
import dotenv from 'dotenv';
import { sanitizeLeaderboardName } from '../../shared/profanity.js';

// Load environment variables from parent directory
dotenv.config({ path: '../.env' });

const app = express();
const PORT = process.env.PORT || 3001;
const LEADERBOARD_KEY = 'submarine-dash:leaderboard';
const MAX_ENTRIES = 5;

// Initialize Redis client
let redis = null;
try {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    console.warn('⚠️  REDIS_URL not set. Leaderboard will not persist.');
  } else {
    redis = new Redis(redisUrl, {
      maxRetriesPerRequest: 3,
      enableOfflineQueue: false,
    });

    redis.on('connect', () => {
      console.log('✅ Connected to Redis');
    });

    redis.on('error', (err) => {
      console.error('❌ Redis error:', err.message);
    });
  }
} catch (error) {
  console.error('❌ Failed to initialize Redis:', error.message);
}

// Middleware
app.use(cors());
app.use(express.json());

// Helper functions
async function getLeaderboard() {
  if (!redis) {
    return [];
  }
  try {
    const data = await redis.get(LEADERBOARD_KEY);
    return data ? JSON.parse(data) : [];
  } catch (error) {
    console.error('Error reading leaderboard:', error);
    return [];
  }
}

async function setLeaderboard(leaderboard) {
  if (!redis) {
    throw new Error('Redis not connected');
  }
  await redis.set(LEADERBOARD_KEY, JSON.stringify(leaderboard));
}

// API Routes

// GET /api/leaderboard - Get top 5 scores
app.get('/api/leaderboard', async (req, res) => {
  try {
    const leaderboard = await getLeaderboard();
    res.json(leaderboard);
  } catch (error) {
    console.error('GET /api/leaderboard error:', error);
    res.status(500).json({ error: 'Failed to fetch leaderboard' });
  }
});

// POST /api/leaderboard - Submit a new score
app.post('/api/leaderboard', async (req, res) => {
  try {
    if (!redis) {
      return res.status(503).json({ error: 'Redis not connected' });
    }

    const { name, score } = req.body;

    if (!name || typeof score !== 'number') {
      return res.status(400).json({ error: 'Invalid name or score' });
    }

    const leaderboard = await getLeaderboard();
    const newEntry = {
      id: Date.now(),
      name: await sanitizeLeaderboardName(name),
      score
    };

    // Add new entry and sort by score (descending)
    leaderboard.push(newEntry);
    leaderboard.sort((a, b) => b.score - a.score);

    // Keep only top entries
    const topLeaderboard = leaderboard.slice(0, MAX_ENTRIES);
    await setLeaderboard(topLeaderboard);

    const rank = topLeaderboard.findIndex(e => e.id === newEntry.id) + 1;

    res.json({
      entry: newEntry,
      leaderboard: topLeaderboard,
      rank
    });
  } catch (error) {
    console.error('POST /api/leaderboard error:', error);
    res.status(500).json({ error: 'Failed to submit score' });
  }
});

// DELETE /api/leaderboard - Clear leaderboard (for testing)
app.delete('/api/leaderboard', async (req, res) => {
  try {
    if (!redis) {
      return res.status(503).json({ error: 'Redis not connected' });
    }
    await setLeaderboard([]);
    res.json({ message: 'Leaderboard cleared' });
  } catch (error) {
    console.error('DELETE /api/leaderboard error:', error);
    res.status(500).json({ error: 'Failed to clear leaderboard' });
  }
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    message: 'Submarine Dash API is running',
    redis: redis ? 'connected' : 'not connected'
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Submarine Dash API running on http://localhost:${PORT}`);
  console.log(`📊 Leaderboard endpoint: http://localhost:${PORT}/api/leaderboard`);
  console.log(`🔌 Redis: ${redis ? 'Connected' : 'Not connected'}`);
});
