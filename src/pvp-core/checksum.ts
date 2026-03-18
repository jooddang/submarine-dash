// Deterministic checksum for authoritative state verification.
// Uses FNV-1a hash on gameplay-relevant fields only.
// Excludes cosmetic state (trail particles, score popups, background entities).

import type { PvpPlayerState } from "../pvp/pvpTypes";

// FNV-1a 32-bit hash
function fnv1a(data: number[]): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < data.length; i++) {
    hash ^= data[i] & 0xff;
    hash = Math.imul(hash, 0x01000193);
    hash ^= (data[i] >>> 8) & 0xff;
    hash = Math.imul(hash, 0x01000193);
    hash ^= (data[i] >>> 16) & 0xff;
    hash = Math.imul(hash, 0x01000193);
    hash ^= (data[i] >>> 24) & 0xff;
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function floatToInt(f: number): number {
  return Math.round(f * 1000);
}

export function computeChecksum(s: PvpPlayerState): number {
  const data = [
    floatToInt(s.player.x),
    floatToInt(s.player.y),
    floatToInt(s.player.dy),
    s.player.grounded ? 1 : 0,
    s.player.isTrapped ? 1 : 0,
    s.alive ? 1 : 0,
    floatToInt(s.oxygen),
    floatToInt(s.speed),
    floatToInt(s.distance),
    s.score,
    floatToInt(s.swordfishTimer),
    s.isSwordfishActive ? 1 : 0,
    s.turtleShellSaved ? 1 : 0,
    s.turtleShellUseCount,
    s.tubePieces,
    s.tubeRescueCharges,
    s.dolphinCount,
    s.dolphinUsesThisRun,
    s.rescue.active ? 1 : 0,
    s.tubeRescue.active ? 1 : 0,
    s.scoreAttackBonus,
    s.platforms.length,
    s.items.length,
  ];
  return fnv1a(data);
}
