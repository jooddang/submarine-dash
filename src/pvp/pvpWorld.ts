// Re-export from deterministic core for backwards compatibility.
// Local PvP imports these; the core lives in pvp-core/ for sharing with authority.

export { createSeededRNG } from '../pvp-core/rng';
export type { SeededRNG } from '../pvp-core/rng';
export {
  generateInitialPlatforms,
  generateNextSegment,
  createBubbleSeeded,
  spawnBackgroundEntitySeeded,
} from '../pvp-core/world';
