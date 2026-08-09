import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  authAPI,
  dolphinMutationAccessState,
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
  it('rebinds pending-consume access per account instead of leaking A state into B', () => {
    const a={userId:'a',loginId:'A',refCode:'',canonical:true,readOnly:false} as const;
    const b={...a,userId:'b',loginId:'B'};
    expect(dolphinMutationAccessState(a,true)).toEqual({pending:true,enabled:false});
    expect(dolphinMutationAccessState(null,false)).toEqual({pending:false,enabled:true});
    expect(dolphinMutationAccessState(b,false)).toEqual({pending:false,enabled:true});
  });
  it('never auto-imports or clears local dolphin buckets during canonical hydration', () => {
    const game=readFileSync(new URL('./Game.tsx',import.meta.url),'utf8');
    expect(game).toContain('if (me?.userId && !me.canonical && !isReadOnlyCanary(me))');
    expect(game.indexOf('if (imported?.inventory && typeof imported.inventory.dolphinSaved === "number")'))
      .toBeLessThan(game.indexOf('clearLegacyLocalDolphinCount(me.userId)'));
    expect(game).toContain('bindDolphinMutationAccess(null);');
    expect(game).toContain('bindDolphinMutationAccess(me);');
    expect(game).toContain("authUserRef.current?.userId !== out.acknowledgement.account");
  });
  it('rejects every game mutation helper without issuing a request', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      canonical: true, readCapabilities: ['read_daily_missions'],
      readOnly: true,
      user: { userId: 'road-user', loginId: 'road-user', refCode: '' },
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(authAPI.me()).resolves.toMatchObject({ canonical: true, readOnly: true });

    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      date:'2026-08-06',missions:[],user:{progress:{runs:0,oxygenCollected:0,maxScore:0,completedMissionIds:[]},streak:{},inventory:{dolphinSaved:2,coins:1}},
    }), { status:200,headers:{'content-type':'application/json'} }));
    await expect(missionsAPI.getDaily()).resolves.toMatchObject({date:'2026-08-06'});

    const mutations: Array<[string, () => Promise<unknown>]> = [
      ['leaderboard.submitScore', () => leaderboardAPI.submitScore('Diver', 12)],
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
    expect(fetchMock).toHaveBeenCalledTimes(2);

    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ user: null }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    await authAPI.me();
  });

  it('allows only the advertised synthetic canary capability and sends an idempotency key', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        canonical: true, readOnly: false, writeCapabilities: ['equip_skin', 'purchase_skin'],
        user: { userId: 'synthetic-canary', loginId: 'Synthetic', refCode: '' },
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: true, skins: { owned: ['default'], equipped: 'default' },
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: true, skinId: 'gold', cost: 150, coins: 850,
        skins: { owned: ['default', 'gold'], equipped: 'default' },
      }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(authAPI.me()).resolves.toMatchObject({ canonical: true, readOnly: false });
    await expect(inventoryAPI.equipSkin('default')).resolves.toMatchObject({ ok: true });
    const equipRequest = fetchMock.mock.calls[1][1] as RequestInit;
    expect((equipRequest.headers as Record<string, string>)['Idempotency-Key']).toMatch(/^[0-9a-f-]{36}$/);
    await expect(inventoryAPI.purchaseSkin('gold')).resolves.toMatchObject({ ok: true, coins: 850 });
    const purchaseRequest = fetchMock.mock.calls[2][1] as RequestInit;
    expect((purchaseRequest.headers as Record<string, string>)['Idempotency-Key']).toMatch(/^[0-9a-f-]{36}$/);
    await expect(missionsAPI.postEvent({ type: 'run_end', score: 1 })).rejects.toThrow('read-only');
    await expect(leaderboardAPI.submitScore('Synthetic', 1)).rejects.toThrow('read-only');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('reuses one account-bound consume key after an unknown outcome', async () => {
    const values = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        canonical: true, readOnly: false, writeCapabilities: ['consume_dolphin'],
        user: { userId: 'canary-a', loginId: 'A', refCode: '' },
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
      .mockRejectedValueOnce(new Error('connection lost after write'))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, inventory: { dolphinSaved: 1 } }), {
        status: 200, headers: { 'content-type': 'application/json' },
      }));
    vi.stubGlobal('fetch', fetchMock);
    await authAPI.me();
    values.set('sd:dolphin-consume-outbox:canary-a', JSON.stringify({
      account: 'canary-a', idempotencyKey: '------------------------------------',
    }));
    expect(inventoryAPI.hasPendingDolphinConsume('canary-a')).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(values.has('sd:dolphin-consume-outbox:canary-a')).toBe(false);
    await expect(inventoryAPI.consumeDolphin()).resolves.toBeNull();
    expect(inventoryAPI.hasPendingDolphinConsume('canary-a')).toBe(true);
    await expect(inventoryAPI.consumeDolphin()).resolves.toMatchObject({ ok: true });
    const first = (fetchMock.mock.calls[1][1]?.headers as Record<string, string>)['Idempotency-Key'];
    const retry = (fetchMock.mock.calls[2][1]?.headers as Record<string, string>)['Idempotency-Key'];
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(first).not.toBe('------------------------------------');
    expect(retry).toBe(first);
    expect(inventoryAPI.hasPendingDolphinConsume('canary-a')).toBe(false);
  });

  it('keeps canonical import attempts account-bound and never consumes a guest bucket', async () => {
    const values = new Map<string, string>([['subdash:savedItem:dolphin:guest', '9']]);
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        canonical: true, readOnly: false, writeCapabilities: ['import_dolphin'],
        user: { userId: 'canary-a', loginId: 'A', refCode: '' },
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, inventory: { dolphinSaved: 3 } }), {
        status: 200, headers: { 'content-type': 'application/json' },
      }));
    vi.stubGlobal('fetch', fetchMock);
    await authAPI.me();
    await expect(inventoryAPI.importDolphin(3)).resolves.toMatchObject({
      acknowledgement: { account: 'canary-a', count: 3 },
    });
    expect(values.get('subdash:savedItem:dolphin:guest')).toBe('9');
    expect(values.has('sd:dolphin-import-outbox:canary-a')).toBe(true);
    expect(JSON.parse(fetchMock.mock.calls[1][1]?.body as string)).toEqual({ count: 3 });
  });

  it('isolates unknown consume attempts across an in-page account switch', async () => {
    const values=new Map<string,string>();
    vi.stubGlobal('localStorage',{
      getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>values.set(key,value),removeItem:(key:string)=>values.delete(key),
    });
    const me=(id:string)=>new Response(JSON.stringify({canonical:true,readOnly:false,writeCapabilities:['consume_dolphin'],
      user:{userId:id,loginId:id,refCode:''}}),{status:200,headers:{'content-type':'application/json'}});
    const confirmed=(saved:number)=>new Response(JSON.stringify({ok:true,inventory:{dolphinSaved:saved}}),{status:200,headers:{'content-type':'application/json'}});
    const fetchMock=vi.fn()
      .mockResolvedValueOnce(me('account-a')).mockRejectedValueOnce(new Error('unknown A outcome'))
      .mockResolvedValueOnce(me('account-b')).mockResolvedValueOnce(confirmed(7))
      .mockResolvedValueOnce(me('account-a')).mockResolvedValueOnce(confirmed(2));
    vi.stubGlobal('fetch',fetchMock);
    await authAPI.me(); await inventoryAPI.consumeDolphin();
    const aKey=(fetchMock.mock.calls[1][1]?.headers as Record<string,string>)['Idempotency-Key'];
    expect(inventoryAPI.hasPendingDolphinConsume('account-a')).toBe(true);
    await authAPI.me();
    expect(inventoryAPI.hasPendingDolphinConsume('account-b')).toBe(false);
    const b=await inventoryAPI.consumeDolphin();
    const bKey=(fetchMock.mock.calls[3][1]?.headers as Record<string,string>)['Idempotency-Key'];
    expect(b?.acknowledgement?.account).toBe('account-b'); expect(bKey).not.toBe(aKey);
    await authAPI.me();
    const replay=await inventoryAPI.consumeDolphin();
    const replayKey=(fetchMock.mock.calls[5][1]?.headers as Record<string,string>)['Idempotency-Key'];
    expect(replay?.acknowledgement?.account).toBe('account-a'); expect(replayKey).toBe(aKey);
  });

  it('queues every canonical run before I/O and flushes only its owning account in order', async () => {
    const values=new Map<string,string>();
    vi.stubGlobal('localStorage',{
      getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>values.set(key,value),removeItem:(key:string)=>values.delete(key),
    });
    const me=(id:string)=>new Response(JSON.stringify({canonical:true,readOnly:false,writeCapabilities:['settle_run_end'],
      user:{userId:id,loginId:id,refCode:''}}),{status:200,headers:{'content-type':'application/json'}});
    const settled=(score:number)=>new Response(JSON.stringify({version:'submarine-gameplay-settlement-v1',operation:'run_end',idempotent:false,
      date:'2026-08-09',progress:{runs:1,oxygenCollected:0,maxScore:score,completedMissionIds:[],keptAt:null},rewards:null,
      coinsEarned:10,inventory:{coins:10,dolphinSaved:0,tube:{pieces:0,charges:0}},newAchievements:[],stateVersion:2}),
      {status:200,headers:{'content-type':'application/json'}});
    const fetchMock=vi.fn().mockResolvedValueOnce(me('account-a'))
      .mockRejectedValueOnce(new Error('offline first run')).mockRejectedValueOnce(new Error('still offline'))
      .mockResolvedValueOnce(me('account-b')).mockResolvedValueOnce(me('account-a'))
      .mockResolvedValueOnce(settled(1000)).mockResolvedValueOnce(settled(2000));
    vi.stubGlobal('fetch',fetchMock);
    await authAPI.me();
    await expect(missionsAPI.postEvent({type:'run_end',score:1000,tubePieces:0,tubeCharges:0})).rejects.toThrow('offline');
    await expect(missionsAPI.postEvent({type:'run_end',score:2000,tubePieces:0,tubeCharges:0})).rejects.toThrow('offline');
    const queued=JSON.parse(values.get('sd:gameplay-run-outbox:account-a') || '[]');
    expect(queued).toHaveLength(2);
    expect(queued.map((item:{event:{score:number}})=>item.event.score)).toEqual([1000,2000]);
    const originalIds=queued.map((item:{idempotencyKey:string,runEvidenceId:string})=>[item.idempotencyKey,item.runEvidenceId]);
    await authAPI.me();
    expect(values.has('sd:gameplay-run-outbox:account-a')).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    await authAPI.me();
    await vi.waitFor(()=>expect(values.has('sd:gameplay-run-outbox:account-a')).toBe(false));
    const flushed=fetchMock.mock.calls.slice(5,7).map((call)=>{
      const headers=call[1]?.headers as Record<string,string>;
      return [headers['Idempotency-Key'],headers['Run-Evidence-Id']];
    });
    expect(flushed).toEqual(originalIds);
    expect(values.has('sd:gameplay-run-outbox:account-b')).toBe(false);
  });

  it('cancels an A flusher when auth switches to B during the first settlement response', async () => {
    const values=new Map<string,string>();
    vi.stubGlobal('localStorage',{
      getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>values.set(key,value),removeItem:(key:string)=>values.delete(key),
    });
    const me=(id:string)=>new Response(JSON.stringify({canonical:true,readOnly:false,writeCapabilities:['settle_run_end'],
      user:{userId:id,loginId:id,refCode:''}}),{status:200,headers:{'content-type':'application/json'}});
    const settled=(score:number)=>new Response(JSON.stringify({version:'submarine-gameplay-settlement-v1',operation:'run_end',idempotent:false,
      date:'2026-08-09',progress:{runs:1,oxygenCollected:0,maxScore:score,completedMissionIds:[],keptAt:null},rewards:null,
      coinsEarned:10,inventory:{coins:10,dolphinSaved:0,tube:{pieces:0,charges:0}},newAchievements:[],stateVersion:2}),
      {status:200,headers:{'content-type':'application/json'}});
    let resolveFirst!: (response:Response)=>void;
    const firstSettlement=new Promise<Response>((resolve)=>{ resolveFirst=resolve; });
    const meResponses=[me('account-a-switch'),me('account-a-switch'),me('account-b-switch')];
    const gameplayBodies:number[]=[];
    const fetchMock=vi.fn((url:string,init?:RequestInit)=>{
      if (url.endsWith('/api/auth/me')) return Promise.resolve(meResponses.shift()!);
      gameplayBodies.push(JSON.parse(String(init?.body)).score);
      if (gameplayBodies.length > 1) throw new Error('A second run must not send after the account switch');
      return firstSettlement;
    });
    vi.stubGlobal('fetch',fetchMock);
    await authAPI.me();
    const ids=['11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222'];
    values.set('sd:gameplay-run-outbox:account-a-switch',JSON.stringify(ids.map((id,index)=>({
      account:'account-a-switch',idempotencyKey:id,runEvidenceId:id,event:{type:'run_end',score:(index+1)*100,tubePieces:0,tubeCharges:0},
    }))));
    const staleA=authAPI.me();
    await vi.waitFor(()=>expect(gameplayBodies).toEqual([100]));
    await expect(authAPI.me()).resolves.toMatchObject({userId:'account-b-switch'});
    resolveFirst(settled(100));
    await staleA;
    expect(gameplayBodies).toEqual([100]);
    const retained=JSON.parse(values.get('sd:gameplay-run-outbox:account-a-switch') || '[]');
    expect(retained.map((item:{event:{score:number}})=>item.event.score)).toEqual([100,200]);
    expect(values.has('sd:gameplay-run-outbox:account-b-switch')).toBe(false);
  });

  it('preserves queues larger than the former fixed cap', async () => {
    const values=new Map<string,string>();
    vi.stubGlobal('localStorage',{
      getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>values.set(key,value),removeItem:(key:string)=>values.delete(key),
    });
    const fetchMock=vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({canonical:true,readOnly:false,writeCapabilities:['settle_run_end'],
        user:{userId:'large-queue',loginId:'large',refCode:''}}),{status:200,headers:{'content-type':'application/json'}}))
      .mockRejectedValueOnce(new Error('offline'));
    vi.stubGlobal('fetch',fetchMock);
    await authAPI.me();
    const existing=Array.from({length:20},(_,index)=>({account:'large-queue',idempotencyKey:crypto.randomUUID(),
      runEvidenceId:crypto.randomUUID(),event:{type:'run_end',score:index,tubePieces:0,tubeCharges:0}}));
    values.set('sd:gameplay-run-outbox:large-queue',JSON.stringify(existing));
    await expect(missionsAPI.postEvent({type:'run_end',score:999,tubePieces:0,tubeCharges:0})).rejects.toThrow('offline');
    const preserved=JSON.parse(values.get('sd:gameplay-run-outbox:large-queue') || '[]');
    expect(preserved).toHaveLength(21);
    expect(preserved.at(-1).event.score).toBe(999);
  });

  it('retains an unpersisted run in memory and exposes a blocking retry state', async () => {
    const values=new Map<string,string>();
    let storageAvailable=false;
    vi.stubGlobal('localStorage',{
      getItem:(key:string)=>values.get(key)??null,
      setItem:(key:string,value:string)=>{ if (!storageAvailable) throw new Error('quota exceeded'); values.set(key,value); },
      removeItem:(key:string)=>values.delete(key),
    });
    const fetchMock=vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({canonical:true,readOnly:false,
      writeCapabilities:['settle_run_end'],user:{userId:'storage-failure',loginId:'storage',refCode:''}}),
      {status:200,headers:{'content-type':'application/json'}}));
    vi.stubGlobal('fetch',fetchMock);
    await authAPI.me();
    await expect(missionsAPI.postEvent({type:'run_end',score:321,tubePieces:0,tubeCharges:0}))
      .rejects.toMatchObject({code:'RUN_OUTBOX_PERSISTENCE_FAILED'});
    expect(missionsAPI.hasRunSavePersistenceFailure('storage-failure')).toBe(true);
    await expect(missionsAPI.postEvent({type:'run_end',score:654,tubePieces:0,tubeCharges:0}))
      .rejects.toMatchObject({code:'RUN_OUTBOX_PERSISTENCE_FAILED'});
    expect(fetchMock).toHaveBeenCalledTimes(1);
    storageAvailable=true;
    missionsAPI.retryRunOutboxPersistence('storage-failure');
    expect(missionsAPI.hasRunSavePersistenceFailure('storage-failure')).toBe(false);
    const queue=JSON.parse(values.get('sd:gameplay-run-outbox:storage-failure') || '[]');
    expect(queue).toHaveLength(1);
    expect(queue[0].event.score).toBe(321);
  });

  it('shows and enforces the run-save persistence blocker in Game', () => {
    const game=readFileSync(new URL('./Game.tsx',import.meta.url),'utf8');
    expect(game).toContain('RUN SAVE PAUSED');
    expect(game).toContain('if (runSaveBlockedRef.current)');
    expect(game).toContain('missionsAPI.retryRunOutboxPersistence(account)');
    expect(game).toContain('if (isRunOutboxPersistenceError(error))');
  });
});
