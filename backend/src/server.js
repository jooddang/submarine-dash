import express from 'express';
import cors from 'cors';
import fs from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3001;
const DATA_FILE = join(__dirname, '../data/leaderboard.json');

// Middleware
app.use(cors());
app.use(express.json());

// Ensure data directory and file exist
async function initDataFile() {
  try {
    await fs.mkdir(join(__dirname, '../data'), { recursive: true });
    try {
      await fs.access(DATA_FILE);
    } catch {
      // File doesn't exist, create it with empty array
      await fs.writeFile(DATA_FILE, JSON.stringify([], null, 2));
    }
  } catch (error) {
    console.error('Error initializing data file:', error);
  }
}

// Read leaderboard from file
async function readLeaderboard() {
  try {
    const data = await fs.readFile(DATA_FILE, 'utf-8');
    return JSON.parse(data);
  } catch (error) {
    console.error('Error reading leaderboard:', error);
    return [];
  }
}

// Write leaderboard to file
async function writeLeaderboard(leaderboard) {
  try {
    await fs.writeFile(DATA_FILE, JSON.stringify(leaderboard, null, 2));
  } catch (error) {
    console.error('Error writing leaderboard:', error);
    throw error;
  }
}

// API Routes

// GET /api/leaderboard - Get top 5 scores
app.get('/api/leaderboard', async (req, res) => {
  try {
    const leaderboard = await readLeaderboard();
    res.json(leaderboard);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch leaderboard' });
  }
});

// POST /api/leaderboard - Submit a new score
app.post('/api/leaderboard', async (req, res) => {
  try {
    const { name, score } = req.body;

    if (!name || typeof score !== 'number') {
      return res.status(400).json({ error: 'Invalid name or score' });
    }

    const leaderboard = await readLeaderboard();
    const newEntry = {
      id: Date.now(),
      name: name.trim() || 'Anonymous',
      score
    };

    // Add new entry and sort by score (descending)
    leaderboard.push(newEntry);
    leaderboard.sort((a, b) => b.score - a.score);

    // Keep only top 5
    const topLeaderboard = leaderboard.slice(0, 5);
    await writeLeaderboard(topLeaderboard);

    res.json({
      entry: newEntry,
      leaderboard: topLeaderboard,
      rank: topLeaderboard.findIndex(e => e.id === newEntry.id) + 1
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to submit score' });
  }
});

// DELETE /api/leaderboard - Clear leaderboard (for testing)
app.delete('/api/leaderboard', async (req, res) => {
  try {
    await writeLeaderboard([]);
    res.json({ message: 'Leaderboard cleared' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to clear leaderboard' });
  }
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', message: 'Submarine Dash API is running' });
});

// Initialize and start server
await initDataFile();

app.listen(PORT, () => {
  console.log(`🚀 Submarine Dash API running on http://localhost:${PORT}`);
  console.log(`📊 Leaderboard endpoint: http://localhost:${PORT}/api/leaderboard`);
});
