export type ReconnectConfig = {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
};

export const DEFAULT_RECONNECT_CONFIG: ReconnectConfig = {
  maxRetries: 5,
  baseDelayMs: 1000,
  maxDelayMs: 15000,
};

export function getReconnectDelay(attempt: number, config: ReconnectConfig = DEFAULT_RECONNECT_CONFIG): number {
  return Math.min(config.maxDelayMs, config.baseDelayMs * Math.pow(2, attempt));
}
