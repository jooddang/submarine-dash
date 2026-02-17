# Deep Dive Dash — Game Design Document (Current)

> **Last updated**: 2026-02-17
> **Status**: Reflects the actual shipped state of the codebase plus planned features.

---

## 1) Summary

**Deep Dive Dash** is a browser-based, side-scrolling endless-runner submarine game. The submarine auto-moves forward; the player **jumps** to clear gaps, avoid hazards (quicksand, urchins), and collect pickups (oxygen, swordfish, turtle shell, tube pieces) to maximize **score** and climb the **weekly leaderboard**. Meta progression comes from **daily missions**, **daily streaks**, **dolphin rewards** (double jump), and **tube rescue charges**.

---

## 2) Goals and Non-Goals

### Goals (Current)

- Deliver a polished browser-based endless runner with engaging core loop.
- Provide competitive motivation via weekly leaderboards.
- Drive retention via daily missions, streaks, and collectible tube pieces.
- Support lightweight account system for persistent progress.

### Non-Goals (Current)

- Real-money IAP or virtual currency economy (not yet implemented).
- Real-time multiplayer or PvP.
- OAuth / social login (Google, Apple, etc.).
- Advanced anti-cheat at scale.
- Native mobile apps.

---

## 3) Target Platforms & Controls

### Platforms

- Desktop web (keyboard)
- Mobile web (touch UI) — optimized viewport, tap/scroll distinction

### Controls

| Action | Desktop | Mobile |
|--------|---------|--------|
| Jump (tap) | `Space` / `Arrow Up` | Tap |
| High jump (hold) | Hold `Space` / Hold `Arrow Up` | Hold tap |
| Double jump | Second press while airborne (consumes 1 Dolphin) | Second tap while airborne |

---

## 4) Core Game Loop

1. Player is on the MENU screen. Press Space / tap to start a run.
2. Submarine auto-advances rightward; player jumps to avoid hazards and clear gaps.
3. Player collects pickups during the run:
   - **Oxygen tank** → +10s oxygen
   - **Swordfish** → 5s of 3x speed + flight + invincibility
   - **Turtle shell** → saved item, auto-rescues from quicksand
   - **Tube piece** → collect 4 to complete a tube (earns tube rescue charge)
4. Oxygen depletes continuously (1s/s). Run ends on:
   - Oxygen reaches 0, **or**
   - Fall into a gap (unless rescued by tube charge), **or**
   - Urchin collision (unless swordfish active), **or**
   - Trapped on sinking quicksand (unless turtle shell rescues)
5. Game over → score displayed → submit to leaderboard (if logged in) → retry.
6. Daily missions track progress → completing all 3 missions keeps the streak → streak 5+ earns dolphins.

---

## 5) Game Rules & Mechanics

### 5.1 Movement & Jump

- **Auto-forward speed**: Starts at `6`, increases by `0.1 * dt` per frame, caps at `14`.
- **Gravity**: `0.6` per frame.
- **Jump**: Initial vertical velocity of `-9`.
- **Variable jump height**: Holding the jump key applies an anti-gravity boost (`0.6` force) for up to `0.4s`, enabling higher jumps.
- **Jump buffer**: `0.15s` buffer window — pressing jump slightly before landing still registers.
- **Airborne rotation**: Player sprite rotates `2 deg/frame` while airborne, resets on landing.
- **Grounded detection**: Player must be within `35px` of a platform surface.

### 5.2 Oxygen System

- **Max oxygen**: 30 seconds.
- **Depletion rate**: 1.0 per second.
- **Oxygen tank**: Restores +10 seconds (capped at max).
- **Death**: Oxygen reaching 0 triggers game over.

### 5.3 Hazards

| Hazard | Behavior | Protection |
|--------|----------|------------|
| **Gaps** | Falling off-screen ends the run | Tube rescue charge (auto-activates) |
| **Quicksand** | After 500ms standing, platform sinks; player is trapped and cannot jump | Turtle shell (auto-activates rescue sequence) |
| **Urchins** | Contact = instant death | Swordfish invincibility (urchin dies instead) |

### 5.4 Platform Generation

