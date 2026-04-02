/**
 * Node.js environment server for RL training.
 * Wraps the deterministic pvp-core simulation and communicates via stdin/stdout JSON lines.
 *
 * Protocol:
 *   → {"cmd":"reset","seed":42}
 *   ← {"obs":[...],"info":{"score":0}}
 *
 *   → {"cmd":"step","action":0}
 *   ← {"obs":[...],"reward":0.1,"terminated":false,"truncated":false,"info":{"score":120}}
 *
 *   → {"cmd":"close"}
 *   (process exits)
 */

import { createSeededRNG } from "../src/pvp-core/rng";
import { createPlayerState, updatePlayerState, attemptJump } from "../src/pvp-core/sim";
import { resetEntityIdCounter } from "../src/pvp-core/world";
import type { PvpPlayerState, PvpPowerUpMode } from "../src/pvp/pvpTypes";
import type { SimulationSideEffect } from "../src/pvp-core/events";
import * as Constants from "../src/constants";
import * as readline from "readline";

// --- Config ---
const CANVAS_WIDTH = 800;
const CANVAS_HEIGHT = 600;
const FIXED_DT = 1 / 60; // 60 FPS simulation
const POWER_UP_MODE: PvpPowerUpMode = "earned"; // no inventory items, earn everything in-game
const MAX_STEPS = 18000; // 5 minutes at 60fps = truncation

// --- State ---
let state: PvpPlayerState | null = null;
let prevScore = 0;
let prevOxygen = 0;
let stepCount = 0;
let holdFrames = 0; // how many consecutive frames jump is held

// --- Observation extraction ---
function extractObservation(s: PvpPlayerState): number[] {
  const obs: number[] = [];
  const p = s.player;

  // Player state (7 features)
  obs.push(p.y / CANVAS_HEIGHT);                              // 0: y position normalized
  obs.push(p.dy / 20);                                        // 1: vertical velocity normalized
  obs.push(p.grounded ? 1 : 0);                               // 2: on ground
  obs.push(s.oxygen / Constants.OXYGEN_MAX);                   // 3: oxygen level
  obs.push(s.speed / Constants.MAX_SPEED);                     // 4: game speed
  obs.push(s.isSwordfishActive ? 1 : 0);                      // 5: swordfish active
  obs.push(p.isTrapped ? 1 : 0);                              // 6: trapped in quicksand

  // Power-up state (3 features)
  obs.push(s.turtleShellSaved ? 1 : 0);                       // 7: has turtle shell
  obs.push(s.tubePieces / Constants.TUBE_PIECES_PER_TUBE);    // 8: tube progress
  obs.push(s.tubeRescueCharges > 0 ? 1 : 0);                 // 9: has tube rescue

  // Forward-looking platform info: next 5 platforms relative to player (20 features)
  const playerRight = p.x + p.width;
  const forwardPlatforms = s.platforms
    .filter(pl => pl.x + pl.width > playerRight - 20)
    .sort((a, b) => a.x - b.x)
    .slice(0, 5);

  for (let i = 0; i < 5; i++) {
    if (i < forwardPlatforms.length) {
      const pl = forwardPlatforms[i];
      obs.push((pl.x - p.x) / CANVAS_WIDTH);                  // relative x distance
      obs.push((pl.y - p.y) / CANVAS_HEIGHT);                 // relative y distance
      obs.push(pl.width / CANVAS_WIDTH);                       // platform width
      obs.push(pl.type === "QUICKSAND" ? 1 : 0);              // quicksand flag
    } else {
      obs.push(0, 0, 0, 0);                                   // padding
    }
  }

  // Forward-looking items: next 4 items relative to player (20 features)
  const forwardItems = s.items
    .filter(it => !it.collected && it.x + it.width > p.x)
    .sort((a, b) => a.x - b.x)
    .slice(0, 4);

  for (let i = 0; i < 4; i++) {
    if (i < forwardItems.length) {
      const it = forwardItems[i];
      obs.push((it.x - p.x) / CANVAS_WIDTH);                  // relative x
      obs.push((it.y - p.y) / CANVAS_HEIGHT);                 // relative y
      // Item type one-hot: OXYGEN, SWORDFISH, URCHIN, TURTLE_SHELL, TUBE_PIECE
      obs.push(it.type === "OXYGEN" ? 1 : 0);
      obs.push(it.type === "SWORDFISH" ? 1 : 0);
      obs.push(it.type === "URCHIN" ? 1 : 0);
    } else {
      obs.push(0, 0, 0, 0, 0);                                // padding
    }
  }

  // Gap detection: distance to next gap (1 feature)
  let gapDist = 1.0; // default: no gap visible
  for (let i = 0; i < forwardPlatforms.length - 1; i++) {
    const curr = forwardPlatforms[i];
    const next = forwardPlatforms[i + 1];
    const gapStart = curr.x + curr.width;
    const gapSize = next.x - gapStart;
    if (gapSize > 5) {
      gapDist = Math.max(0, (gapStart - p.x) / CANVAS_WIDTH);
      break;
    }
  }
  obs.push(gapDist);                                           // 51: gap distance

  return obs;
}

