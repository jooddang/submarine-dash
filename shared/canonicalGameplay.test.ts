import { describe, expect, it, vi } from 'vitest';
import {
  canonicalGameplayRequest, executeExpressCanonicalGameplay, isCanonicalGameplayAdmission,
  validateCanonicalGameplayResponse,
} from './canonicalGameplay.js';

const key = '97000000-0000-4000-8000-000000000001';
const run = '97000000-0000-4000-8000-000000000002';
const event = { type:'run_end',score:1200,tubePieces:2,tubeCharges:1 };
const response = {version:'submarine-gameplay-settlement-v1',operation:'run_end',idempotent:false,date:'2026-08-09',
  acknowledgement:{externalUserId:'account-a'},
  progress:{runs:1,oxygenCollected:0,maxScore:1200,completedMissionIds:[],keptAt:null},rewards:null,coinsEarned:10,
  inventory:{coins:21,dolphinSaved:2,tube:{pieces:2,charges:1}},newAchievements:[],stateVersion:2};

describe('canonical gameplay contract', () => {
  it('admits only the exact enabled mutation boundary', () => {
    const base={method:'POST',path:'/api/missions/event',origin:'https://submarine-dash.roadcrosser.com',
      expectedOrigin:'https://submarine-dash.roadcrosser.com',canonicalToken:'token',enabled:true,allowedOrigin:true};
    expect(isCanonicalGameplayAdmission(base)).toBe(true);
    for (const patch of [{method:'GET'},{origin:'https://tiles.roadcrosser.com'},{canonicalToken:''},{enabled:false},{allowedOrigin:false}]) {
      expect(isCanonicalGameplayAdmission({...base,...patch})).toBe(false);
    }
  });

  it('normalizes exact Road payloads and validates acknowledgements', async () => {
    expect(canonicalGameplayRequest({canonicalToken:'token',expectedExternalUserId:'account-a',idempotencyKey:key,runEvidenceId:run,event})).toMatchObject({
      expectedExternalUserId:'account-a',idempotencyKey:key,runEvidenceId:run,eventType:'run_end',contractVersion:'submarine-gameplay-v1',
      payload:{score:1200,tubePieces:2,tubeCharges:1,deathCause:null,perfectPlatformer:false},
    });
    expect(validateCanonicalGameplayResponse(response,'run_end')).toBe(response);
    expect(()=>validateCanonicalGameplayResponse({...response,stateVersion:0},'run_end')).toThrow('invalid');
    expect(()=>validateCanonicalGameplayResponse({...response,acknowledgement:{}},'run_end')).toThrow('invalid');
    const road=vi.fn().mockResolvedValue(response);
    await expect(executeExpressCanonicalGameplay({canonicalToken:'token',expectedExternalUserId:'account-a',idempotencyKey:key,runEvidenceId:run,event,
      roadcrosserRequest:road})).resolves.toBe(response);
    expect(road).toHaveBeenCalledWith('/api/internal/submarine-dash/mutations/settle-gameplay',
      expect.objectContaining({sessionToken:'token',expectedExternalUserId:'account-a'}));
  });
});