- **Tile-based**: Each platform tile is 50px wide.
- **Types**: `NORMAL` (sandy, `#c2b280`) and `QUICKSAND` (brown, `#a67b5b`, 25% spawn chance).
- **Procedural**: Platforms and gaps generated as the world scrolls, with parameters controlled by difficulty level.
- **Safe gap capping**: Maximum gap width is dynamically limited so jumps are always physically possible at current speed.

---

## 6) Items & Power-ups

### 6.1 Oxygen Tank — LIVE

- **Spawn chance**: 15%
- **Effect**: +10s oxygen (capped at max 30s)
- **Score bonus**: None
- **Visual**: Cyan rectangle with "O2" text
- **Sound**: Rising sine sweep
- **Mission tracking**: Sends `oxygen_collected` event to server

### 6.2 Swordfish Pack — LIVE

- **Spawn chance**: 3%
- **Duration**: 5 seconds
- **Effects**:
  - 3x speed multiplier (triples score accumulation rate)
  - Flight mode (no gravity, player floats)
  - Invincibility (kills urchins on contact, ignores quicksand)
  - Cyan glow on submarine
- **Safe landing**: When timer expires, hovers until a safe platform is below, then descends.
- **Sound**: Three-note ascending arpeggio (square wave)

### 6.3 Urchin (Enemy) — LIVE

- **Spawn chance**: 5% (only after score > 1000)
- **Behavior**: Static position on platforms, slow rotation
- **On collision without swordfish**: Instant death
- **On collision with swordfish**: Urchin dies (bounce animation, crying face)
- **Visual**: Orange spiked ball with cute face (custom canvas drawing)

### 6.4 Turtle Shell — LIVE

- **Unlock score**: 1500 (does not spawn before this)
- **Spawn chance**: 3% base, decays with each use: `baseChance / (1 + uses * 1.0)`
- **Condition**: Only spawns if player does not already have one saved
- **Behavior**: Saved item (shown in HUD). Auto-activates when player gets trapped in quicksand.
- **Rescue animation** (4-phase state machine):
  1. `FLY_IN` — Turtle sprite flies in from top-right
  2. `HOOK` — Fishing line connects to submarine, brief pause
  3. `TOW` — Turtle tows submarine to next normal platform
  4. `COUNTDOWN` — 3-second countdown, turtle flies away, game resumes
- **Visual**: PNG sprite (`turtle.png`) with fishing line; fallback canvas-drawn shell
- **Sound**: `shell_crack` (sine thump + noise burst)

### 6.5 Dolphin / Double Jump — LIVE

- **Type**: Inventory item (not spawned in-world during runs)
- **Acquisition**:
  - Daily streak reaches 5+ → earns 1 Dolphin per streak increment
  - Weekly leaderboard #1 → earns 1 Dolphin
- **Effect**: One-time mid-air double jump (consumes 1 Dolphin from server inventory)
- **Per-run limit**: 3 double jumps maximum per run
- **Smart skip**: Won't consume a Dolphin if landing is imminent (kinematic prediction within 8 frames)
- **Toggle**: HUD button to enable/disable dolphin usage during a run
- **Inventory**: Server-side Redis (source of truth) with optimistic client-side updates + sequence-based rollback
- **Legacy migration**: Auto-imports dolphins from localStorage on login

### 6.6 Tube Pieces — LIVE

- **Unlock score**: 1250 (does not spawn before this)
- **Spawn chance**: 6%
- **Mechanic**: Collect 4 pieces to complete one tube
  - Each piece shows a different quadrant of the tube sprite (2x2 sheet from `tube.png`)
  - Progress displayed in HUD as a 2x2 grid
  - On completion: **+250 score bonus**, earns 1 tube rescue charge, progress resets to 0
- **Tube rescue**: When player falls off-screen with rescue charges available, a tube rescue animation plays (similar to turtle rescue, spinning tube sprite). Consumes 1 charge.
- **Persistence**: Tube pieces persist within a browser session via `sessionStorage`.

---

## 7) Scoring & Difficulty

### 7.1 Scoring

- **Primary**: `floor(distance / 10)` where distance accumulates at effective speed each frame.
- **Swordfish multiplier**: 3x effective speed → 3x score accumulation.
- **Tube completion bonus**: +250 points per completed tube.
- **No score from pickups**: Oxygen, turtle shell, and tube pieces do not directly add score.

