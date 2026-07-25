import { afterEach, describe, expect, it, vi } from 'vitest';
import { leaderboardAPI } from './api';

const successfulSubmission = {
  entry: {
    id: 1,
    name: 'Diver',
    score: 1200,
  },
  leaderboard: [],
  rank: 1,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('leaderboardAPI.submitScore', () => {
  it.each([
    { status: 401, body: { error: 'Login required' } },
    { status: 500, body: { error: 'Internal server error' } },
  ])('rejects a $status response instead of reporting success', async ({ status, body }) => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify(body), {
          status,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );

    await expect(leaderboardAPI.submitScore('Diver', 1200)).rejects.toThrow(
      `Failed to submit score (status=${status})`,
    );
  });

  it('returns the submitted entry for a successful response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify(successfulSubmission), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );

    await expect(leaderboardAPI.submitScore('Diver', 1200)).resolves.toEqual(
      successfulSubmission,
    );
  });
});
