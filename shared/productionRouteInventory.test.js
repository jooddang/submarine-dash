import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import {
  PRODUCTION_ROUTE_INVENTORY,
  ROUTE_CLASS,
  localRouteClassification,
  routeFileToPath,
} from './productionRouteInventory.js';

const root = join(import.meta.dirname, '..');

function productionFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === '_lib' ? [] : productionFiles(path);
    return entry.name.endsWith('.ts') ? [relative(root, path).replaceAll('\\', '/')] : [];
  });
}

describe('production route inventory', () => {
  it('contains every and only production Vercel function', () => {
    expect(PRODUCTION_ROUTE_INVENTORY.map(({ file }) => file).sort()).toEqual(productionFiles(join(root, 'api')).sort());
  });

  it('requires every production function to install the admission wrapper', () => {
    for (const { file } of PRODUCTION_ROUTE_INVENTORY) {
      const source = readFileSync(join(root, file), 'utf8');
      expect(source, file).toContain("import { withProductionControl }");
      if (file === 'api/inventory/skin/equip.ts') {
        expect(source, file).toContain(
          "return withProductionControl('api/inventory/skin/equip.ts', handler, dependencies, isSyntheticCanaryEquipRequest);",
        );
        expect(source.trimEnd().endsWith('export default createEquipSkinRoute();'), file).toBe(true);
      } else if (file === 'api/inventory/skin/purchase.ts') {
        expect(source, file).toContain(
          "return withProductionControl('api/inventory/skin/purchase.ts', handler, dependencies, isSyntheticCanaryPurchaseRequest);",
        );
        expect(source.trimEnd().endsWith('export default createPurchaseSkinRoute();'), file).toBe(true);
      } else if (file === 'api/inventory/dolphin/consume.ts') {
        expect(source, file).toContain(
          "withProductionControl('api/inventory/dolphin/consume.ts',handler,dependencies,isSyntheticCanaryDolphinConsumeRequest)",
        );
        expect(source.trimEnd().endsWith('export default createConsumeDolphinRoute();'), file).toBe(true);
      } else if (file === 'api/inventory/dolphin/import.ts') {
        expect(source, file).toContain(
          "withProductionControl('api/inventory/dolphin/import.ts',handler,dependencies,isSyntheticCanaryDolphinImportRequest)",
        );
        expect(source.trimEnd().endsWith('export default createImportDolphinRoute();'), file).toBe(true);
      } else if (file === 'api/missions/daily.ts') {
        expect(source, file).toContain(
          "withProductionControl('api/missions/daily.ts', handler, dependencies, isCanonicalDailyMissionsBoundary)",
        );
        expect(source.trimEnd().endsWith('export default createDailyMissionsRoute();'), file).toBe(true);
      } else if (file === 'api/missions/event.ts') {
        expect(source, file).toContain(
          "withProductionControl('api/missions/event.ts', handler, dependencies, isCanonicalMissionEventBoundary)",
        );
        expect(source.trimEnd().endsWith('export default createMissionEventRoute();'), file).toBe(true);
      } else {
        expect(source.trimEnd().endsWith(`export default withProductionControl('${file}', handler);`), file).toBe(true);
      }
      const transpiled = ts.transpileModule(source, {
        fileName: file,
        reportDiagnostics: true,
        compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
      });
      const syntaxErrors = (transpiled.diagnostics || []).filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error);
      expect(syntaxErrors.map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')), file).toEqual([]);
    }
  });

  it('gives every route method a valid classification and checked key family list', () => {
    const valid = new Set(Object.values(ROUTE_CLASS));
    for (const entry of PRODUCTION_ROUTE_INVENTORY) {
      expect(Object.keys(entry.methods).length, entry.file).toBeGreaterThan(0);
      for (const classification of Object.values(entry.methods)) expect(valid.has(classification), entry.file).toBe(true);
      expect(Array.isArray(entry.keyFamilies), entry.file).toBe(true);
    }
  });

  it('keeps local Express route/method classifications aligned with production', () => {
    const source = readFileSync(join(root, 'backend/src/server.js'), 'utf8');
    const localRoutes = [...source.matchAll(/app\.(get|post|delete|put|patch)\('([^']+)'/g)]
      .filter(([, , path]) => path.startsWith('/api/'))
      .map(([, method, path]) => `${method.toUpperCase()} ${path.replace(/:[^/]+/g, ':parameter')}`)
      .sort();
    const productionRoutes = PRODUCTION_ROUTE_INVENTORY.filter((entry) => entry.local).flatMap((entry) =>
      Object.keys(entry.methods).map((method) => `${method} ${routeFileToPath(entry.file)}`)
    ).sort();
    expect(localRoutes).toEqual(productionRoutes);
    for (const value of localRoutes) {
      const [method, path] = value.split(' ');
      expect(localRouteClassification(path, method), value).not.toBeNull();
    }
  });

  it('explicitly classifies all GET requests that can write durable state', () => {
    const sideEffects = PRODUCTION_ROUTE_INVENTORY
      .filter((entry) => entry.methods.GET === ROUTE_CLASS.GET_SIDE_EFFECT)
      .map((entry) => entry.file)
      .sort();
    expect(sideEffects).toEqual([
      'api/auth/me.ts',
      'api/leaderboard.ts',
      'api/leaderboard/weekly.ts',
      'api/missions/daily.ts',
      'api/pvp-online/bootstrap.ts',
      'api/pvp-online/invites/pending.ts',
      'api/pvp-online/lobby/rooms.ts',
      'api/pvp-online/rooms/list.ts',
    ]);
  });
});