### 7.2 Difficulty Ramp

Level = `floor(score / 200) + 1`.

| Level | Hole Chance | Min Gap Tiles | Max Gap Tiles | Min Platform Tiles | Max Platform Tiles |
|-------|------------|---------------|---------------|--------------------|--------------------|
| 1 | 0.30 | 2 | 3 | 4 | 8 |
| 2 | 0.35 | 2 | 4 | 4 | 6 |
| 3 | 0.40 | 3 | 4 (capped) | 3 | 5 |
| 4 | 0.45 | 3 | 5 (capped) | 2 | 4 |
| 5+ | 0.50 | 3 | 5 (capped) | 2 | 3 |

Speed ramps from 6 → 14. Gap maximums are capped based on current speed to ensure jumps remain physically possible.

---

## 8) Meta Systems (Implemented)

### 8.1 Daily Missions — LIVE

Three fixed missions per day (reset daily based on client timezone):

| Mission | Target | Tracking |
|---------|--------|----------|
| Reach 800 points | 1 run with score >= 800 | `run_end` event |
| Play 3 runs | 3 completed runs | `run_end` event |
| Collect 3 oxygen tanks | 3 oxygen pickups (cumulative across runs) | `oxygen_collected` event |

- Progress tracked server-side per user per day.
- Completing **all 3 missions** marks the day as "kept" for streak purposes.
- Requires login to track.

### 8.2 Daily Streak — LIVE

- Completing all daily missions for a day "keeps" the streak.
- Streak increments if the previous day was also kept; otherwise resets to 1.
- **At streak >= 5**: Each streak increment grants 1 Dolphin (idempotent via `lastAwarded` tracking).
- Streak reset clears the `lastAwarded` counter so future milestones can earn dolphins again.

### 8.3 Weekly Leaderboard — LIVE

- **Rotation**: Week boundaries in PST/PDT (Monday–Sunday).
- **Top 5 entries** per week.
- **Historical view**: All past weeks shown in scrollable list (newest first).
- **Profanity filter**: English (library) + Korean (custom list) + fuzzy/leet-speak matching.
- **Submission requires login**.

### 8.4 Weekly Winner Reward — LIVE

- On login (`/auth/me`), server checks if user was #1 in the previous week's leaderboard.
- If so, grants 1 Dolphin (idempotent via per-user claim key per weekId).

---

## 9) Authentication & Backend — LIVE

### 9.1 Auth System

- **Registration**: loginId (3–32 chars) + password (8–72 chars)
- **Password hashing**: `crypto.scrypt` with random 16-byte salt, 64-byte hash
- **Sessions**: Random 16-byte tokens stored in Redis (30-day TTL)
- **Cookies**: HttpOnly, SameSite=Lax
- **Rate limits**: 10 registrations/min, 20 logins/min per IP
- **Referral code**: Each user gets a `refCode` (6-byte random, URL-safe) on registration — **not yet wired to any referral system**
- **Change password**: Supported via `/api/auth/change-password`

### 9.2 API Endpoints (Implemented)

| Method | Endpoint | Purpose |
|--------|----------|---------|
| POST | `/api/auth/register` | Create account |
| POST | `/api/auth/login` | Log in |
| POST | `/api/auth/logout` | Log out |
| GET | `/api/auth/me` | Session/profile + weekly winner check |
| POST | `/api/auth/change-password` | Change password |
| GET | `/api/leaderboard` | Get current week leaderboard |
| POST | `/api/leaderboard` | Submit score |
| DELETE | `/api/leaderboard` | Admin: delete entry |
| GET | `/api/leaderboard/weekly` | Get weekly history |
| GET | `/api/missions/daily` | Get today's missions + progress |
| POST | `/api/missions/event` | Report mission event |
| POST | `/api/inventory/dolphin/consume` | Consume 1 dolphin |
| POST | `/api/inventory/dolphin/import` | Import legacy localStorage dolphins |
| GET | `/api/health` | Health check |

### 9.3 Infrastructure

- **Production**: Vercel serverless functions
- **Development**: Express.js local server (mirrors Vercel API)
- **Database**: Redis via Upstash (production) / ioredis (local dev)

