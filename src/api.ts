import type { LeaderboardEntry } from "./types";

// Use environment variable if available, otherwise auto-detect
// In production (Vercel), use relative path which will hit Vercel serverless functions
// In development, use local backend server
const getApiBaseUrl = () => {
  // In production on Vercel, use relative path
  if (import.meta.env.PROD) {
    return '';
  }

  // Allow override only in non-production (helps local dev without triggering "local network" prompts in prod)
  if (import.meta.env.VITE_API_URL) {
    return import.meta.env.VITE_API_URL;
  }

  // In development, use local backend
  return 'http://localhost:3001';
};

const API_BASE_URL = getApiBaseUrl();

export const leaderboardAPI = {
  // Get current leaderboard
  async getLeaderboard(): Promise<LeaderboardEntry[]> {
    try {
      const response = await fetch(`${API_BASE_URL}/api/leaderboard`);
      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(`Failed to fetch leaderboard (status=${response.status}) ${text}`);
      }
      return await response.json();
    } catch (error) {
      console.error('Error fetching leaderboard:', error);
      // Return empty array as fallback
      return [];
    }
  },

  // Submit a new score
  async submitScore(name: string, score: number): Promise<{
    entry: LeaderboardEntry;
    leaderboard: LeaderboardEntry[];
    rank: number;
  } | null> {
    try {
      const response = await fetch(`${API_BASE_URL}/api/leaderboard`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ name, score }),
      });

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(`Failed to submit score (status=${response.status}) ${text}`);
      }

      return await response.json();
    } catch (error) {
      console.error('Error submitting score:', error);
      return null;
    }
  },

  // Check if API is available
  async checkHealth(): Promise<boolean> {
    try {
      const response = await fetch(`${API_BASE_URL}/api/health`);
      return response.ok;
    } catch (error) {
      console.error('API health check failed:', error);
      return false;
    }
  }
};
