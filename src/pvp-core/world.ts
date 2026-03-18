// Deterministic world generation — no browser APIs, no side effects.
// Moved from src/pvp/pvpWorld.ts

import type { Platform, Item, Bubble, BackgroundEntity, BackgroundEntityType } from "../types";
import type { SeededRNG } from "./rng";
import * as Constants from "../constants";

// Entity ID counter for deterministic IDs (no Date.now())
let entityIdCounter = 0;
export function resetEntityIdCounter(start = 0) {
  entityIdCounter = start;
}

export function createBubbleSeeded(rng: SeededRNG, w: number, h: number, randomY = true): Bubble {
  return {
    x: rng() * w,
    y: randomY ? rng() * h : h + 20,
    size: rng() * 5 + 2,
    speed: rng() * 1 + 0.5,
    opacity: rng() * 0.5 + 0.1,
    wobbleOffset: rng() * Math.PI * 2,
  };
}

export function spawnBackgroundEntitySeeded(
  rng: SeededRNG,
  width: number,
  height: number,
  entities: BackgroundEntity[]
): void {
  const types: BackgroundEntityType[] = ["FISH", "FISH", "FISH", "WHALE", "JELLYFISH", "DIVER", "CORAL", "SHIP"];
  const type = types[Math.floor(rng() * types.length)];

  let y = rng() * (height - 100);
  let scale = 0.5 + rng() * 0.5;
  let speed = 0.5 + rng() * 1.5;

  if (type === "WHALE") {
    scale = 1.2 + rng() * 0.8;
    speed = 0.3;
    y = rng() * (height * 0.8);
  } else if (type === "SHIP") {
    scale = 1.0 + rng() * 0.5;
    speed = 0;
    y = height - 150 + rng() * 50;
  } else if (type === "CORAL") {
    speed = 0;
    y = height - 80 + rng() * 20;
    scale = 0.8 + rng() * 0.4;
  }

  entityIdCounter += 1;

  entities.push({
    id: entityIdCounter,
    type,
    x: width + 200,
    y,
    scale,
    speed,
    variant: Math.floor(rng() * 3),
    wobbleOffset: rng() * Math.PI * 2,
  });
}

export function generateInitialPlatforms(canvasWidth: number, canvasHeight: number): Platform[] {
  const platforms: Platform[] = [];
  const count = Math.ceil(canvasWidth / Constants.TILE_SIZE) + 5;
  for (let i = 0; i < count; i++) {
    platforms.push({
      x: i * Constants.TILE_SIZE,
      y: canvasHeight - 100,
      width: Constants.TILE_SIZE,
      height: 100,
      type: "NORMAL",
    });
  }
  return platforms;
}

export function generateNextSegment(
  rng: SeededRNG,
  platforms: Platform[],
  items: Item[],
  canvasWidth: number,
  canvasHeight: number,
  score: number,
  speed: number,
  turtleShellSaved: boolean,
  turtleShellUseCount: number,
  rescueActive: boolean,
  tubePiecesCount: number,
): void {
  const lastPlat = platforms[platforms.length - 1];
  if (!lastPlat || lastPlat.x + lastPlat.width >= canvasWidth + 100) return;

  const currentLevel = Math.floor(score / 200) + 1;

  let holeChance = 0.3;
  let minGapTiles = 2;
  let maxGapTiles = 3;
  let minPlatTiles = 4;
  let maxPlatTiles = 8;

  if (currentLevel >= 2) { holeChance = 0.35; maxGapTiles = 4; maxPlatTiles = 6; }
  if (currentLevel >= 3) { holeChance = 0.4; minGapTiles = 3; minPlatTiles = 3; maxPlatTiles = 5; }
  if (currentLevel >= 4) { holeChance = 0.45; maxGapTiles = 5; minPlatTiles = 2; maxPlatTiles = 4; }
  if (currentLevel >= 5) { holeChance = 0.5; minPlatTiles = 2; maxPlatTiles = 3; }

  const maxJumpPx = (speed * 40) - 60;
  const safeMaxGapTiles = Math.floor(maxJumpPx / Constants.TILE_SIZE);
  maxGapTiles = Math.min(maxGapTiles, safeMaxGapTiles);
  if (minGapTiles > maxGapTiles) minGapTiles = maxGapTiles;

  const isGap = rng() < holeChance;
  const groundY = canvasHeight - 100;

  let nextX = lastPlat.x + lastPlat.width;

  if (isGap) {
    const gapTiles = Math.floor(rng() * (maxGapTiles - minGapTiles + 1)) + minGapTiles;
    nextX += gapTiles * Constants.TILE_SIZE;
  }

  const platTiles = Math.floor(rng() * (maxPlatTiles - minPlatTiles + 1)) + minPlatTiles;
  const isQuickSand = rng() < 0.25;

  const newPlat: Platform = {
    x: nextX,
    y: groundY,
    width: platTiles * Constants.TILE_SIZE,
    height: 100,
    type: isQuickSand ? "QUICKSAND" : "NORMAL",
    sinking: false,
  };
  platforms.push(newPlat);

  if (!isGap) {
    let spawnedUrchin = false;
    if (score > Constants.URCHIN_SCORE_THRESHOLD) {
      if (rng() < Constants.URCHIN_CHANCE) {
        items.push({
          x: newPlat.x + newPlat.width / 2,
          y: newPlat.y - 140 - (rng() * 50),
          width: 40,
          height: 40,
          collected: false,
          type: "URCHIN",
          rotation: 0,
          isDead: false,
          dy: 0,
        });
        spawnedUrchin = true;
      }
    }

    if (!spawnedUrchin) {
      let spawnedRegularItem = false;

      if (score >= Constants.TURTLE_SHELL_UNLOCK_SCORE && !turtleShellSaved && !rescueActive) {
        const turtleChance = Constants.TURTLE_SHELL_BASE_CHANCE / (1 + turtleShellUseCount * Constants.TURTLE_SHELL_RARITY_DECAY_PER_USE);
        if (rng() < turtleChance) {
          items.push({
            x: newPlat.x + newPlat.width / 2 - 22,
            y: newPlat.y - 90 - (rng() * 70),
            width: 44,
            height: 34,
            collected: false,
            type: "TURTLE_SHELL",
          });
          spawnedRegularItem = true;
        }
      }

      if (!spawnedRegularItem) {
        const rand = rng();
        if (rand < Constants.SWORDFISH_CHANCE) {
          items.push({
            x: newPlat.x + newPlat.width / 2 - 25,
            y: newPlat.y - 120 - (rng() * 80),
            width: 50,
            height: 30,
            collected: false,
            type: "SWORDFISH",
          });
        } else if (rand < Constants.SWORDFISH_CHANCE + Constants.TANK_CHANCE) {
          items.push({
            x: newPlat.x + newPlat.width / 2 - 15,
            y: newPlat.y - 60 - (rng() * 100),
            width: 30,
            height: 40,
            collected: false,
            type: "OXYGEN",
          });
        } else if (
          score >= Constants.TUBE_PIECE_UNLOCK_SCORE &&
          !rescueActive &&
          rng() < Constants.TUBE_PIECE_CHANCE
        ) {
          items.push({
            x: newPlat.x + newPlat.width / 2 - 18,
            y: newPlat.y - 90 - (rng() * 70),
            width: 36,
            height: 36,
            collected: false,
            type: "TUBE_PIECE",
            variant: tubePiecesCount % 4,
          });
        }
      }
    }
  }
}