---

## 10) UI Screens (Implemented)

### Menu Overlay

- Title: "DEEP DIVE DASH" with cyan glow
- "Press SPACE to Start" prompt (pulse animation)
- Gameplay instructions (controls, items)
- Dolphin/streak promo banner
- STREAK button → opens Daily Missions panel
- INBOX button (placeholder — UI renders but not functional)
- Login/Logout button + Auth modal
- Current week leaderboard table
- Historical weekly leaderboards

### HUD (During Gameplay)

- Score (5-digit zero-padded)
- Level ("LVL N" in gold)
- Oxygen bar (200px, turns red < 5s, shows seconds remaining)
- Saved items row: turtle shell, dolphin (with count badge), tube rescue charges
- Dolphin toggle button (ON/OFF)
- Tube progress (2x2 grid, appears after score >= 1250)
- Tube completion toast ("Tube Completed!" 1.2s auto-dismiss)
- Rescue countdown (large centered number during rescue animations)

### Input Name Overlay

- Shown when score qualifies for top 5
- "NEW HIGH SCORE!" title in gold
- Text input for leaderboard name
- "LOG IN TO SUBMIT" if not authenticated
- Submit button

### Game Over Overlay

- "GAME OVER" (or "LEADERBOARD" if score submitted)
- Final score display
- Current week leaderboard (submitted entry highlighted in gold)
- Historical weekly leaderboards
- "Press SPACE to Retry" prompt

### Auth Modal

- Modes: Login, Signup, Change Password
- Login ID + Password fields, error display, loading state
- Mode switching links

### Daily Missions Panel

- Modal showing current streak count + today's date
- Three mission cards with progress bars and DONE status
- "Log in to track progress" for unauthenticated users

### Reward Overlays

- Dolphin streak reward overlay (confetti + explanation modal)
- Dolphin weekly winner overlay (confetti + explanation modal)
- Confetti canvas (160 colored particles, 2.2s duration)

---

## 11) Audio & Visual Systems

### Audio (Web Audio API — Synthesized, No Audio Files)

| Sound | Trigger | Character |
|-------|---------|-----------|
| `jump` | Player jumps | Quick rising sine (200→400Hz, 0.1s) |
| `oxygen` | Collect oxygen tank | Higher rising sine (800→1200Hz, 0.15s) |
| `swordfish` | Collect swordfish | 3-note square wave arpeggio (0.3s) |
| `shell_crack` | Collect turtle shell | Low sine thump + noise burst (0.06s) |
| `die_urchin` | Hit urchin | Descending sawtooth buzz (0.3s) |
| `die_fall` | Fall into gap | Long descending triangle (0.5s) |
| `die_quicksand` | Sink in quicksand | Very low square descent (0.8s) |

Mobile audio unlock handled via user interaction events.

### Visual

- **Dynamic gradient background**: Interpolates from light ocean blue → deep dark (maxes at score 5000)
- **Light rays**: 5 animated translucent trapezoids with overlay blend, sine-wave sway
- **Bubbles**: 20 ambient bubbles rising with horizontal wobble
- **Background entities** (~1 per second): Fish (3 color variants, 3x weight), Galaxy Whale, Jellyfish, Scuba Diver, Sunken Ship, Coral — all with parallax, vertical bob, subtle rotation
- **Player**: Golden rounded rectangle with eye, periscope, cyan glow during swordfish
- **Platforms**: Sandy color (normal) / darker brown (quicksand) with lighter top edges

---

## 12) Data Model (Current — Redis)

### User

- `sd:user:<userId>` → `{ userId, loginId, passwordHash, passwordSalt, createdAt, displayName, refCode, referredBy? }`
- `sd:loginId:<loginIdLower>` → `userId`
- `sd:session:<sessionToken>` → `userId` (TTL 30 days)

### Dolphin Inventory

- `sd:user:<userId>:dolphins` → `{ saved, pending, ledger[] }` (capped at 100 ledger entries)

### Missions & Streak

- `sd:user:<userId>:daily:<yyyy-mm-dd>` → mission progress + completion
- `sd:user:<userId>:streak` → `{ count, lastKeptDate, lastAwarded }`

### Leaderboard

