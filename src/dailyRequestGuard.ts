export type DailyRequestToken = Readonly<{ epoch: number; account: string | null }>;

export class DailyRequestGuard {
  private epoch = 0;

  begin(account: string | null): DailyRequestToken {
    this.epoch += 1;
    return { epoch: this.epoch, account };
  }

  invalidate() {
    this.epoch += 1;
  }

  accepts(token: DailyRequestToken, currentAccount: string | null) {
    return token.epoch === this.epoch && token.account === currentAccount;
  }
}

export async function latestDailyResult<T>(
  guard: DailyRequestGuard,
  token: DailyRequestToken,
  load: () => Promise<T>,
  currentAccount: () => string | null,
) {
  const result = await load();
  return guard.accepts(token, currentAccount()) ? result : null;
}
