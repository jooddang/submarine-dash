import { afterEach, describe, expect, it, vi } from 'vitest';
import { achievementsAPI, authAPI, leaderboardAPI } from './api';

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

  it('binds canonical score publication to stable run evidence and idempotency IDs', async () => {
    const fetchMock=vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({canonical:true,readOnly:false,
        writeCapabilities:['publish_score'],user:{userId:'fixture',loginId:'fixture',refCode:''}}),{status:200}))
      .mockResolvedValueOnce(new Response(JSON.stringify(successfulSubmission),{status:200}));
    vi.stubGlobal('fetch',fetchMock);
    await authAPI.me();
    const runEvidenceId='97000000-0000-4000-8000-000000000041';
    const idempotencyKey='97000000-0000-4000-8000-000000000042';
    await leaderboardAPI.submitScore('Diver',1200,'default',runEvidenceId,idempotencyKey);
    expect(JSON.parse((fetchMock.mock.calls[1][1] as RequestInit).body as string)).toEqual({
      name:'Diver',score:1200,skinId:'default',runEvidenceId,idempotencyKey,
    });
  });
});

describe('achievementsAPI.getByUsers', () => {
  it('includes the canonical session cookie for Supabase badge hydration', async () => {
    const fetchMock=vi.fn().mockResolvedValue(new Response(JSON.stringify({users:{}}),{status:200}));
    vi.stubGlobal('fetch',fetchMock);
    await achievementsAPI.getByUsers(['fixture']);
    expect(fetchMock.mock.calls[0][1]).toMatchObject({credentials:'include'});
  });
});
