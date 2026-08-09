import type { LeaderboardEntry, WeeklyLeaderboard } from "./types";
import { validateCanonicalGameplayResponse } from '../shared/canonicalGameplay.js';

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
const MUTATION_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export class ApiResponseError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly responseBody: string,
  ) {
    super(`${message} (status=${status}) ${responseBody}`);
    this.name = 'ApiResponseError';
  }
}

function getTimezoneOffsetMinutes(): number {
  // JS returns minutes to add to local time to get UTC (e.g., KST => -540)
  return new Date().getTimezoneOffset();
}

function getTimezoneHeaders(): Record<string, string> {
  return { 'x-tz-offset-min': String(getTimezoneOffsetMinutes()) };
}

export type TubeState = { pieces: number; charges: number };
export type SkinState = { owned: string[]; equipped: string };

export type AuthUser = {
  userId: string;
  loginId: string;
  refCode: string;
  canonical: boolean;
  readOnly: boolean;
  readCapabilities?: string[];
  writeCapabilities?: string[];
  inventory?: { dolphinSaved: number; coins: number; tube?: TubeState; skins?: SkinState };
  rewards?: {
    weeklyWinner?: { dolphin: true; weekId: string };
    grants?: { dolphin: number };
  };
};

let activeAuthAccess: Pick<AuthUser, 'userId' | 'canonical' | 'readOnly' | 'readCapabilities' | 'writeCapabilities'> | null = null;

export function isReadOnlyCanary(user: AuthUser | null | undefined): boolean {
  return user?.canonical === true && user.readOnly === true;
}

export function dolphinMutationAccessState(user: AuthUser | null, hasPendingConsume: boolean) {
  const pending = Boolean(user?.canonical && hasPendingConsume);
  return { pending, enabled: !isReadOnlyCanary(user) && !pending };
}

function rememberAuthAccess(user: AuthUser | null) {
  activeAuthAccess = user ? {
    userId: user.userId, canonical: user.canonical, readOnly: user.readOnly,
    readCapabilities: user.readCapabilities || [], writeCapabilities: user.writeCapabilities || [],
  } : null;
}

function requireReadableGameSession(capability: string) {
  if (activeAuthAccess?.canonical && !activeAuthAccess.readCapabilities?.includes(capability)) {
    throw new Error('This canonical read capability is unavailable');
  }
}

