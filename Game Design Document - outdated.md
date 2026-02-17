# Deep Dive Dash — Game Design Document

### 1) Summary

**Deep Dive Dash** is a browser-based, side-scrolling “one-button” submarine runner. The submarine auto-moves forward; the player **jumps** to clear gaps, avoid hazards (e.g., quick sand), and collect pickups to maximize **score** and climb the **leaderboard**. Meta progression comes from **streak rewards**, **weekly leaderboard rewards**, and future **collectibles + cosmetics + monetization**.

---

## 2) Goals and Non-Goals (v0.1)

### Goals

- Document current gameplay clearly and make it implementable by a coding AI.
- Define item behaviors, inventory rules, scoring, and leaderboard logic.
- Introduce new roadmap features (tube pieces, golden items, shop, coins, skins, wheel, invites, PvP race/betting) with clear acceptance criteria and guardrails.

### Non-Goals (for v0.1)

- Full legal/compliance design for real-money wagering (must avoid or strictly virtualize).
- Advanced matchmaking, anti-cheat at scale, multi-region infrastructure.

---

## 3) Target Platforms & Controls

### Platforms

- Desktop web (keyboard)
- Mobile web (touch UI)

### Controls

- **Jump**: `Space` (primary), `Arrow Up` (alt), **tap** (mobile)
- **Hold Space**: higher jump (already described in UI)
- **Double Jump**: consumes **Dolphin** (if available)

---

## 4) Core Game Loop

1. Player starts run (press Space).
2. Submarine auto-advances; player jumps to avoid hazards and clear gaps.
3. Player collects pickups:
    - Oxygen pack (+time)
    - Turtle shell (1-time hazard protection)
    - Swordfish pack (temporary speed + invincibility)
4. Oxygen depletes; run ends on:
    - Oxygen reaches 0, **or**
    - Fatal hazard (unless protected), **or**
    - Falling into gaps / collapse events.
5. Submit score → leaderboard → streak/weekly rewards update → player may retry.

---

## 5) Game Rules & Mechanics

### 5.1 Movement & Jump

- Auto-forward speed increases by level/difficulty ramp.
- Jump arc:
    - Tap/press = normal jump
    - Hold = high jump (cap to prevent “infinite hover”)
- Double jump:
    - Only if the player has **≥ 1 Dolphin**
    - Consumes **1 Dolphin** when used
    - Triggers on the second jump while airborne

### 5.2 Oxygen System

- Run starts with **Max Oxygen = 30 seconds** (current)
- Oxygen decreases continuously while playing.
- **Oxygen pack** adds **+10 seconds** (current).
- Cap behavior (recommendation):
    - Oxygen cannot exceed Max Oxygen (unless upgraded via paid “Increased Oxygen Bar” feature).

### 5.3 Hazards

- **Gaps**: falling ends the run.
- **Quick sand**: causes collapse/fail unless protected by Turtle Shell (details below).
- **Urchins** (mentioned in UI): contact damage ends run unless invincible.

### 5.4 Items (Current)

### Turtle Shell (DONE)

- **Effect**: Saves player from collapsing into quick sand **one time**.
- **Consumption**: Automatically consumed on trigger; then removed.
- **Appearance**: when a player reached 1500 points
- **Inventory**: Persist between runs (recommendation: cap at 5 or 10 to prevent hoarding; configurable)

### Oxygen Pack (LIVE)

- **Effect**: +10 seconds oxygen
- **Score**: optional (recommendation: +0 to keep value purely survival-based, or small +100)

### Swordfish Pack (LIVE)

- **Effect**: **3× speed** + **invincibility** for duration
- **Duration**: define a fixed time window (recommendation: 3–5 seconds) OR distance-based duration
- **Invincibility**:
    - Ignores urchins and quick sand
    - Still must clear hard gaps unless you want “ghost through everything” behavior (recommendation: still fall in gaps)

### Dolphin / Double Jump (DONE)

- **Effect**: One-time double jump
- **Acquisition (DONE)**:
    - Streak: when a player’s daily streak **reaches 5+**, they earn **1 Dolphin** (one per day)
    - Weekly leaderboard: **Weekly #1** earns **1 Dolphin**
