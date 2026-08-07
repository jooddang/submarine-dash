import { DOLPHIN_CONTRACT_VERSION, validateCanaryDolphinResponse } from './canaryDolphin.js';

const UUID_RE=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PATHS=new Set(['/api/inventory/dolphin/consume','/api/inventory/dolphin/import']);

export function isExpressDolphinCanaryAdmission({method,path,origin,expectedOrigin,canonicalToken,enabled,allowedOrigin}) {
  return method==='POST' && PATHS.has(path) && Boolean(canonicalToken) && enabled===true
    && origin===expectedOrigin && allowedOrigin===true;
}

export async function executeExpressCanonicalDolphin({operation,canonicalToken,idempotencyKey,count,roadcrosserRequest}) {
  if (!UUID_RE.test(idempotencyKey || '')) return {status:400,body:{error:'Valid Idempotency-Key required'}};
  if (operation==='import_dolphin' && (typeof count!=='number' || !Number.isSafeInteger(count) || count<0)) {
    return {status:400,body:{error:'Safe count required'}};
  }
  const consume=operation==='consume_dolphin';
  const path=consume?'/api/internal/submarine-dash/mutations/consume-dolphin':'/api/internal/submarine-dash/mutations/import-dolphin';
  const request={sessionToken:canonicalToken,idempotencyKey,contractVersion:DOLPHIN_CONTRACT_VERSION,
    ...(consume?{}:{count})};
  const out=await roadcrosserRequest(path,request);
  validateCanaryDolphinResponse(out,operation);
  return {status:200,body:{ok:out.ok,inventory:out.inventory,stateVersion:out.stateVersion,idempotent:out.idempotent}};
}
