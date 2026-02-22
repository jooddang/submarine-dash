// Skin system: image-based sprites, color tinting, trail particles.

import greySubImg from '../images/grey-sub.png';
import whaleImg from '../images/whale.png';
import orcaImg from '../images/orca.png';
import scaryOrcaImg from '../images/scary-orca.png';
import mysticalFishImg from '../images/mystical-fish.png';

export type SkinRarity = 'common' | 'rare' | 'epic' | 'legendary';
export type TrailType = 'none' | 'bubbles' | 'sparkle' | 'flame' | 'rainbow';

export type SkinDef = {
  id: string;
  name: string;
  rarity: SkinRarity;
  cost: number;
  /** Path to the sprite image (resolved by Vite import). */
  sprite: string;
  /** If set, the grey-sub base sprite is tinted with this color via canvas composite. */
  tint: string | null;
  glowColor: string | null;
  trailType: TrailType;
  trailColor: string;
};

// ── Catalog ──────────────────────────────────────────────────────────

export const SKIN_CATALOG: SkinDef[] = [
  // ─── Common: grey-sub shape, different color tints ───
  {
    id: 'default',
    name: 'Classic',
    rarity: 'common',
    cost: 0,
    sprite: greySubImg,
    tint: null, // original grey-sub colors
    glowColor: null,
    trailType: 'none',
    trailColor: '#999',
  },
  {
    id: 'gold',
    name: 'Gold',
    rarity: 'common',
    cost: 50,
    sprite: greySubImg,
    tint: '#FFD700',
    glowColor: null,
    trailType: 'bubbles',
    trailColor: '#FFD700',
  },
  {
    id: 'ocean_blue',
    name: 'Ocean Blue',
    rarity: 'common',
    cost: 50,
    sprite: greySubImg,
    tint: '#1E90FF',
    glowColor: null,
    trailType: 'bubbles',
    trailColor: '#1E90FF',
  },
  {
    id: 'coral_red',
    name: 'Coral Red',
    rarity: 'common',
    cost: 50,
    sprite: greySubImg,
    tint: '#E74C3C',
    glowColor: null,
    trailType: 'bubbles',
    trailColor: '#E74C3C',
  },
  {
    id: 'neon_green',
    name: 'Neon Green',
    rarity: 'common',
    cost: 50,
    sprite: greySubImg,
    tint: '#39FF14',
    glowColor: 'rgba(57,255,20,0.4)',
    trailType: 'bubbles',
    trailColor: '#39FF14',
  },
  {
    id: 'royal_purple',
    name: 'Royal Purple',
    rarity: 'common',
    cost: 50,
    sprite: greySubImg,
    tint: '#8E44AD',
    glowColor: null,
    trailType: 'bubbles',
    trailColor: '#D2B4DE',
  },
  // ─── Rare: creature sprites ───
  {
    id: 'whale',
    name: 'Whale',
    rarity: 'rare',
    cost: 200,
    sprite: whaleImg,
    tint: null,
    glowColor: null,
    trailType: 'bubbles',
    trailColor: '#8E7CC3',
  },
  {
    id: 'orca',
    name: 'Orca',
    rarity: 'rare',
    cost: 200,
    sprite: orcaImg,
    tint: null,
    glowColor: null,
    trailType: 'bubbles',
    trailColor: '#555555',
  },
  // ─── Epic: creature sprite ───
  {
    id: 'scary_orca',
    name: 'Scary Orca',
    rarity: 'epic',
    cost: 500,
    sprite: scaryOrcaImg,
    tint: null,
    glowColor: 'rgba(255,50,50,0.4)',
    trailType: 'flame',
    trailColor: '#FF5733',
  },
  // ─── Legendary: creature sprite ───
  {
    id: 'mystical_fish',
    name: 'Mystical Fish',
    rarity: 'legendary',
    cost: 1500,
    sprite: mysticalFishImg,
    tint: null,
    glowColor: 'rgba(100,220,255,0.5)',
    trailType: 'rainbow',
    trailColor: '#00CED1',
  },
];