- **Inventory**:
    - Max saved: **5 Dolphins**
    - Excess Dolphins are not granted (or convert to coins later; TBD)

---

## 6) Scoring & Difficulty

### ~~6.1 Score Sources (v0.1)~~

- ~~Distance traveled (primary)~~
- ~~Item pickups:~~
    - ~~Turtle Shell: +1500~~
    - ~~Tube completion: +2000 (planned)~~
- ~~Optional: clean jumps / streaks / near-miss bonuses (future)~~

### 6.2 Difficulty Ramp

- **Level** increases over time or distance.
- Ramp levers:
    - Spawn frequency of hazards
    - Gap sizes / sand frequency
    - Speed scaling

**Acceptance criterion:** difficulty increases are noticeable but do not spike unfairly; average run length should support repeated play (target: 30–90 seconds average for casual).

---

## 7) Meta Systems (Current)

### 7.1 Daily Streak (DONE)

- Streak increments when the player logs in and plays at least one completed run that day (or presses Start; define clearly).
- If day is missed: streak resets to 0.
- At streak **5+**, player earns **1 Dolphin per day** (until cap).

### 7.2 Leaderboards (DONE)

- All-time leaderboard (top scores)
- Weekly leaderboard (resets weekly)
- Weekly reward:
    - **Weekly #1 gets 1 Dolphin** (DONE)

### 7.3 Weekly History (DONE / Displayed)

- Store top scores per week and show a history list (as in UI).

---

# 8) New Features to Add (Planned)

## 8.1 Tube Pieces (4×) — “Collect 4 to Complete”

**Player-facing summary:** Collect 4 tube pieces to assemble a tube and earn a bonus.

- **Spawn**: Tube pieces appear as collectibles during runs.
- **Collection**:
    - Each tube piece collected increments `tubePieces` (0–4).
    - On reaching 4: “Tube Completed!”
- **Persistence**: Tube pieces persist in a session.
- **UI**: show 4-segment meter near HUD or in a compact icon row.
- **Appearance:** when a player reached 1250 points

**Acceptance criteria**

- Tube meter updates immediately on pickup.
- Completion event triggers once per 4 pieces; counter resets to 0 after completion.
- Tube completion reward is applied exactly once per completion.

---

## 8.2 Golden Swordfish Pack (IAP $1)

**Player-facing summary:** Buy a premium Swordfish boost.

**Proposed behavior:**

- **A) “Golden Swordfish” = stronger boost**
    - Duration: +65% longer than normal.
- **Inventory**: Purchases grant `goldenSwordfishCount` (consumable). Purchased packs can be saved in the account. but it can be used only once a game.
- A player can use it by two fingers tap or pressing space bar and up arrow together.

**Acceptance criteria**

- Purchase grants item reliably and persists.
- Item can be activated from pre-run UI or auto-triggered at run start.
- Does not directly add score.

---

## 8.3 Golden Oxygen (IAP $1.25)

**Player-facing summary:** Premium oxygen behavior.

**Design options:**

- **Golden Oxygen Pack** (purchase)
    - starts with 45 seconds oxygen bar gauge
    - Does not exceed max
    - every oxygen pack adds 15 seconds in that game.
- **Inventory:** Purchased packs can be saved in the account. but it can be used only once a game.
    - before starting a game, a player can check a golden oxygen from inventory to choose to use it for the next game.

**Acceptance criteria**

- Clear visual differentiation (gold color, glow).
- Cannot be confused with normal oxygen pack.
- Effect stacking rules are defined (e.g., golden oxygen + swordfish).

---

## 8.4 Golden Tube

**Player-facing summary:** premium collectible version of tube mechanic.

Recommended use:

- **Cosmetic prestige**: Completing a tube has a small chance to become **Golden Tube** (or awarded via wheel).
- **Effect**:
    - No direct score (to avoid pay-to-win)
    - Unlocks skin or profile badge
    - Or grants coins

**Acceptance criteria**

