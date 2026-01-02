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

export type AuthUser = {
  userId: string;
  loginId: string;
  refCode: string;
};

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
        credentials: 'include',
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

export const authAPI = {
  async me(): Promise<AuthUser | null> {
    try {
      const res = await fetch(`${API_BASE_URL}/api/auth/me`, { credentials: 'include' });
      if (!res.ok) return null;
      const data = await res.json();
      return data?.user ?? null;
    } catch {
      return null;
    }
  },

  async register(loginId: string, password: string): Promise<AuthUser> {
    const res = await fetch(`${API_BASE_URL}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ loginId, password }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Register failed (status=${res.status}) ${text}`);
    }
    return await res.json();
  },

  async login(loginId: string, password: string): Promise<AuthUser> {
    const res = await fetch(`${API_BASE_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ loginId, password }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Login failed (status=${res.status}) ${text}`);
    }
    return await res.json();
  },

  async logout(): Promise<void> {
    await fetch(`${API_BASE_URL}/api/auth/logout`, {
      method: 'POST',
      credentials: 'include',
    }).catch(() => undefined);
  },
};

export type DailyMission = {
  id: string;
  type: 'reach_score' | 'play_runs' | 'collect_oxygen';
  title: string;
  target: number;
};

export type DailyMissionsResponse =
  | { date: string; missions: DailyMission[]; user: null }
  | {
      date: string;
      missions: DailyMission[];
      user: {
        progress: {
          runs: number;
          oxygenCollected: number;
          maxScore: number;
          completedMissionIds: string[];
          keptAt?: number;
        };
        streak: { current: number; lastKeptDate: string | null; updatedAt: number };
      };
    };

export const missionsAPI = {
  async getDaily(): Promise<DailyMissionsResponse> {
    const res = await fetch(`${API_BASE_URL}/api/missions/daily`, { credentials: 'include' });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Failed to fetch daily missions (status=${res.status}) ${text}`);
    }
    return await res.json();
  },

  async postEvent(event: { type: 'run_end'; score: number } | { type: 'oxygen_collected'; count?: number }): Promise<void> {
    // Best-effort; mission tracking should not block gameplay.
    await fetch(`${API_BASE_URL}/api/missions/event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(event),
    })
      .then(async (res) => {
        if (!res.ok) {
          const text = await res.text().catch(() => '');
          throw new Error(`Failed to post mission event (status=${res.status}) ${text}`);
        }
      })
      .catch((err) => {
        console.warn('Mission event failed:', err);
      });
  },
};
