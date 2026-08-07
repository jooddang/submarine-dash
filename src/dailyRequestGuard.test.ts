import { describe, expect, it } from 'vitest';
import { DailyRequestGuard, latestDailyResult } from './dailyRequestGuard';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('daily request account guard', () => {
  it('drops an A response that resolves after B becomes current', async () => {
    const guard=new DailyRequestGuard(); let current:string|null='A'; const a=deferred<string>();
    const pending=latestDailyResult(guard,guard.begin('A'),()=>a.promise,()=>current);
    current='B'; guard.invalidate(); guard.begin('B'); a.resolve('A-progress');
    await expect(pending).resolves.toBeNull();
  });

  it('drops an account response that resolves after logout to guest', async () => {
    const guard=new DailyRequestGuard(); let current:string|null='A'; const a=deferred<string>();
    const pending=latestDailyResult(guard,guard.begin('A'),()=>a.promise,()=>current);
    current=null; guard.invalidate(); a.resolve('A-progress');
    await expect(pending).resolves.toBeNull();
  });
});