export const SKIN_MAP: Record<string, SkinDef> = Object.fromEntries(
  SKIN_CATALOG.map((s) => [s.id, s]),
);

export const DEFAULT_SKIN_ID = 'default';

export function getSkinDef(id: string): SkinDef {
  return SKIN_MAP[id] ?? SKIN_MAP[DEFAULT_SKIN_ID];
}

export const RARITY_COLORS: Record<SkinRarity, string> = {
  common: '#AAAAAA',
  rare: '#5DADE2',
  epic: '#A569BD',
  legendary: '#F1C40F',
};

// ── Image Preloading ─────────────────────────────────────────────────

const _imageCache = new Map<string, HTMLImageElement>();

/** Preload all skin sprite images. Call once at startup. */
export function preloadSkinImages(): void {
  for (const skin of SKIN_CATALOG) {
    if (!_imageCache.has(skin.sprite)) {
      const img = new Image();
      img.src = skin.sprite;
      _imageCache.set(skin.sprite, img);
    }
  }
}

export function getSkinImage(skin: SkinDef): HTMLImageElement | null {
  return _imageCache.get(skin.sprite) ?? null;
}

// ── Tinted Sprite Cache ──────────────────────────────────────────────
// For tint skins, we pre-render a tinted version of the base sprite
// onto an offscreen canvas and cache it.

const _tintCache = new Map<string, HTMLCanvasElement>();

function getTintedCanvas(img: HTMLImageElement, tint: string): HTMLCanvasElement {
  const key = `${img.src}::${tint}`;
  const cached = _tintCache.get(key);
  if (cached) return cached;

  const cvs = document.createElement('canvas');
  cvs.width = img.naturalWidth || img.width;
  cvs.height = img.naturalHeight || img.height;
  const ctx = cvs.getContext('2d')!;

  // Draw original image
  ctx.drawImage(img, 0, 0);

  // Apply color tint using multiply composite
  ctx.globalCompositeOperation = 'multiply';
  ctx.fillStyle = tint;
  ctx.fillRect(0, 0, cvs.width, cvs.height);

  // Restore alpha from original image (multiply kills transparency)
  ctx.globalCompositeOperation = 'destination-in';
  ctx.drawImage(img, 0, 0);

  ctx.globalCompositeOperation = 'source-over';
  _tintCache.set(key, cvs);
  return cvs;
}

// ── Submarine Drawing ────────────────────────────────────────────────

export function drawSubmarine(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  rotation: number,
  skin: SkinDef,
  isSwordfishActive: boolean,
  _gameTime: number,
) {
  const img = getSkinImage(skin);

  ctx.save();
  ctx.translate(x + w / 2, y + h / 2);
  ctx.rotate((rotation * Math.PI) / 180);

  // Glow
  if (isSwordfishActive) {
    ctx.shadowColor = '#00ffff';
    ctx.shadowBlur = 20;
  } else if (skin.glowColor) {
    ctx.shadowColor = skin.glowColor;
    ctx.shadowBlur = 14;
  }

  if (img && img.complete && img.naturalWidth > 0) {
    // Determine source to draw: tinted offscreen canvas or raw image
    let source: CanvasImageSource;
    if (skin.tint) {
      source = getTintedCanvas(img, skin.tint);
    } else {
      source = img;
    }
    // Draw centered, fitting into w x h
    ctx.drawImage(source, -w / 2, -h / 2, w, h);
  } else {
    // Fallback: simple colored rectangle while image loads
    ctx.fillStyle = skin.tint ?? '#888';
    ctx.beginPath();
    ctx.roundRect(-w / 2, -h / 2, w, h, 8);
    ctx.fill();
  }

  ctx.shadowBlur = 0;
  ctx.restore();
}

// ── Trail Particle System ────────────────────────────────────────────

export type TrailParticle = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number; // 0..1
  maxLife: number;
  size: number;
  color: string;
};

const TRAIL_POOL_MAX = 80;

function hslFromTime(t: number): string {
  const hue = (t * 60) % 360;
  return `hsl(${hue}, 100%, 55%)`;
}

