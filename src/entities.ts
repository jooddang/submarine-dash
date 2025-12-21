import type { Bubble, BackgroundEntity, BackgroundEntityType } from "./types";

// Bubble Factory
export const createBubble = (w: number, h: number, randomY = true): Bubble => ({
  x: Math.random() * w,
  y: randomY ? Math.random() * h : h + 20,
  size: Math.random() * 5 + 2,
  speed: Math.random() * 1 + 0.5,
  opacity: Math.random() * 0.5 + 0.1,
  wobbleOffset: Math.random() * Math.PI * 2,
});

// Background Entity Factory
export const spawnBackgroundEntity = (width: number, height: number, entities: BackgroundEntity[]): void => {
  const types: BackgroundEntityType[] = ["FISH", "FISH", "FISH", "WHALE", "JELLYFISH", "DIVER", "CORAL", "SHIP"];
  const type = types[Math.floor(Math.random() * types.length)];

  let y = Math.random() * (height - 100);
  let scale = 0.5 + Math.random() * 0.5;
  let speed = 0.5 + Math.random() * 1.5;

  if (type === "WHALE") {
    scale = 1.2 + Math.random() * 0.8;
    speed = 0.3; // Slower
    y = Math.random() * (height * 0.8);
  } else if (type === "SHIP") {
    scale = 1.0 + Math.random() * 0.5;
    speed = 0; // Moves with background
    y = height - 150 + Math.random() * 50; // Near bottom
  } else if (type === "CORAL") {
    speed = 0;
    y = height - 80 + Math.random() * 20;
    scale = 0.8 + Math.random() * 0.4;
  }

  entities.push({
    id: Date.now() + Math.random(),
    type,
    x: width + 200,
    y,
    scale,
    speed,
    variant: Math.floor(Math.random() * 3),
    wobbleOffset: Math.random() * Math.PI * 2
  });
};