function requireWritableGameSession(capability?: string) {
  if (activeAuthAccess?.canonical && (!capability || !activeAuthAccess.writeCapabilities?.includes(capability))) {
    throw new Error('This canonical canary session is read-only');
  }
}

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

  // Get current + historical weekly leaderboards (PST week boundary)
  async getWeeklyLeaderboards(limit?: number): Promise<{
    currentWeekId: string;
    current: LeaderboardEntry[];
    weeks: WeeklyLeaderboard[];
  }> {
    const qs = typeof limit === "number" ? `?limit=${encodeURIComponent(String(limit))}` : "";
    const res = await fetch(`${API_BASE_URL}/api/leaderboard/weekly${qs}`);
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Failed to fetch weekly leaderboards (status=${res.status}) ${text}`);
    }
    return await res.json();
  },

  // Submit a new score
  async submitScore(name: string, score: number, skinId?: string): Promise<{
    entry: LeaderboardEntry;
    leaderboard: LeaderboardEntry[];
    rank: number;
  }> {
    requireWritableGameSession();
    const response = await fetch(`${API_BASE_URL}/api/leaderboard`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      credentials: 'include',
      body: JSON.stringify({ name, score, skinId }),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new ApiResponseError('Failed to submit score', response.status, text);
    }

    return await response.json();
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
  beginRoadcrosserConnect(): void {
    const target = `${API_BASE_URL}/api/auth/roadcrosser/start`;
    if (window.top) window.top.location.href = target;
    else window.location.href = target;
  },

  async me(): Promise<AuthUser | null> {
    try {
      const res = await fetch(`${API_BASE_URL}/api/auth/me`, { credentials: 'include' });
      if (!res.ok) { rememberAuthAccess(null); return null; }
      const data = await res.json();
      if (!data?.user) { rememberAuthAccess(null); return null; }
      const user = {
        ...data.user,
        inventory: data.inventory,
        rewards: data.rewards,
        canonical: data.canonical === true,
        readOnly: data.readOnly === true,
        readCapabilities: Array.isArray(data.readCapabilities) ? data.readCapabilities : [],
        writeCapabilities: Array.isArray(data.writeCapabilities) ? data.writeCapabilities : [],
      } as AuthUser;
      rememberAuthAccess(user);
      if (user.canonical && user.writeCapabilities?.includes('settle_run_end')) {
        try {
          await flushPendingCanonicalRuns(user.userId);
        } catch (error) {
          // Network failures are safe because the durable outbox remains. A
          // persistence failure is retained as blocking state for Game to show.
          if (isRunOutboxPersistenceError(error)) console.error('Canonical run outbox persistence failed:', error);
        }
      }
      return user;
    } catch {
      rememberAuthAccess(null);
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
    const user = { ...(await res.json()), canonical: false, readOnly: false } as AuthUser;
    rememberAuthAccess(user);
    return user;
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
    const user = { ...(await res.json()), canonical: false, readOnly: false } as AuthUser;
    rememberAuthAccess(user);
    return user;
  },

  async logout(): Promise<void> {
    const response = await fetch(`${API_BASE_URL}/api/auth/logout`, {
      method: 'POST',
      credentials: 'include',
    });
    if (!response.ok) throw new Error(`Logout failed (${response.status})`);
    rememberAuthAccess(null);
  },

  async changePassword(loginId: string, currentPassword: string, newPassword: string): Promise<AuthUser> {
    const res = await fetch(`${API_BASE_URL}/api/auth/change-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ loginId, currentPassword, newPassword }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Change password failed (status=${res.status}) ${text}`);
    }
    const user = { ...(await res.json()), canonical: false, readOnly: false } as AuthUser;
    rememberAuthAccess(user);
    return user;
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
        inventory?: { dolphinSaved: number; coins: number; tube?: TubeState; skins?: SkinState };
      };
    };

type MissionEvent =
  | { type: 'run_end'; score: number; tubePieces?: number; tubeCharges?: number; deathCause?: string | null; perfectPlatformer?: boolean; allOxygenCollected?: boolean; urchinDodges?: number; swordfishCollected?: boolean; swordfishDodged?: boolean }
  | { type: 'oxygen_collected'; count?: number }
  | { type: 'pvp_result'; won: boolean };

type RunOutbox = { kind?: 'run_attempt_v1'; account: string; reservationId?: string; createdAt?: number;
  idempotencyKey: string; runEvidenceId: string; event: Extract<MissionEvent, { type: 'run_end' }> };
type RunReservation = { kind: 'run_capacity_reservation_v1'; account: string; reservationId: string;
  reservedAt: number; padding: string };
type RunOutboxItem = RunOutbox | RunReservation;
const MAX_RUN_ATTEMPT_SERIALIZED_BYTES = 2048;
const RUN_RESERVATION_SERIALIZED_BYTES = MAX_RUN_ATTEMPT_SERIALIZED_BYTES + 128;
const RUN_RESERVATION_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;
const volatileRunAttempts = new Map<string, RunOutbox[]>();
const runOutboxPersistenceFailures = new Set<string>();

export class RunOutboxPersistenceError extends Error {
  readonly code = 'RUN_OUTBOX_PERSISTENCE_FAILED';
  constructor(readonly account: string, cause?: unknown) {
    super('Run progress could not be saved safely on this device. Free browser storage and retry before starting another run.', { cause });
    this.name = 'RunOutboxPersistenceError';
  }
}

export function isRunOutboxPersistenceError(error: unknown): error is RunOutboxPersistenceError {
  return error instanceof RunOutboxPersistenceError
    || (error instanceof Error && (error as Error & { code?: string }).code === 'RUN_OUTBOX_PERSISTENCE_FAILED');
}

function runOutboxKey(account: string) { return `sd:gameplay-run-outbox:${account}`; }

function serializedBytes(value: unknown) {
  return new TextEncoder().encode(typeof value === 'string' ? value : JSON.stringify(value)).byteLength;
}

function validRunAttempt(value: RunOutboxItem | null, account: string): value is RunOutbox {
  return Boolean(value && value.kind !== 'run_capacity_reservation_v1' && value.account === account
    && MUTATION_UUID_RE.test(value.idempotencyKey) && MUTATION_UUID_RE.test(value.runEvidenceId)
    && value.event?.type === 'run_end');
}

function validRunReservation(value: RunOutboxItem | null, account: string): value is RunReservation {
  return value?.kind === 'run_capacity_reservation_v1' && value.account === account
    && MUTATION_UUID_RE.test(value.reservationId) && Number.isSafeInteger(value.reservedAt)
    && typeof value.padding === 'string' && !('event' in value)
    && serializedBytes(value) >= MAX_RUN_ATTEMPT_SERIALIZED_BYTES;
}

function persistenceFailure(account: string, cause?: unknown): RunOutboxPersistenceError {
  runOutboxPersistenceFailures.add(account);
  return new RunOutboxPersistenceError(account, cause);
}

function readDurableRunQueue(account: string): RunOutboxItem[] {
  const key = runOutboxKey(account);
  try {
    const value = JSON.parse(localStorage.getItem(key) || '[]') as RunOutboxItem[] | RunOutboxItem;
    const queue = Array.isArray(value) ? value : [value];
    if (queue.every((item) => validRunAttempt(item, account) || validRunReservation(item, account))) return queue;
    throw persistenceFailure(account, new Error('Stored run outbox is invalid'));
  } catch (error) {
    if (isRunOutboxPersistenceError(error)) throw error;
    throw persistenceFailure(account, error);
  }
}

function writeDurableRunQueue(account: string, queue: RunOutboxItem[]) {
  try {
    if (queue.length === 0) localStorage.removeItem(runOutboxKey(account));
    else localStorage.setItem(runOutboxKey(account), JSON.stringify(queue));
    if (!volatileRunAttempts.get(account)?.length) runOutboxPersistenceFailures.delete(account);
  } catch (error) {
    throw persistenceFailure(account, error);
  }
}

function persistVolatileRunAttempts(account: string) {
  const volatile = volatileRunAttempts.get(account) || [];
  const durable = readDurableRunQueue(account);
  if (volatile.length) {
    const next = [...durable];
    for (const attempt of volatile) {
      const index = next.findIndex((item) => validRunReservation(item, account)
        && item.reservationId === attempt.reservationId);
      if (index < 0) throw persistenceFailure(account, new Error('Reserved run capacity is missing'));
      if (serializedBytes(attempt) > serializedBytes(next[index])) {
        throw persistenceFailure(account, new Error('Run attempt exceeds reserved capacity'));
      }
      next[index] = attempt;
    }
    writeDurableRunQueue(account, next);
    volatileRunAttempts.delete(account);
    runOutboxPersistenceFailures.delete(account);
  }
}

function createRunReservation(account: string): RunReservation {
  const reservation: RunReservation = {
    kind: 'run_capacity_reservation_v1', account, reservationId: crypto.randomUUID(),
    reservedAt: Date.now(), padding: '',
  };
  const missing = RUN_RESERVATION_SERIALIZED_BYTES - serializedBytes(reservation);
  if (missing > 0) reservation.padding = 'x'.repeat(missing);
  return reservation;
}

function reserveDurableRunStorage(account: string): string {
  persistVolatileRunAttempts(account);
  const now = Date.now();
  const queue = readDurableRunQueue(account);
  const withoutExpiredReservations = queue.filter((item) => !(
    validRunReservation(item, account) && item.reservedAt <= now - RUN_RESERVATION_EXPIRY_MS
  ));
  const reservation = createRunReservation(account);
  writeDurableRunQueue(account, [...withoutExpiredReservations, reservation]);
  return reservation.reservationId;
}

function replaceRunReservation(account: string, reservationId: string,
  event: Extract<MissionEvent, { type: 'run_end' }>) {
  if (!MUTATION_UUID_RE.test(reservationId)) {
    throw persistenceFailure(account, new Error('Canonical run capacity reservation is required'));
  }
  if (runOutboxPersistenceFailures.has(account) || volatileRunAttempts.get(account)?.length) {
    throw persistenceFailure(account, new Error('A prior run is not durable yet'));
  }
  const attempt: RunOutbox = { kind: 'run_attempt_v1', account, reservationId, createdAt: Date.now(),
    idempotencyKey: crypto.randomUUID(), runEvidenceId: crypto.randomUUID(), event };
  try {
    const queue = readDurableRunQueue(account);
    const index = queue.findIndex((item) => validRunReservation(item, account) && item.reservationId === reservationId);
    if (index < 0) throw new Error('Reserved run capacity is missing');
    if (serializedBytes(attempt) > MAX_RUN_ATTEMPT_SERIALIZED_BYTES
      || serializedBytes(attempt) > serializedBytes(queue[index])) {
      throw new Error('Run attempt exceeds reserved capacity');
    }
    const next = [...queue];
    next[index] = attempt;
    if (serializedBytes(next) > serializedBytes(queue)) throw new Error('Run replacement grew the durable outbox');
    // Exactly one storage write replaces the reserved bytes with the attempt.
    writeDurableRunQueue(account, next);
  } catch (error) {
    volatileRunAttempts.set(account, [...(volatileRunAttempts.get(account) || []), attempt]);
    throw persistenceFailure(account, error);
  }
}

function isActiveCanonicalAccount(account: string) {
  return activeAuthAccess?.canonical === true && activeAuthAccess.userId === account;
}

function assertActiveCanonicalAccount(account: string) {
  if (!isActiveCanonicalAccount(account)) throw new Error('Canonical run flush cancelled after account change');
}

async function sendCanonicalMissionEvent(account: string, event: MissionEvent, idempotencyKey: string, runEvidenceId: string | null) {
  const res = await fetch(`${API_BASE_URL}/api/missions/event`, {
    method: 'POST', credentials: 'include',
    headers: {
      'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey,
      'Expected-External-User-Id': account,
      ...(runEvidenceId ? { 'Run-Evidence-Id': runEvidenceId } : {}), ...getTimezoneHeaders(),
    },
    body: JSON.stringify(event),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new ApiResponseError('Failed to post mission event', res.status, text);
  }
  const result = validateCanonicalGameplayResponse(await res.json(), event.type);
  if (result.acknowledgement.externalUserId !== account) {
    throw new Error('Canonical gameplay acknowledgement account mismatch');
  }
  return result;
}

async function flushPendingCanonicalRuns(account: string) {
  assertActiveCanonicalAccount(account);
  requireWritableGameSession('settle_run_end');
  persistVolatileRunAttempts(account);
  let result = null;
  while (true) {
    assertActiveCanonicalAccount(account);
    const queue = readDurableRunQueue(account);
    const pending = queue.find((item): item is RunOutbox => validRunAttempt(item, account));
    if (!pending) return result; // Capacity reservations are never sent.
    assertActiveCanonicalAccount(account);
    result = await sendCanonicalMissionEvent(account, pending.event, pending.idempotencyKey, pending.runEvidenceId);
    // The server may have acknowledged A while the browser switched to B. Do
    // not mutate A's outbox in that state; replaying the same idempotency key
    // when A returns is safe.
    assertActiveCanonicalAccount(account);
    if (result.acknowledgement.externalUserId !== pending.account) {
      throw new Error('Canonical gameplay acknowledgement account mismatch');
    }
    const current = readDurableRunQueue(account);
    assertActiveCanonicalAccount(account);
    const index = current.findIndex((item) => validRunAttempt(item, account)
      && item.idempotencyKey === pending.idempotencyKey && item.runEvidenceId === pending.runEvidenceId);
    if (index >= 0) writeDurableRunQueue(account, [...current.slice(0, index), ...current.slice(index + 1)]);
  }
}

export const missionsAPI = {
  hasRunSavePersistenceFailure(account: string): boolean {
    return runOutboxPersistenceFailures.has(account) || Boolean(volatileRunAttempts.get(account)?.length);
  },

  retryRunOutboxPersistence(account: string): void {
    if (!isActiveCanonicalAccount(account)) throw new Error('Cannot retry a run save for another account');
    persistVolatileRunAttempts(account);
    if (!volatileRunAttempts.get(account)?.length && runOutboxPersistenceFailures.has(account)) {
      writeDurableRunQueue(account, readDurableRunQueue(account));
    }
  },

  preflightCanonicalRunStorage(account: string): string {
    if (!isActiveCanonicalAccount(account)) throw new Error('Cannot preflight run storage for another account');
    requireWritableGameSession('settle_run_end');
    return reserveDurableRunStorage(account);
  },

  async getDaily(): Promise<DailyMissionsResponse> {
    requireReadableGameSession('read_daily_missions');
    const res = await fetch(`${API_BASE_URL}/api/missions/daily`, {
      credentials: 'include',
      headers: getTimezoneHeaders(),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Failed to fetch daily missions (status=${res.status}) ${text}`);
    }
    return await res.json();
  },

  async postEvent(
    event: MissionEvent,
    options: { reservationId?: string } = {},
  ): Promise<
    | {
        date: string;
        progress: {
          runs: number;
          oxygenCollected: number;
          maxScore: number;
          completedMissionIds: string[];
          keptAt?: number;
        };
        rewards?: { streak?: { dolphin: number; streakDays: number } };
        coinsEarned?: number;
        inventory?: { dolphinSaved: number; coins: number; tube?: TubeState; skins?: SkinState };
        newAchievements?: string[];
      }
    | null
  > {
    if (activeAuthAccess?.canonical) {
      const account = activeAuthAccess.userId;
      const capability = event.type === 'run_end' ? 'settle_run_end'
        : event.type === 'oxygen_collected' ? 'settle_oxygen_collected' : 'settle_pvp_result';
      requireWritableGameSession(capability);
      if (event.type === 'run_end') {
        replaceRunReservation(account, options.reservationId || '', event);
        return await flushPendingCanonicalRuns(account);
      }
      await flushPendingCanonicalRuns(account);
      assertActiveCanonicalAccount(account);
      return await sendCanonicalMissionEvent(account, event, crypto.randomUUID(), null);
    }
    requireWritableGameSession();
    // Legacy mission tracking remains best-effort during the claim window.
    return await fetch(`${API_BASE_URL}/api/missions/event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...getTimezoneHeaders() },
      credentials: 'include',
      body: JSON.stringify(event),
    })
      .then(async (res) => {
        if (!res.ok) {
          const text = await res.text().catch(() => '');
          throw new Error(`Failed to post mission event (status=${res.status}) ${text}`);
        }
        return await res.json();
      })
      .catch((err) => {
        console.warn('Mission event failed:', err);
        return null;
      });
  },
};

export const inventoryAPI = {
  hasPendingDolphinConsume(account: string): boolean {
    const storageKey = `sd:dolphin-consume-outbox:${account}`;
    try {
      const raw = localStorage.getItem(storageKey);
      if (!raw) return false;
      const attempt = JSON.parse(raw) as { account?: unknown; idempotencyKey?: unknown };
      if (attempt.account === account && typeof attempt.idempotencyKey === 'string'
          && MUTATION_UUID_RE.test(attempt.idempotencyKey)) return true;
      localStorage.removeItem(storageKey);
      return false;
    } catch {
      try { localStorage.removeItem(storageKey); } catch { /* unavailable storage */ }
      return false;
    }
  },

  async consumeDolphin(): Promise<{ ok: boolean; inventory: { dolphinSaved: number }; acknowledgement?: { account: string; idempotencyKey: string } } | null> {
    requireWritableGameSession('consume_dolphin');
    try {
      const account = activeAuthAccess?.canonical ? activeAuthAccess.userId : '';
      const storageKey = account ? `sd:dolphin-consume-outbox:${account}` : '';
      let stored = storageKey ? localStorage.getItem(storageKey) : null;
      let attempt: { account: string; idempotencyKey: string } | null = null;
      try { attempt = stored ? JSON.parse(stored) : null; } catch { /* discard corrupt local-only state */ }
      if (attempt?.account !== account || !MUTATION_UUID_RE.test(attempt?.idempotencyKey || '')) {
        if (storageKey) localStorage.removeItem(storageKey);
        stored = null;
        attempt = { account, idempotencyKey: crypto.randomUUID() };
      }
      if (storageKey && !stored) localStorage.setItem(storageKey, JSON.stringify(attempt));
      const res = await fetch(`${API_BASE_URL}/api/inventory/dolphin/consume`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": attempt.idempotencyKey },
        credentials: "include",
      });
      if (!res.ok) return null;
      const result = await res.json();
      if (typeof result?.ok !== 'boolean' || !Number.isSafeInteger(result?.inventory?.dolphinSaved)) return null;
      if (storageKey) localStorage.removeItem(storageKey);
      return { ...result, acknowledgement: account ? { account, idempotencyKey: attempt.idempotencyKey } : undefined };
    } catch {
      return null;
    }
  },

  async importDolphin(count: number): Promise<{ ok: boolean; inventory: { dolphinSaved: number }; acknowledgement?: { account: string; count: number; idempotencyKey: string } } | null> {
    requireWritableGameSession('import_dolphin');
    try {
      if (!activeAuthAccess?.canonical) {
        const res = await fetch(`${API_BASE_URL}/api/inventory/dolphin/import`, {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
          credentials: 'include', body: JSON.stringify({ count }),
        });
        if (!res.ok) return null;
        return await res.json();
      }
      const account = activeAuthAccess?.userId || '';
      if (!account || !Number.isSafeInteger(count) || count < 0) throw new Error('Invalid dolphin import snapshot');
      const storageKey = `sd:dolphin-import-outbox:${account}`;
      const stored = localStorage.getItem(storageKey);
      const attempt = stored ? JSON.parse(stored) as { account: string; count: number; idempotencyKey: string }
        : { account, count, idempotencyKey: crypto.randomUUID() };
      if (attempt.account !== account || !Number.isSafeInteger(attempt.count) || attempt.count < 0
          || !MUTATION_UUID_RE.test(attempt.idempotencyKey)) throw new Error('Invalid dolphin import outbox');
      if (!stored) localStorage.setItem(storageKey, JSON.stringify(attempt));
      const res = await fetch(`${API_BASE_URL}/api/inventory/dolphin/import`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": attempt.idempotencyKey },
        credentials: "include",
        body: JSON.stringify({ count: attempt.count }),
      });
      if (!res.ok) return null;
      const result = await res.json();
      if (result?.ok !== true || !Number.isSafeInteger(result?.inventory?.dolphinSaved)) return null;
      return { ...result, acknowledgement: { account, count: attempt.count, idempotencyKey: attempt.idempotencyKey } };
    } catch {
      return null;
    }
  },

  async purchaseSkin(skinId: string): Promise<{ ok: boolean; skinId: string; cost: number; coins: number; skins: SkinState } | { error: string } | null> {
    requireWritableGameSession('purchase_skin');
    try {
      const res = await fetch(`${API_BASE_URL}/api/inventory/skin/purchase`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
        credentials: "include",
        body: JSON.stringify({ skinId }),
      });
      return await res.json();
    } catch {
      return null;
    }
  },

  async equipSkin(skinId: string): Promise<{ ok: boolean; skins: SkinState } | null> {
    requireWritableGameSession('equip_skin');
    try {
      const res = await fetch(`${API_BASE_URL}/api/inventory/skin/equip`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
        credentials: "include",
        body: JSON.stringify({ skinId }),
      });
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    }
  },
};

export type AchievementEntry = {
  id: string;
  name: string;
  description: string;
  category: string;
  reward: { type: string; amount: number };
  unlocked: boolean;
  unlockedAt: number | null;
};

export type UserAchievementSummary = {
  count: number;
  achievements: { id: string; name: string; category: string }[];
};

export const achievementsAPI = {
  async getAll(): Promise<AchievementEntry[]> {
    try {
      const res = await fetch(`${API_BASE_URL}/api/achievements`, { credentials: 'include' });
      if (!res.ok) return [];
      const data = await res.json();
      return data.achievements || [];
    } catch {
      return [];
    }
  },

  async getByUsers(loginIds: string[]): Promise<Record<string, UserAchievementSummary>> {
    if (loginIds.length === 0) return {};
    try {
      const res = await fetch(
        `${API_BASE_URL}/api/achievements/users?loginIds=${encodeURIComponent(loginIds.join(','))}`,
      );
      if (!res.ok) return {};
      const data = await res.json();
      return data.users || {};
    } catch {
      return {};
    }
  },
};

// --- PVP API ---
export type PvpSettleBetRequest = {
  winnerUserId: string;
  loserUserId: string;
  bet: { coins: number; dolphins: number; tubePieces: number };
};

export type PvpSettleBetResponse = {
  ok: boolean;
  transferred: { coins: number; dolphins: number; tubePieces: number };
};

export const pvpAPI = {
  async settleBet(payload: PvpSettleBetRequest): Promise<PvpSettleBetResponse | null> {
    requireWritableGameSession();
    try {
      const res = await fetch(`${API_BASE_URL}/api/pvp/settle-bet`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(payload),
      });
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    }
  },
};

// --- Online PvP API ---
export const onlinePvpAPI = {
  async getWsTicket(): Promise<{ ticket: string; user: { userId: string; loginId: string }; expiresAt: number }> {
    requireWritableGameSession();
    const res = await fetch(`${API_BASE_URL}/api/pvp-online/ws-ticket`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
    });
    if (!res.ok) throw new Error(`WS ticket failed (${res.status})`);
    return res.json();
  },

  async bootstrap(): Promise<{
    user: { userId: string; loginId: string; refCode: string };
    inventory: { coins: number; dolphinSaved: number; tube: { pieces: number; charges: number }; skins: { owned: string[]; equipped: string } };
    inboxUnreadCount: number;
    activeRoomSummary: import('./pvp-online/onlinePvpTypes').OnlineRoom | null;
  }> {
    const res = await fetch(`${API_BASE_URL}/api/pvp-online/bootstrap`, { credentials: 'include' });
    if (!res.ok) throw new Error(`Bootstrap failed (${res.status})`);
    return res.json();
  },

  async getInbox(cursor?: string, limit?: number): Promise<{ items: unknown[]; nextCursor: string | null }> {
    const params = new URLSearchParams();
    if (cursor) params.set('cursor', cursor);
    if (limit) params.set('limit', String(limit));
    const qs = params.toString();
    const res = await fetch(`${API_BASE_URL}/api/pvp-online/inbox${qs ? '?' + qs : ''}`, { credentials: 'include' });
    if (!res.ok) throw new Error(`Inbox failed (${res.status})`);
    return res.json();
  },

  async markInboxRead(inboxId: string): Promise<{ ok: boolean }> {
    requireWritableGameSession();
    const res = await fetch(`${API_BASE_URL}/api/pvp-online/inbox/${inboxId}/read`, {
      method: 'POST',
      credentials: 'include',
    });
    if (!res.ok) throw new Error(`Mark read failed (${res.status})`);
    return res.json();
  },

  async markAllInboxRead(): Promise<{ ok: boolean }> {
    requireWritableGameSession();
    const res = await fetch(`${API_BASE_URL}/api/pvp-online/inbox/read-all`, {
      method: 'POST',
      credentials: 'include',
    });
    if (!res.ok) throw new Error(`Mark all read failed (${res.status})`);
    return res.json();
  },

  async getLobby(): Promise<{ users: { userId: string; loginId: string; status: string; enteredLobbyAt: number | null }[]; asOf: number }> {
    const res = await fetch(`${API_BASE_URL}/api/pvp-online/lobby`, { credentials: 'include' });
    if (!res.ok) throw new Error(`Lobby failed (${res.status})`);
    return res.json();
  },

  async getOpenRooms(): Promise<{ rooms: import('./pvp-online/onlinePvpTypes').OnlineRoom[]; asOf: number }> {
    const res = await fetch(`${API_BASE_URL}/api/pvp-online/lobby/rooms`, { credentials: 'include' });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Open rooms failed (${res.status}) ${text}`);
    }
    return res.json();
  },

  async enterLobby(): Promise<{ ok: boolean }> {
    requireWritableGameSession();
    const res = await fetch(`${API_BASE_URL}/api/pvp-online/lobby/enter`, {
      method: 'POST',
      credentials: 'include',
    });
    if (!res.ok) throw new Error(`Enter lobby failed (${res.status})`);
    return res.json();
  },

  async leaveLobby(): Promise<{ ok: boolean }> {
    requireWritableGameSession();
    const res = await fetch(`${API_BASE_URL}/api/pvp-online/lobby/leave`, {
      method: 'POST',
      credentials: 'include',
    });
    if (!res.ok) throw new Error(`Leave lobby failed (${res.status})`);
    return res.json();
  },

  async getRoom(roomId: string): Promise<{ room: unknown }> {
    const res = await fetch(`${API_BASE_URL}/api/pvp-online/rooms/${roomId}`, { credentials: 'include' });
    if (!res.ok) throw new Error(`Room failed (${res.status})`);
    return res.json();
  },

  async getMatch(matchId: string): Promise<{ match: unknown }> {
    const res = await fetch(`${API_BASE_URL}/api/pvp-online/matches/${matchId}`, { credentials: 'include' });
    if (!res.ok) throw new Error(`Match failed (${res.status})`);
    return res.json();
  },

  async sendMatchInput(matchId: string, seq: number, action: 'down' | 'up'): Promise<{ ok: boolean }> {
    requireWritableGameSession();
    const res = await fetch(`${API_BASE_URL}/api/pvp-online/matches/${matchId}/input`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ seq, action }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Match input failed (${res.status}) ${text}`);
    }
    return res.json();
  },

  async updateMatchState(matchId: string, payload: object): Promise<{ match: unknown }> {
    requireWritableGameSession();
    const res = await fetch(`${API_BASE_URL}/api/pvp-online/matches/${matchId}/state`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Match state update failed (${res.status}) ${text}`);
    }
    return res.json();
  },

  async createRoom(config: import('./pvp-online/onlinePvpTypes').RoomConfig, skinId: string): Promise<{ room: import('./pvp-online/onlinePvpTypes').OnlineRoom }> {
    requireWritableGameSession();
    const res = await fetch(`${API_BASE_URL}/api/pvp-online/rooms/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ config, skinId }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Create room failed (${res.status}) ${text}`);
    }
    return res.json();
  },

  async joinRoom(roomId: string, skinId: string): Promise<{ room: import('./pvp-online/onlinePvpTypes').OnlineRoom }> {
    requireWritableGameSession();
    const res = await fetch(`${API_BASE_URL}/api/pvp-online/rooms/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ roomId, skinId }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Join room failed (${res.status}) ${text}`);
    }
    return res.json();
  },

  async updateRoomConfig(roomId: string, roomVersion: number, config: object): Promise<{ room: import('./pvp-online/onlinePvpTypes').OnlineRoom }> {
    requireWritableGameSession();
    const res = await fetch(`${API_BASE_URL}/api/pvp-online/rooms/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ roomVersion, config }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Update room config failed (${res.status}) ${text}`);
    }
    return res.json();
  },

  async changeRoomSkin(roomId: string, roomVersion: number, skinId: string): Promise<{ room: import('./pvp-online/onlinePvpTypes').OnlineRoom }> {
    requireWritableGameSession();
    const res = await fetch(`${API_BASE_URL}/api/pvp-online/rooms/skin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ roomVersion, skinId }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Change skin failed (${res.status}) ${text}`);
    }
    return res.json();
  },

  async setReady(roomId: string, roomVersion: number, ready: boolean): Promise<{ room: import('./pvp-online/onlinePvpTypes').OnlineRoom }> {
    requireWritableGameSession();
    const res = await fetch(`${API_BASE_URL}/api/pvp-online/rooms/ready`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ roomVersion, ready }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Set ready failed (${res.status}) ${text}`);
    }
    return res.json();
  },

  async leaveRoom(roomId: string, roomVersion: number): Promise<{ ok: boolean }> {
    requireWritableGameSession();
    const res = await fetch(`${API_BASE_URL}/api/pvp-online/rooms/leave`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ roomVersion }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Leave room failed (${res.status}) ${text}`);
    }
    return res.json();
  },

  async cancelRoom(roomId: string, roomVersion: number): Promise<{ ok: boolean }> {
    requireWritableGameSession();
    const res = await fetch(`${API_BASE_URL}/api/pvp-online/rooms/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ roomVersion }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Cancel room failed (${res.status}) ${text}`);
    }
    return res.json();
  },

  async sendInvite(
    roomId: string,
    roomVersion: number,
    targetUserId?: string,
    targetLoginId?: string,
  ): Promise<{ invite: import('./pvp-online/onlinePvpTypes').PvpInvite }> {
    requireWritableGameSession();
    const res = await fetch(`${API_BASE_URL}/api/pvp-online/invites/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ roomVersion, targetUserId, targetLoginId }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Send invite failed (${res.status}) ${text}`);
    }
    return res.json();
  },

  async acceptInvite(inviteId: string): Promise<{ room: import('./pvp-online/onlinePvpTypes').OnlineRoom }> {
    requireWritableGameSession();
    const res = await fetch(`${API_BASE_URL}/api/pvp-online/invites/accept`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ inviteId }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Accept invite failed (${res.status}) ${text}`);
    }
    return res.json();
  },

  async declineInvite(inviteId: string): Promise<{ ok: boolean }> {
    requireWritableGameSession();
    const res = await fetch(`${API_BASE_URL}/api/pvp-online/invites/decline`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ inviteId }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Decline invite failed (${res.status}) ${text}`);
    }
    return res.json();
  },

  async getPendingInvites(): Promise<{ invites: import('./pvp-online/onlinePvpTypes').PvpInvite[] }> {
    const res = await fetch(`${API_BASE_URL}/api/pvp-online/invites/pending`, { credentials: 'include' });
    if (!res.ok) throw new Error(`Get pending invites failed (${res.status})`);
    return res.json();
  },
};
