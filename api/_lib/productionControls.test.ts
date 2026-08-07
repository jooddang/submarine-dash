import { describe, expect, it, vi } from 'vitest';
import { MaintenanceFreezeError } from '../../shared/productionControls.js';
import { PRODUCTION_ROUTE_INVENTORY, requiresDurableAdmission } from '../../shared/productionRouteInventory.js';
import { withProductionControl } from './productionControls.js';

function responseDouble() {
  return {
    statusCode: 200,
    body: undefined as unknown,
    headers: new Map<string, string>(),
    setHeader(name: string, value: string) { this.headers.set(name, value); return this; },
    status(code: number) { this.statusCode = code; return this; },
    json(body: unknown) { this.body = body; return body; },
  };
}

describe('production route wrapper runtime contract', () => {
  for (const entry of PRODUCTION_ROUTE_INVENTORY) {
    for (const [method, classification] of Object.entries(entry.methods)) {
      const contract = `${method} ${entry.file}`;

      it(`${contract} preserves behavior when controls are off`, async () => {
        const handler = vi.fn(async () => ({ unchanged: contract }));
        const acquire = vi.fn();
        const wrapped = withProductionControl(entry.file, handler, {
          flags: () => ({ admissionGate: false }) as ReturnType<any>,
          acquire,
        });
        const response = responseDouble();
        await expect(wrapped({ method } as any, response as any)).resolves.toEqual({ unchanged: contract });
        expect(handler).toHaveBeenCalledOnce();
        expect(acquire).not.toHaveBeenCalled();
      });

      it(`${contract} obeys its closed-gate classification`, async () => {
        const handler = vi.fn(async () => ({ bypassed: contract }));
        const acquire = vi.fn(async () => { throw new MaintenanceFreezeError(); });
        const wrapped = withProductionControl(entry.file, handler, {
          flags: () => ({ admissionGate: true }) as ReturnType<any>,
          adapter: () => ({}) as any,
          acquire,
          event: vi.fn(),
        });
        const response = responseDouble();
        const result = await wrapped({ method } as any, response as any);

        if (requiresDurableAdmission(classification)) {
          expect(acquire, contract).toHaveBeenCalledOnce();
          expect(handler, contract).not.toHaveBeenCalled();
          expect(response.statusCode, contract).toBe(503);
          expect(response.body, contract).toMatchObject({ error: 'MAINTENANCE_WRITE_FREEZE', retryable: true });
        } else {
          expect(acquire, contract).not.toHaveBeenCalled();
          expect(handler, contract).toHaveBeenCalledOnce();
          expect(result, contract).toEqual({ bypassed: contract });
        }
      });
    }
  }

  it('waits for an in-flight renewal before releasing a completed request lease', async () => {
    vi.useFakeTimers();
    let finishRenewal!: (value: boolean) => void;
    let finishHandler!: (value: string) => void;
    const renew = vi.fn(() => new Promise<boolean>((resolve) => { finishRenewal = resolve; }));
    const release = vi.fn(async (lease) => { lease.valid = false; return 1; });
    const lease = { requestId: 'race', ttlMs: 30_000, valid: true } as any;
    const handler = vi.fn(() => new Promise<string>((resolve) => { finishHandler = resolve; }));
    const wrapped = withProductionControl('api/auth/register.ts', handler, {
      flags: () => ({ admissionGate: true }) as ReturnType<any>,
      adapter: () => ({}) as any,
      acquire: vi.fn(async () => lease),
      renew: renew as any,
      release: release as any,
      run: ((_lease: any, operation: () => unknown) => operation()) as any,
      event: vi.fn(),
    });

    try {
      const result = wrapped({ method: 'POST' } as any, responseDouble() as any);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(renew).toHaveBeenCalledOnce();
      finishHandler('done');
      await Promise.resolve();
      expect(release).not.toHaveBeenCalled();
      finishRenewal(true);
      await expect(result).resolves.toBe('done');
      expect(release).toHaveBeenCalledOnce();
      expect(lease.valid).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('bypasses a closed Redis gate only when the caller-specific predicate approves', async () => {
    const handler = vi.fn(async () => ({ canonical: true }));
    const acquire = vi.fn(async () => { throw new MaintenanceFreezeError(); });
    const bypass = vi.fn((request: any) => request.syntheticCanary === true);
    const wrapped = withProductionControl('api/inventory/skin/equip.ts', handler, {
      flags: () => ({ admissionGate: true }) as ReturnType<any>,
      adapter: () => ({}) as any, acquire, event: vi.fn(),
    }, bypass);
    await expect(wrapped({ method: 'POST', syntheticCanary: true } as any, responseDouble() as any))
      .resolves.toEqual({ canonical: true });
    expect(acquire).not.toHaveBeenCalled();
    const legacyResponse = responseDouble();
    await wrapped({ method: 'POST', syntheticCanary: false } as any, legacyResponse as any);
    expect(acquire).toHaveBeenCalledOnce();
    expect(legacyResponse.statusCode).toBe(503);
  });
});