- Golden Tube is tracked and displayed in profile/inventory.
- Golden Tube unlock condition is deterministic or clearly random with disclosed odds (wheel).

---

## 8.5 “Bring a Friend” Referral

**Player-facing summary:** Invite a friend; both get 1 tube piece.

- **Flow**
    1. Player generates an invite link with `refCode`.
    2. Friend opens link, signs up/logs in, and completes their first run.
    3. Reward triggers: both inviter and invitee get **+1 tube piece**.
- **Constraints**
    - One reward per new user.
    - Abuse prevention: device fingerprinting / rate limits / email verification (lightweight v0.1).

**Acceptance criteria**

- Reward triggers only once per invitee.
- Both accounts receive +1 tube piece even if inviter is offline.

---

## 8.6 Lottery Wheel

**Player-facing summary:** Spin for rewards (daily or earned spins).

- **Spin sources**
    - 1 free spin/day OR spin earned per N runs
- **Rewards pool (examples)**
    - Coins
    - Tube piece
    - Dolphin
    - Turtle shell
    - Golden oxygen
    - Skin fragments (future)
- **Odds**
    - Must be explicit in design docs and/or UI (recommended).
- **Cooldowns**
    - Daily free spin resets at UTC midnight (or local timezone; pick one).

**Acceptance criteria**

- Spin results are server-authoritative (not client).
- Outcome persists even if browser closes mid-animation.

---

## 8.7 Skins

**Player-facing summary:** Cosmetic submarine skins.

- **Unlock sources**
    - Coins shop
    - Wheel rewards
    - Golden tube achievements
- **Implementation**
    - Skin = sprite set + UI icon + rarity metadata
    - Equipped skin persists

**Acceptance criteria**

- Skin selection applies immediately next run.
- Skins never modify score or physics in v0.1 (cosmetic only).
- Some skins have abilities
    - Shark = eat 2 urchins
    - Colorful fish = invincible to quicksand
    - Cute purple whale =
    - Orca whale = 2x speed for 3sec
- Trails
    - Some skins have custom trails

---

## 8.8 Coins (Soft Currency)

**Player-facing summary:** Earn coins; spend on skins / convenience.

- **Earning**
    - Per run: based on distance or score brackets
    - Daily streak bonuses
    - Wheel rewards
- **Spending**
    - Skins
    - Optional: convert coins into tube piece (careful) / revive (careful)
- **Storage**
    - Server-side authoritative balance

**Acceptance criteria**

- Coin balance updates consistently across devices.
- No negative balances; transactions are atomic.

---

## 8.9 Increased Oxygen Bar “10×” (IAP $7–$8)

**Player-facing summary:** Bigger oxygen tank.

Proposed spec:

- **Upgrade**: Max Oxygen increases from **30s → 300s** (10×)
- **Price**: $7.99 (or A/B test $6.99–$8.99)
- **Behavior**
    - Oxygen packs still add +10s (or optionally +20s after upgrade; choose one)
    - Cap = 300s

**Acceptance criteria**

- Upgrade is permanent and tied to account.
- Restores on login (and via store purchase restore).

---

## 8.10 PvP Race (Optional) + “Betting”

This is high-risk if it implies real-money gambling. For v0.1, define it as **virtual coin wagering only** with no cash-out.

**Recommended v0.1 scope: Asynchronous “Ghost Race”**

- Player races against a recorded run (ghost) of another player.
- Wager uses **coins only**:
    - Player stakes X coins; opponent ghost stakes none (system sink/source) OR matched stakes if you have real opponent queueing.
- Outcome:
    - Winner gets: `stake * (1 - fee)` (e.g., 90%), fee = 10% sink.

**Acceptance criteria**

- Clearly labeled “virtual coins only.”
- No token/fiat conversion.
- Age gate / region gate can be added later if needed.

---

# 9) UI/UX Requirements (v0.1)

### Current screens (existing)

- Title screen:
    - Instructions
    - Streak panel
    - Leaderboard + weekly history
    - Login/logout

### Add screens (planned)

- **Profile / Inventory**
    - Dolphins (0–5)
    - Turtle shells (0–cap)
    - Tube pieces (0–4)
    - Golden items counts