export function updateTrailParticles(
  particles: TrailParticle[],
  dt: number,
  skin: SkinDef,
  playerX: number,
  playerY: number,
  playerW: number,
  playerH: number,
  gameTime: number,
  isPlaying: boolean,
): TrailParticle[] {
  // Update existing
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.life -= dt / p.maxLife;
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    if (p.life <= 0) {
      particles.splice(i, 1);
    }
  }

  if (!isPlaying || skin.trailType === 'none') return particles;

  // Spawn new particles from behind the submarine
  const spawnX = playerX - 4;
  const spawnY = playerY + playerH / 2;
  const spawnRate = skin.trailType === 'flame' ? 3 : skin.trailType === 'rainbow' ? 2 : 1;

  for (let i = 0; i < spawnRate; i++) {
    if (particles.length >= TRAIL_POOL_MAX) break;

    let color = skin.trailColor;
    let size = 3 + Math.random() * 3;
    let vx = -40 - Math.random() * 60;
    let vy = (Math.random() - 0.5) * 30;
    let maxLife = 0.5 + Math.random() * 0.3;

    if (skin.trailType === 'bubbles') {
      size = 2 + Math.random() * 3;
      vy = -10 - Math.random() * 20;
      vx = -20 - Math.random() * 30;
      maxLife = 0.6 + Math.random() * 0.4;
    } else if (skin.trailType === 'sparkle') {
      size = 1.5 + Math.random() * 2.5;
      vx = -50 - Math.random() * 40;
      vy = (Math.random() - 0.5) * 40;
      maxLife = 0.35 + Math.random() * 0.25;
    } else if (skin.trailType === 'flame') {
      size = 3 + Math.random() * 4;
      vx = -60 - Math.random() * 50;
      vy = (Math.random() - 0.5) * 50;
      maxLife = 0.3 + Math.random() * 0.25;
    } else if (skin.trailType === 'rainbow') {
      color = hslFromTime(gameTime + i * 0.3);
      size = 2 + Math.random() * 3;
      vx = -50 - Math.random() * 40;
      vy = (Math.random() - 0.5) * 35;
      maxLife = 0.4 + Math.random() * 0.3;
    }

    particles.push({
      x: spawnX + (Math.random() - 0.5) * 6,
      y: spawnY + (Math.random() - 0.5) * (playerH * 0.6),
      vx,
      vy,
      life: 1,
      maxLife,
      size,
      color,
    });
  }

  return particles;
}

export function drawTrailParticles(
  ctx: CanvasRenderingContext2D,
  particles: TrailParticle[],
  trailType: TrailType,
) {
  if (particles.length === 0) return;

  ctx.save();
  for (const p of particles) {
    const alpha = Math.max(0, Math.min(1, p.life));
    ctx.globalAlpha = alpha;

    if (trailType === 'bubbles') {
      ctx.strokeStyle = p.color;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
      ctx.stroke();
    } else if (trailType === 'sparkle' || trailType === 'rainbow') {
      ctx.fillStyle = p.color;
      ctx.shadowColor = p.color;
      ctx.shadowBlur = 6;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size * alpha, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;
    } else if (trailType === 'flame') {
      ctx.fillStyle = p.color;
      ctx.shadowColor = p.color;
      ctx.shadowBlur = 8;
      const s = p.size * (0.5 + alpha * 0.5);
      ctx.fillRect(p.x - s / 2, p.y - s / 2, s, s * 0.7);
      ctx.shadowBlur = 0;
    }
  }
  ctx.globalAlpha = 1;
  ctx.restore();
}

// ── Golden Tube ──────────────────────────────────────────────────────

export const GOLDEN_TUBE_UNLOCK_SKIN_IDS = ['scary_orca', 'mystical_fish'];

export function isGoldenTubeEligible(skinId: string): boolean {
  return GOLDEN_TUBE_UNLOCK_SKIN_IDS.includes(skinId);
}

export const GOLDEN_TUBE_EXTRA_CHARGES = 1;
export const GOLDEN_TUBE_EXTRA_SCORE_BONUS = 100;
