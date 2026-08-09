import { readFileSync } from 'node:fs';
import { describe,expect,it } from 'vitest';

const game=readFileSync(new URL('./Game.tsx',import.meta.url),'utf8');
const overlays=readFileSync(new URL('./components/UIOverlays.tsx',import.meta.url),'utf8');

describe('Roadcrosser login UI',()=>{
  it('uses one top-right Roadcrosser login entry and does not render the legacy login modal',()=>{
    expect(game).toContain('aria-label="Log in with Roadcrosser"');
    expect(game).toContain('ROADCROSSER LOGIN');
    expect(game).toContain('top: 14, right: 14');
    expect(game).toContain('authAPI.beginRoadcrosserConnect()');
    expect(game).not.toContain('<AuthModal');
    expect(game).not.toContain('authAPI.login(');
    expect(overlays).not.toContain('LEGACY LOGIN');
  });
});
