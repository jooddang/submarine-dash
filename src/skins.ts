// Skin system: data-driven catalog, parameterized submarine rendering, trail particles.

export type SkinRarity = 'common' | 'rare' | 'epic' | 'legendary';
export type TrailType = 'none' | 'bubbles' | 'sparkle' | 'flame' | 'rainbow';

export type SkinDef = {
  id: string;
  name: string;
  rarity: SkinRarity;
  cost: number; // coins (0 = free default)
  bodyColor: string;
  windowColor: string;
  windowStroke: string;
  propellerColor: string;
  glowColor: string | null; // permanent glow (null = swordfish-only glow)
  trailType: TrailType;
  trailColor: string;
};

// ── Catalog ──────────────────────────────────────────────────────────

export const SKIN_CATALOG: SkinDef[] = [
  {
    id: 'default',
    name: 'Classic',
    rarity: 'common',
    cost: 0,
    bodyColor: '#FFD700',
    windowColor: '#87CEEB',
    windowStroke: '#fff',
    propellerColor: '#666',
    glowColor: null,
    trailType: 'none',
    trailColor: '#FFD700',
  },
  {
    id: 'ocean_blue',
    name: 'Ocean Blue',
    rarity: 'common',
    cost: 50,
    bodyColor: '#1E90FF',
    windowColor: '#E0F7FF',
    windowStroke: '#fff',
    propellerColor: '#0D5C99',
    glowColor: null,
    trailType: 'bubbles',
    trailColor: '#1E90FF',
  },
  {
    id: 'coral_red',
    name: 'Coral Red',
    rarity: 'common',
    cost: 50,
    bodyColor: '#E74C3C',
    windowColor: '#FFDEDE',
    windowStroke: '#fff',
    propellerColor: '#922B21',
    glowColor: null,
    trailType: 'bubbles',
    trailColor: '#E74C3C',
  },
  {
    id: 'stealth',
    name: 'Stealth',
    rarity: 'rare',
    cost: 150,
    bodyColor: '#2C3E50',
    windowColor: '#5DADE2',
    windowStroke: '#34495E',
    propellerColor: '#1A252F',
    glowColor: null,
    trailType: 'bubbles',
    trailColor: '#5DADE2',
  },
  {
    id: 'neon',
    name: 'Neon',
    rarity: 'rare',
    cost: 150,
    bodyColor: '#39FF14',
    windowColor: '#FFFFFF',
    windowStroke: '#39FF14',
    propellerColor: '#2ECC71',
    glowColor: 'rgba(57,255,20,0.5)',
    trailType: 'sparkle',
    trailColor: '#39FF14',
  },
  {
    id: 'royal',
    name: 'Royal',
    rarity: 'epic',
    cost: 300,
    bodyColor: '#8E44AD',
    windowColor: '#FFD700',
    windowStroke: '#FFD700',
    propellerColor: '#6C3483',
    glowColor: 'rgba(142,68,173,0.35)',
    trailType: 'sparkle',
    trailColor: '#D2B4DE',
  },
  {
    id: 'golden',
    name: 'Golden',
    rarity: 'epic',
    cost: 500,
    bodyColor: '#F1C40F',
    windowColor: '#FFFFFF',
    windowStroke: '#F39C12',
    propellerColor: '#D4AC0D',
    glowColor: 'rgba(241,196,15,0.45)',
    trailType: 'sparkle',
    trailColor: '#F1C40F',
  },
  {
    id: 'crystal',
    name: 'Crystal Ice',
    rarity: 'legendary',
    cost: 1000,
    bodyColor: '#A8E6F0',
    windowColor: '#FFFFFF',
    windowStroke: '#76D7EA',
    propellerColor: '#76D7EA',
    glowColor: 'rgba(118,215,234,0.55)',
    trailType: 'flame',
    trailColor: '#76D7EA',
  },
  {
    id: 'lava',
    name: 'Lava Core',
    rarity: 'legendary',
    cost: 1000,
    bodyColor: '#E25822',
    windowColor: '#FFC300',
    windowStroke: '#FF5733',
    propellerColor: '#C0392B',
    glowColor: 'rgba(255,87,51,0.55)',
    trailType: 'flame',
    trailColor: '#FF5733',
  },
  {
    id: 'rainbow',
    name: 'Prismatic',
    rarity: 'legendary',
    cost: 1500,
    bodyColor: '#FF0000', // overridden by hue-shift
    windowColor: '#FFFFFF',
    windowStroke: '#FFFFFF',
    propellerColor: '#888',
    glowColor: 'rgba(255,255,255,0.4)',
    trailType: 'rainbow',
    trailColor: '#FFFFFF',
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

// ── Submarine Drawing ────────────────────────────────────────────────

function hslFromTime(t: number): string {
  const hue = (t * 60) % 360;
  return `hsl(${hue}, 100%, 55%)`;
}

export function drawSubmarine(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  rotation: number,
  skin: SkinDef,
  isSwordfishActive: boolean,
  gameTime: number,
) {
  ctx.save();
  ctx.translate(x + w / 2, y + h / 2);
  ctx.rotate((rotation * Math.PI) / 180);

  const isRainbow = skin.id === 'rainbow';
  const bodyColor = isRainbow ? hslFromTime(gameTime) : skin.bodyColor;

  // Glow
  if (isSwordfishActive) {
    ctx.shadowColor = '#00ffff';
    ctx.shadowBlur = 20;
  } else if (skin.glowColor) {
    ctx.shadowColor = skin.glowColor;
    ctx.shadowBlur = 14;
  }

  // Body
  ctx.fillStyle = bodyColor;
  ctx.beginPath();
  ctx.roundRect(-w / 2, -h / 2, w, h, 8);
  ctx.fill();

  ctx.shadowBlur = 0;

  // Window
  ctx.fillStyle = skin.windowColor;
  ctx.beginPath();
  ctx.arc(5, -5, 8, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = skin.windowStroke;
  ctx.lineWidth = 1;
  ctx.stroke();

  // Propeller
  ctx.fillStyle = skin.propellerColor;
  ctx.fillRect(-w / 2 - 5, -5, 5, 10);

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

export const GOLDEN_TUBE_UNLOCK_SKIN_IDS = ['golden', 'crystal', 'lava', 'rainbow'];

export function isGoldenTubeEligible(skinId: string): boolean {
  return GOLDEN_TUBE_UNLOCK_SKIN_IDS.includes(skinId);
}

// Golden tube bonus: +1 extra rescue charge when completing a tube while wearing an eligible skin.
export const GOLDEN_TUBE_EXTRA_CHARGES = 1;
export const GOLDEN_TUBE_EXTRA_SCORE_BONUS = 100;