- **Shop**
    - IAP: Golden Swordfish ($1)
    - IAP: Oxygen Tank Upgrade ($7–$8)
    - Coin purchases (optional later)
- **Wheel**
    - Spin animation + reward reveal
- **Invite**
    - Share link + “friend joined” status
- **Skins**
    - Browse + equip + locked/unlocked view

---

# 10) Data Model (Minimal, v0.1)

### Player

- `playerId`
- `displayName`
- `createdAt`
- `lastLoginAt`

### Progress / Inventory

- `oxygenUpgrade` (bool)
- `coins` (int)
- `dolphins` (0–5)
- `turtleShells` (0–cap)
- `tubePieces` (0–4)
- `goldenSwordfish` (int)
- `goldenOxygen` (int)
- `goldenTubes` (int)
- `equippedSkinId`

### Streak

- `streakCount` (int)
- `lastStreakDate` (YYYY-MM-DD)
- `streakRewardClaimedDate` (YYYY-MM-DD)

### Scores

- `bestScoreAllTime`
- `weeklyScore` (per week key)
- `weeklyRank` (cached)

### Wheel

- `lastFreeSpinAt`
- `spinsAvailable`

---

# 11) Backend/API Requirements (Suggested)

- `POST /run/submit` (score, runStats, checksum)
- `GET /leaderboard/alltime`
- `GET /leaderboard/weekly`
- `POST /streak/claim` (or implicit on submit)
- `POST /wheel/spin`
- `POST /invite/create`
- `POST /invite/redeem`
- `POST /shop/purchase/confirm` (IAP verification)
- `GET /inventory`

**Server-authoritative** decisions:

- Leaderboard writes
- Wheel outcomes
- Referral redemption
- Purchase grants
- Weekly resets

---

# 12) Anti-Cheat (v0.1 Practical)

Client-side runner games are easy to tamper with; implement lightweight mitigations:

- Server validates score against max plausible distance/time.
- Send run duration + oxygen usage stats + event counts (pickups/hazards) and sanity-check.
- Rate-limit submissions per account/IP.
- For top leaderboard entries, optionally require a “verified run” mode later.

---

# 13) To-Do List (Unimplemented) — v0.1 Roadmap

## P0 — Core Progression & Collectibles

1. **Tube Pieces system (4× → completion → +2000 points)**
    - HUD meter + persistence + completion logic
2. **Inventory screen**
    - Show dolphins, shells, tube pieces, golden items
3. **Referral: bring-a-friend**
    - Invite link + redemption + both +1 tube piece

## P1 — Monetization Foundation

1. **IAP: Golden Swordfish Pack ($1)**
    - Purchase verification + consumable inventory + activation
2. **IAP: Oxygen Bar 10× upgrade ($7–$8)**
    - Permanent entitlement + restore purchases

## P2 — Retention Systems

1. **Lottery Wheel**
    - Daily spin + server-side outcome + reward grants
2. **Coins economy**
    - Earn rules + spend rules + transaction ledger

## P3 — Cosmetics

1. **Skins**
    - Cosmetic-only + shop unlock + equip UI
2. **Golden Oxygen / Golden Tube**
    - Define acquisition sources (wheel, rare drop, purchase) + effects + display

## P4 — Competitive Expansion

1. **PvP Race (ghost) + coin-only wager**
- Matchmaking/ghost selection + stake resolution + fee sink
- Explicitly no real-money or cash-out mechanics in v0.1

---

# 14) Open Decisions (Make These Explicit Before Coding)

- Swordfish duration (seconds vs distance).
- Do oxygen packs add beyond max oxygen? (recommended: no, unless upgraded)
- Turtle shell inventory cap (recommended: 5 or 10).
- Tube piece spawn rate and whether duplicates can appear back-to-back.
- Coin earning formula (distance-based vs score-based).
- Wheel odds and whether odds are displayed.
- Whether golden items can ever affect score (recommended: avoid in v0.1).

---

If you want, I can also output this as a **single JSON spec** (systems + parameters + reward tables) that a coding agent can ingest directly, including default values for every “Open Decision.”