// --- Reward computation ---
function computeReward(s: PvpPlayerState, effects: SimulationSideEffect[], died: boolean): number {
  let reward = 0;

  // Score delta
  const scoreDelta = s.score - prevScore;
  reward += scoreDelta * 0.01;

  // Survival bonus per step
  reward += 0.005;

  // Oxygen management
  const oxygenDelta = s.oxygen - prevOxygen;
  if (oxygenDelta > 0) {
    reward += 0.5; // picked up oxygen
  }

  // Power-up collection
  for (const effect of effects) {
    if (effect.type === "PLAY_SOUND") {
      if (effect.sound === "swordfish") reward += 1.0;
      if (effect.sound === "shell_crack") reward += 0.5;
    }
  }

  // Death penalty
  if (died) {
    reward -= 5.0;
  }

  // Low oxygen warning (encourage proactive oxygen seeking)
  if (s.oxygen < 8 && s.oxygen > 0) {
    reward -= 0.01;
  }

  return reward;
}

// --- Command handlers ---
function handleReset(seed: number): string {
  resetEntityIdCounter(0);
  const rng = createSeededRNG(seed);
  state = createPlayerState(rng, CANVAS_WIDTH, CANVAS_HEIGHT, POWER_UP_MODE, 0, 0);
  prevScore = 0;
  prevOxygen = state.oxygen;
  stepCount = 0;
  holdFrames = 0;

  const obs = extractObservation(state);
  return JSON.stringify({ obs, info: { score: 0 } });
}

function handleStep(action: number): string {
  if (!state) {
    return JSON.stringify({ error: "Not initialized. Call reset first." });
  }

  const effects: SimulationSideEffect[] = [];

  // Action mapping:
  // 0 = do nothing
  // 1 = jump (press, no hold)
  // 2 = jump (press and hold for higher jump)
  if (action === 1) {
    // Short jump: press once
    state.jumpInputActive = false;
    holdFrames = 0;
    attemptJump(state, false, POWER_UP_MODE, effects);
  } else if (action === 2) {
    // Long jump: press + hold
    if (holdFrames === 0) {
      attemptJump(state, false, POWER_UP_MODE, effects);
    }
    state.jumpInputActive = true;
    holdFrames++;
  } else {
    state.jumpInputActive = false;
    holdFrames = 0;
  }

  // Jump buffer: if jump was attempted but player not grounded, buffer it
  if (action === 1 || (action === 2 && holdFrames === 1)) {
    if (!state.player.grounded && !state.isSwordfishActive) {
      state.jumpBufferTimer = Constants.JUMP_BUFFER_TIME;
    }
  }

  prevScore = state.score;
  prevOxygen = state.oxygen;

  const died = updatePlayerState(state, FIXED_DT, CANVAS_WIDTH, CANVAS_HEIGHT, POWER_UP_MODE, effects);
  stepCount++;

  const truncated = stepCount >= MAX_STEPS;
  const terminated = !state.alive;
  const reward = computeReward(state, effects, died);

  const obs = extractObservation(state);
  return JSON.stringify({
    obs,
    reward,
    terminated,
    truncated,
    info: {
      score: state.score,
      distance: state.distance,
      oxygen: state.oxygen,
      speed: state.speed,
      step: stepCount,
      deathCause: state.deathCause,
    },
  });
}

// --- Main stdin/stdout loop ---
const rl = readline.createInterface({ input: process.stdin });

rl.on("line", (line: string) => {
  try {
    const msg = JSON.parse(line);
    let response: string;

    if (msg.cmd === "reset") {
      response = handleReset(msg.seed ?? 42);
    } else if (msg.cmd === "step") {
      response = handleStep(msg.action ?? 0);
    } else if (msg.cmd === "close") {
      process.exit(0);
    } else {
      response = JSON.stringify({ error: `Unknown command: ${msg.cmd}` });
    }

    process.stdout.write(response + "\n");
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    process.stdout.write(JSON.stringify({ error: message }) + "\n");
  }
});

// Signal ready
process.stderr.write("env-server ready\n");
