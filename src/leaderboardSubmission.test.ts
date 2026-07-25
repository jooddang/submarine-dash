import { describe, expect, it, vi } from 'vitest';
import { ApiResponseError } from './api';
import { runLeaderboardSubmission } from './leaderboardSubmission';

function createCallbacks<T>(submit: () => Promise<T>) {
  return {
    lock: { current: false },
    submit,
    onBusyChange: vi.fn(),
    onError: vi.fn(),
    onSuccess: vi.fn(),
    onUnauthorized: vi.fn(),
  };
}

describe('runLeaderboardSubmission', () => {
  it('resets auth and keeps the score retryable after a 401', async () => {
    const callbacks = createCallbacks(() =>
      Promise.reject(new ApiResponseError('Failed to submit score', 401, 'Login required')),
    );

    await expect(runLeaderboardSubmission(callbacks)).resolves.toBe(false);
    expect(callbacks.onUnauthorized).toHaveBeenCalledOnce();
    expect(callbacks.onSuccess).not.toHaveBeenCalled();
    expect(callbacks.onError).toHaveBeenLastCalledWith(
      'Your session expired. Log in again to submit this score.',
    );
    expect(callbacks.onBusyChange.mock.calls).toEqual([[true], [false]]);
    expect(callbacks.lock.current).toBe(false);
  });

  it('keeps a server failure retryable without resetting auth', async () => {
    const callbacks = createCallbacks(() =>
      Promise.reject(new ApiResponseError('Failed to submit score', 500, 'Server error')),
    );

    await expect(runLeaderboardSubmission(callbacks)).resolves.toBe(false);
    expect(callbacks.onUnauthorized).not.toHaveBeenCalled();
    expect(callbacks.onSuccess).not.toHaveBeenCalled();
    expect(callbacks.onError).toHaveBeenLastCalledWith(
      'Score submission failed. Please try again.',
    );
  });

  it('runs success transitions only after the server accepts the score', async () => {
    const result = { entryId: 1 };
    const callbacks = createCallbacks(() => Promise.resolve(result));

    await expect(runLeaderboardSubmission(callbacks)).resolves.toBe(true);
    expect(callbacks.onSuccess).toHaveBeenCalledWith(result);
    expect(callbacks.onUnauthorized).not.toHaveBeenCalled();
    expect(callbacks.onError).toHaveBeenCalledOnce();
    expect(callbacks.onError).toHaveBeenCalledWith(null);
  });

  it('blocks duplicate submissions while the first request is pending', async () => {
    let resolveSubmission: (value: { entryId: number }) => void = () => undefined;
    const submit = vi.fn(
      () =>
        new Promise<{ entryId: number }>((resolve) => {
          resolveSubmission = resolve;
        }),
    );
    const callbacks = createCallbacks(submit);

    const firstSubmission = runLeaderboardSubmission(callbacks);
    await expect(runLeaderboardSubmission(callbacks)).resolves.toBe(false);
    expect(submit).toHaveBeenCalledOnce();

    resolveSubmission({ entryId: 1 });
    await expect(firstSubmission).resolves.toBe(true);
  });
});