- Weekly leaderboard entries (top 5 per week key)
- Week key format based on PST Monday–Sunday boundaries

### Weekly Winner Claims

- Per-user per-weekId claim key for dolphin reward idempotency

---

## 13) Corrections from Outdated Document

The outdated "Game Design Document" contained several discrepancies from the actual implementation:

| Topic | Outdated Doc Says | Actual Implementation |
|-------|-------------------|----------------------|
| Tube completion bonus | +2000 points | **+250 points** |
| Turtle shell score | +1500 points on pickup | **No score bonus** on pickup |
| Streak rule | "plays at least one completed run" | **Complete all 3 daily missions** |
| Dolphin max inventory | 5 | **No hard cap on saved count** (per-run limit is 3) |
| Oxygen pack score bonus | Optional +100 | **No score bonus** |
| Tube piece status | Planned (Section 8.1) | **Fully implemented** |
| Auth system | Planned (Social Growth) | **Fully implemented** |
| Daily missions | Planned (Phase 4) | **Fully implemented** |
| Streak system | "login and play" triggers streak | **Mission-completion-based** |

---

## 14) Planned Features (Not Yet Implemented)

### P0 — Core Progression & Economy

#### 14.1 Coins (Soft Currency)

- Earn coins per run (distance or score brackets), daily streak bonuses, and future wheel rewards.
- Spend on skins and convenience items.
- Server-side authoritative balance. No negative balances; atomic transactions.
- **Status**: Not implemented. No coin logic, no UI, no API.

#### 14.2 Inventory / Profile Screen

- Display: Dolphins, Turtle Shells (session), Tube Pieces, Golden items, Coins, Equipped Skin.
- **Status**: Not implemented. Item counts are shown in HUD during gameplay but there is no dedicated inventory screen.

### P1 — Monetization

#### 14.3 Golden Swordfish Pack (IAP ~$1)

- Stronger swordfish boost: +65% longer duration than normal.
- Consumable inventory (purchased packs persist in account, 1 use per game).
- Activation: two-finger tap or Space + ArrowUp together.
- **Status**: Not implemented.

#### 14.4 Golden Oxygen (IAP ~$1.25)

- Starts run with 45s oxygen bar (instead of 30s).
- Oxygen packs restore 15s (instead of 10s) during that run.
- Consumable (1 use per game), purchased packs persist in account.
- Pre-run toggle in inventory to choose whether to use for next game.
- **Status**: Not implemented.

#### 14.5 Increased Oxygen Bar 10x (IAP ~$7–8)

- Permanent upgrade: Max Oxygen 30s → 300s.
- Oxygen packs still restore +10s (or optionally +20s post-upgrade).
- Tied to account, restores on login.
- **Status**: Not implemented.

#### 14.6 Shop Screen

- IAP purchase flow for Golden Swordfish, Golden Oxygen, Oxygen Bar Upgrade.
- Future: Coin-based purchases.
- **Status**: Not implemented.

### P2 — Retention Systems

#### 14.7 Lottery Wheel

- 1 free spin/day (or spin earned per N runs).
- Reward pool: Coins, Tube piece, Dolphin, Turtle shell, Golden oxygen, Skin fragments.
- Server-authoritative spin outcomes.
- Odds must be explicit in design docs / UI.
- **Status**: Not implemented.

#### 14.8 Referral System ("Bring a Friend")

- Each user already has a `refCode` generated on registration.
- Planned flow: Share URL `/?ref=<refCode>` → friend signs up → both get reward (+1 tube piece).
- Anti-fraud: one reward per invitee, device fingerprinting, rate limits.
- **Status**: Partially implemented. `refCode` exists in user data. No referral tracking, no reward logic, no UI.

#### 14.9 Challenge System (Inbox)

- Share a "Beat my score" link: `/?challenge=<score>&from=<userId>`.
- Receiver sees challenge in Inbox with provocative copy.
- Accept → starts run with target score pinned in HUD.
- **Status**: Not implemented. Inbox button exists in menu UI as a placeholder but is non-functional.

### P3 — Cosmetics

#### 14.10 Skins

