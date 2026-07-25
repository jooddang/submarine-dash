import { ApiResponseError } from './api';

type SubmissionLock = {
  current: boolean;
};

type SubmissionCallbacks<TResult> = {
  lock: SubmissionLock;
  submit: () => Promise<TResult>;
  onBusyChange: (isBusy: boolean) => void;
  onError: (message: string | null) => void;
  onSuccess: (result: TResult) => void;
  onUnauthorized: () => void;
};

export async function runLeaderboardSubmission<TResult>({
  lock,
  submit,
  onBusyChange,
  onError,
  onSuccess,
  onUnauthorized,
}: SubmissionCallbacks<TResult>): Promise<boolean> {
  if (lock.current) return false;

  lock.current = true;
  onError(null);
  onBusyChange(true);

  try {
    const result = await submit();
    onSuccess(result);
    return true;
  } catch (error) {
    if (error instanceof ApiResponseError && error.status === 401) {
      onUnauthorized();
      onError('Your session expired. Log in again to submit this score.');
    } else {
      onError('Score submission failed. Please try again.');
    }
    return false;
  } finally {
    lock.current = false;
    onBusyChange(false);
  }
}
