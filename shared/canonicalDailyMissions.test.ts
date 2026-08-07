import { describe, expect, it, vi } from 'vitest';
import { executeExpressCanonicalDaily, isCanonicalDailyReadAdmission, validateCanonicalDailyMissions } from './canonicalDailyMissions.js';

const response = {
  version: 'submarine-daily-missions-v1', readOnly: true, date: '2026-08-06',
  missions: [{id:'runs_3',type:'play_runs',title:'Play 3 runs',target:3}],
  user: {
    progress: {runs:2,oxygenCollected:0,maxScore:100,completedMissionIds:[]}, streak:{current:1},
    inventory:{coins:10,dolphinSaved:2,dolphinPending:0,tube:{pieces:1,charges:0},skins:{owned:['default'],equipped:'default'}},
  },
};

describe('canonical daily missions contract', () => {
  it('accepts the strict read-only response', () => {
    expect(validateCanonicalDailyMissions(response)).toBe(response);
  });

  it('rejects malformed or unsafe economic values', () => {
    expect(() => validateCanonicalDailyMissions({...response,readOnly:false})).toThrow('invalid');
    expect(() => validateCanonicalDailyMissions({...response,user:{...response.user,inventory:{...response.user.inventory,coins:Number.MAX_SAFE_INTEGER+1}}})).toThrow('invalid');
    expect(() => validateCanonicalDailyMissions({...response,missions:[response.missions[0],response.missions[0]]})).toThrow('invalid');
    expect(() => validateCanonicalDailyMissions({...response,date:'2026-02-30'})).toThrow('invalid');
    expect(() => validateCanonicalDailyMissions({...response,user:{...response.user,streak:[]}})).toThrow('invalid');
  });

  it('requires the exact default-off GET admission tuple', () => {
    const allowed={method:'GET',origin:'https://submarine-dash.roadcrosser.com',expectedOrigin:'https://submarine-dash.roadcrosser.com',canonicalToken:'token',enabled:true,allowedOrigin:true};
    expect(isCanonicalDailyReadAdmission(allowed)).toBe(true);
    expect(isCanonicalDailyReadAdmission({...allowed,origin:undefined})).toBe(true);
    for (const patch of [{method:'POST'},{origin:'https://tiles.roadcrosser.com'},{canonicalToken:''},{enabled:false},{allowedOrigin:false}]) {
      expect(isCanonicalDailyReadAdmission({...allowed,...patch})).toBe(false);
    }
  });

  it('executes the Express path through the exact internal capability', async () => {
    const road = vi.fn().mockResolvedValue(response);
    await expect(executeExpressCanonicalDaily({canonicalToken:'token',roadcrosserRequest:road})).resolves.toBe(response);
    expect(road).toHaveBeenCalledWith('/api/internal/submarine-dash/daily-missions',{sessionToken:'token'});
  });
});