- Cosmetic submarine skins (sprite set + UI icon + rarity metadata).
- Unlock sources: Coins shop, Wheel rewards, Golden tube achievements.
- Some skins have abilities (from outdated doc — needs design review):
  - Shark: eat 2 urchins
  - Colorful fish: invincible to quicksand
  - Orca whale: 2x speed for 3s
  - Some skins have custom trails
- **Status**: Not implemented.

#### 14.11 Golden Tube

- Cosmetic prestige variant of tube mechanic.
- Completing a tube has a small chance to become Golden Tube (or via wheel).
- Effect: Unlocks skin/profile badge or grants coins. No direct score bonus.
- **Status**: Not implemented.

### P4 — Competitive

#### 14.12 PvP Ghost Race + Coin Wager

- Asynchronous race against recorded ghost run of another player.
- Wager uses coins only (virtual, no real-money cash-out).
- Winner gets `stake * 0.9` (10% fee sink).
- **Status**: Not implemented. Explicitly deferred; requires coin economy first.

---

## 15) Missing Infrastructure

### Anti-Cheat (Not Implemented)

- Server currently trusts client-submitted scores.
- Planned mitigations:
  - Validate score against max plausible distance/time.
  - Send run duration + oxygen usage + event counts for sanity check.
  - Rate-limit submissions per account/IP.
  - "Verified run" mode for top leaderboard entries.

### Background Music

- Only synthesized SFX exist. No background music track.

### Settings/Options Screen

- No volume controls, no pause functionality, no settings UI.

### Tutorial/Onboarding

- Basic text instructions shown on menu screen. No interactive tutorial.

---

## 16) Open Design Decisions

| Decision | Current State | Recommendation |
|----------|---------------|----------------|
| Swordfish duration model | Fixed 5 seconds | Consider distance-based for higher speeds |
| Turtle shell inventory cap | No explicit cap (spawning gated by "no existing shell" check) | Add cap (5–10) if shell becomes persistent across sessions |
| Tube piece persistence | `sessionStorage` (resets on tab close) | Consider server-side persistence for logged-in users |
| Dolphin saved cap | No hard cap | Add cap (e.g., 5) to prevent unlimited hoarding |
| Coin earning formula | Not yet designed | Score-bracket-based recommended (aligns with existing scoring) |
| Wheel odds transparency | Not yet designed | Display odds in UI (builds trust, may be legally required) |
| Skin abilities vs cosmetic-only | Outdated doc lists abilities for skins | Abilities create balance concerns; recommend cosmetic-only for v1 |
| Golden items affect score? | Not yet designed | Avoid in v1 to prevent pay-to-win perception |
| Guest score submission | Currently: login required | Keep as-is; reduces spam and enables progression tracking |

---

## 17) Tech Stack Summary

| Component | Technology |
|-----------|-----------|
| Rendering | HTML5 Canvas API (no game engine) |
| Frontend | React 19, TypeScript 5.8, Vite 6 |
| Audio | Web Audio API (synthesized oscillators) |
| Backend (prod) | Vercel serverless functions |
| Backend (dev) | Express.js 4 local server |
| Database | Redis via Upstash (prod) / ioredis (dev) |
| Profanity | `@coffeeandfun/google-profanity-words` + custom Korean + fuzzy |
| Deployment | Vercel |

---

## 18) Key Source Files Reference

| File | Purpose |
|------|---------|
| `src/Game.tsx` | Main game component (~2100 lines): game loop, physics, state management |
| `src/constants.ts` | All game tuning constants |
| `src/types.ts` | TypeScript type definitions |
| `src/entities.ts` | Background entity factories (fish, whale, jellyfish, etc.) |
| `src/audio.ts` | Web Audio API sound synthesis |
| `src/graphics.ts` | Color interpolation helper |
| `src/drawing.ts` | Canvas drawing functions (swordfish, urchin, items) |
| `src/api.ts` | API client (leaderboard, auth, missions, inventory) |
| `src/components/UIOverlays.tsx` | All UI overlays (HUD, menus, modals) |
| `api/` | Vercel serverless functions |
| `api/_lib/` | Shared backend helpers (Redis, auth, dolphin inventory, weekly leaderboard) |
| `backend/src/server.js` | Express dev server (~911 lines) |
| `shared/` | Profanity filter + week boundary calculations |
