import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  authAPI,
  inventoryAPI,
  leaderboardAPI,
  missionsAPI,
  onlinePvpAPI,
  pvpAPI,
} from './api';

afterEach(async () => {
  vi.unstubAllGlobals();
});

describe('canonical read-only client barrier', () => {
  it('rejects every game mutation helper without issuing a request', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      canonical: true,
      readOnly: true,
      user: { userId: 'road-user', loginId: 'road-user', refCode: '' },
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(authAPI.me()).resolves.toMatchObject({ canonical: true, readOnly: true });

    const mutations: Array<[string, () => Promise<unknown>]> = [
      ['leaderboard.submitScore', () => leaderboardAPI.submitScore('Diver', 12)],
      ['missions.getDaily', () => missionsAPI.getDaily()],
      ['missions.postEvent', () => missionsAPI.postEvent({ type: 'run_end', score: 12 })],
      ['inventory.consumeDolphin', () => inventoryAPI.consumeDolphin()],
      ['inventory.importDolphin', () => inventoryAPI.importDolphin(1)],
      ['inventory.purchaseSkin', () => inventoryAPI.purchaseSkin('classic')],
      ['inventory.equipSkin', () => inventoryAPI.equipSkin('classic')],
      ['pvp.settleBet', () => pvpAPI.settleBet({
        winnerUserId: 'one', loserUserId: 'two', bet: { coins: 1, dolphins: 0, tubePieces: 0 },
      })],
      ['online.getWsTicket', () => onlinePvpAPI.getWsTicket()],
      ['online.markInboxRead', () => onlinePvpAPI.markInboxRead('inbox')],
      ['online.markAllInboxRead', () => onlinePvpAPI.markAllInboxRead()],
      ['online.enterLobby', () => onlinePvpAPI.enterLobby()],
      ['online.leaveLobby', () => onlinePvpAPI.leaveLobby()],
      ['online.sendMatchInput', () => onlinePvpAPI.sendMatchInput('match', 1, 'down')],
      ['online.updateMatchState', () => onlinePvpAPI.updateMatchState('match', {})],
      ['online.createRoom', () => onlinePvpAPI.createRoom({} as never, 'classic')],
      ['online.joinRoom', () => onlinePvpAPI.joinRoom('room', 'classic')],
      ['online.updateRoomConfig', () => onlinePvpAPI.updateRoomConfig('room', 1, {})],
      ['online.changeRoomSkin', () => onlinePvpAPI.changeRoomSkin('room', 1, 'classic')],
      ['online.setReady', () => onlinePvpAPI.setReady('room', 1, true)],
      ['online.leaveRoom', () => onlinePvpAPI.leaveRoom('room', 1)],
      ['online.cancelRoom', () => onlinePvpAPI.cancelRoom('room', 1)],
      ['online.sendInvite', () => onlinePvpAPI.sendInvite('room', 1, 'target')],
      ['online.acceptInvite', () => onlinePvpAPI.acceptInvite('invite')],
      ['online.declineInvite', () => onlinePvpAPI.declineInvite('invite')],
    ];

    for (const [name, mutate] of mutations) {
      await expect(mutate(), name).rejects.toThrow('read-only');
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ user: null }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    await authAPI.me();
  });

  it('allows only the advertised synthetic canary capability and sends an idempotency key', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        canonical: true, readOnly: false, writeCapabilities: ['equip_skin'],
        user: { userId: 'synthetic-canary', loginId: 'Synthetic', refCode: '' },
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: true, skins: { owned: ['default'], equipped: 'default' },
      }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(authAPI.me()).resolves.toMatchObject({ canonical: true, readOnly: false });
    await expect(inventoryAPI.equipSkin('default')).resolves.toMatchObject({ ok: true });
    const equipRequest = fetchMock.mock.calls[1][1] as RequestInit;
    expect((equipRequest.headers as Record<string, string>)['Idempotency-Key']).toMatch(/^[0-9a-f-]{36}$/);
    await expect(inventoryAPI.purchaseSkin('classic')).rejects.toThrow('read-only');
    await expect(missionsAPI.postEvent({ type: 'run_end', score: 1 })).rejects.toThrow('read-only');
    await expect(leaderboardAPI.submitScore('Synthetic', 1)).rejects.toThrow('read-only');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
