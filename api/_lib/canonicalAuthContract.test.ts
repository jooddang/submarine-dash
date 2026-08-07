import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import {
  clearCanonicalSessionCookie, getCanonicalSessionToken, setCanonicalSessionCookie, setRoadcrosserStateCookie,
  isAllowedSubmarineMutationOrigin,
} from './auth.js';

const root = join(import.meta.dirname, '../..');

function responseDouble() {
  const headers = new Map<string, string | string[]>();
  return {
    getHeader: (name: string) => headers.get(name),
    setHeader: (name: string, value: string | string[]) => { headers.set(name, value); },
    headers,
  } as unknown as VercelResponse & { headers: Map<string, string | string[]> };
}

describe('canonical Submarine auth contract', () => {
  it('keeps canonical, legacy, and state cookies host-only and non-interchangeable', () => {
    const response = responseDouble();
    setCanonicalSessionCookie(response, 'canonical-token');
    setRoadcrosserStateCookie(response, 'state-token');
    clearCanonicalSessionCookie(response);
    const cookies = response.headers.get('Set-Cookie') as string[];
    expect(cookies[0]).toContain('sd_roadcrosser_session=canonical-token');
    expect(cookies[0]).toContain('HttpOnly; SameSite=Lax; Secure');
    expect(cookies[1]).toContain('sd_rc_state=state-token');
    expect(cookies[1]).toContain('SameSite=None; Secure');
    expect(cookies.join(';')).not.toContain('Domain=');
    const request = { headers: { cookie: 'sd_session=legacy; sd_roadcrosser_session=canonical' } } as VercelRequest;
    expect(getCanonicalSessionToken(request)).toBe('canonical');
  });

  it('removes wildcard production CORS and keeps ticket/state out of URLs', () => {
    const vercel = JSON.parse(readFileSync(join(root, 'vercel.json'), 'utf8'));
    expect(vercel.headers).toBeUndefined();
    const start = readFileSync(join(root, 'api/auth/roadcrosser/start.ts'), 'utf8');
    const callback = readFileSync(join(root, 'api/auth/roadcrosser/callback.ts'), 'utf8');
    expect(start).toContain('stateChallenge=');
    expect(start).not.toContain('ticket=');
    expect(callback).toContain('req.headers.origin !== roadcrosserOrigin()');
    expect(callback.indexOf('const canonical = await consumeRoadcrosserTicket')).toBeLessThan(callback.indexOf('setCanonicalSessionCookie(res'));
    expect(callback).not.toContain('console.');
    for (const file of ['login.ts', 'logout.ts', 'me.ts', 'register.ts', 'change-password.ts']) {
      expect(readFileSync(join(root, 'api/auth', file), 'utf8')).not.toContain("Access-Control-Allow-Origin', '*'");
    }
  });

  it('binds local auth mutations to the exact request origin and mirrors the Express gate', () => {
    const same = {
      headers: { origin: 'http://localhost:3001', host: 'localhost:3001', 'x-forwarded-proto': 'http' },
    } as unknown as VercelRequest;
    const otherPort = {
      headers: { origin: 'http://localhost:3002', host: 'localhost:3001', 'x-forwarded-proto': 'http' },
    } as unknown as VercelRequest;
    expect(isAllowedSubmarineMutationOrigin(same)).toBe(true);
    expect(isAllowedSubmarineMutationOrigin(otherPort)).toBe(false);
    const server = readFileSync(join(root, 'backend/src/server.js'), 'utf8');
    expect(server.indexOf('credentialMutationRoute')).toBeLessThan(server.indexOf("app.post('/api/auth/login'"));
    expect(server).toContain('!isAllowedSubmarineMutationOrigin(req)');
    expect(server).toContain("process.env.SD_SUPABASE_WRITE_CANARY_ENABLED === 'true'");
    expect(server).toContain("'/api/internal/submarine-dash/mutations/equip-skin'");
    expect(server).toContain("'/api/internal/submarine-dash/mutations/purchase-skin'");
    expect(server).toContain("process.env.SD_SUPABASE_DOLPHIN_WRITE_CANARY_ENABLED === 'true'");
    expect(server).toContain('isExpressDolphinCanaryAdmission({');
    expect(server).toContain("executeExpressCanonicalDolphin({operation:'consume_dolphin'");
    expect(server).toContain("executeExpressCanonicalDolphin({operation:'import_dolphin'");
    expect(server).toContain('validateCanaryPurchaseResponse(result, skinId)');
    expect(server).toContain("result.rejected === 'insufficient_coins'");
  });
});
