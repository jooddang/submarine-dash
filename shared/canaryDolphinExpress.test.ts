import {describe,expect,it,vi} from 'vitest';
import {DOLPHIN_CONTRACT_VERSION} from './canaryDolphin.js';
import {executeExpressCanonicalDolphin,isExpressDolphinCanaryAdmission} from './canaryDolphinExpress.js';

const admission={method:'POST',path:'/api/inventory/dolphin/consume',origin:'https://submarine-dash.roadcrosser.com',
  expectedOrigin:'https://submarine-dash.roadcrosser.com',canonicalToken:'token',enabled:true,allowedOrigin:true};
const result={version:'submarine-write-v1',contractVersion:DOLPHIN_CONTRACT_VERSION,operation:'consume_dolphin',idempotent:false,
  ok:true,inventory:{dolphinSaved:1},stateVersion:2,keyVersions:{pending:1,saved:1,ledger:1}};

describe('executable Express dolphin adapter',()=>{
  it('admits only exact route, origin, canonical token, and separate flag',()=>{
    expect(isExpressDolphinCanaryAdmission(admission)).toBe(true);
    for(const patch of [{enabled:false},{origin:'https://tiles.roadcrosser.com'},{canonicalToken:''},{path:'/api/inventory/skin/equip'},{method:'GET'}]) {
      expect(isExpressDolphinCanaryAdmission({...admission,...patch})).toBe(false);
    }
  });
  it('executes strict canonical requests without any Redis dependency',async()=>{
    const road=vi.fn().mockResolvedValue(result);
    const out=await executeExpressCanonicalDolphin({operation:'consume_dolphin',canonicalToken:'token',
      idempotencyKey:'97000000-0000-4000-8000-000000000011',roadcrosserRequest:road});
    expect(out).toMatchObject({status:200,body:{ok:true,inventory:{dolphinSaved:1}}});
    expect(road).toHaveBeenCalledWith('/api/internal/submarine-dash/mutations/consume-dolphin',expect.objectContaining({contractVersion:DOLPHIN_CONTRACT_VERSION}));
    expect(Object.keys(out)).not.toContain('redis');
  });
  it('rejects malformed import input before Road and rejects malformed Road output',async()=>{
    const road=vi.fn();
    for(const count of ['2',-1,1.5,Number.MAX_SAFE_INTEGER+1]) {
      await expect(executeExpressCanonicalDolphin({operation:'import_dolphin',canonicalToken:'token',count,
        idempotencyKey:'97000000-0000-4000-8000-000000000012',roadcrosserRequest:road})).resolves.toMatchObject({status:400});
    }
    expect(road).not.toHaveBeenCalled();
    road.mockResolvedValue({...result,operation:'import_dolphin',ok:false});
    await expect(executeExpressCanonicalDolphin({operation:'import_dolphin',canonicalToken:'token',count:2,
      idempotencyKey:'97000000-0000-4000-8000-000000000012',roadcrosserRequest:road})).rejects.toThrow('invalid');
  });
});
