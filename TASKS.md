# Deep Dive Dash — Task Tracker

> **Last updated**: 2026-02-18

---

## Prerequisites (Pre-Coding Gate)

| # | Task | Status | Notes |
|---|------|--------|-------|
| 0.1 | Create `PROJECT.md` | ✅ | Project overview, business design, domain terms |
| 0.2 | Create `TECH_STACK.md` | ✅ | Tech stack, versions, environment setup |
| 0.3 | Create `ARCHITECTURE.md` | ✅ | Directory structure, layer rules, file placement |

---

## P0 — Core Progression & Economy

| # | Task | Status | Notes |
|---|------|--------|-------|
| 1.1 | Design coin earning formula | ✅ | Score-bracket: 0-199→0, 200-499→5, 500-999→10, 1000-1999→20, 2000-2999→35, 3000-4999→50, 5000+→75 |
| 1.2 | Coin data model (Redis) | ✅ | `sd:user:{id}:coins` (INCRBY), `sd:user:{id}:coin:ledger` (list, capped 100) |
| 1.3 | Coin API endpoints | ✅ | Earned via `run_end` in `/api/missions/event`, balance in `/api/auth/me` |
| 1.4 | Coin HUD display | ✅ | Menu: next to login status. Game Over: "+N coins (total: M)" |
| 1.5 | Inventory / Profile screen UI | ☐ | Dolphins, tubes, coins, skins, golden items |
| 1.6 | Tube piece server-side persistence | ☐ | Move from `sessionStorage` to Redis for logged-in users |
| 1.7 | Tube piece API endpoints | ☐ | GET/POST tube piece progress |

---

## P1 — Monetization Foundation

| # | Task | Status | Notes |
|---|------|--------|-------|
| 2.1 | Golden Swordfish Pack design | ☐ | +65% duration, consumable inventory |
| 2.2 | Golden Swordfish backend + frontend | ☐ | Purchase, store, activate (two-finger tap / Space+Up) |
| 2.3 | Golden Oxygen design | ☐ | 45s start, +15s per tank, pre-run toggle |
| 2.4 | Golden Oxygen backend + frontend | ☐ | Purchase, store, toggle |
| 2.5 | Increased Oxygen Bar (permanent) | ☐ | 30s→300s upgrade, account-tied |
| 2.6 | Shop screen UI | ☐ | Purchase flow for all IAP items |

---

## P2 — Retention Systems

| # | Task | Status | Notes |
|---|------|--------|-------|
| 3.1 | Lottery Wheel — design + odds | ☐ | Reward pool, transparency |
| 3.2 | Lottery Wheel — backend | ☐ | Server-authoritative spin, daily free spin |
| 3.3 | Lottery Wheel — frontend + animation | ☐ | Spin UI, reward reveal |
| 3.4 | Referral system — backend | ☐ | Wire `refCode`, tracking, double-sided reward |
| 3.5 | Referral system — frontend | ☐ | Share URL, invite UI, reward notification |
| 3.6 | Challenge system — backend | ☐ | Challenge records, inbox API |
| 3.7 | Challenge system — frontend | ☐ | Inbox UI, accept flow, HUD target score |

---

## P3 — Cosmetics

| # | Task | Status | Notes |
|---|------|--------|-------|
| 4.1 | Skins data model + backend | ☐ | Sprite sets, rarity, unlock tracking |
| 4.2 | Skins UI — equip + preview | ☐ | Skin selection screen |
| 4.3 | Skins rendering in game | ☐ | Replace default submarine sprite |
| 4.4 | Golden Tube mechanic | ☐ | Prestige tube variant |
| 4.5 | Custom trail effects | ☐ | Per-skin trail rendering |

---

## P4 — Competitive

| # | Task | Status | Notes |
|---|------|--------|-------|
| 5.1 | Ghost run recording system | ☐ | Record + replay input sequences |
| 5.2 | PvP Ghost Race — matchmaking | ☐ | Async race, coin wager |
| 5.3 | PvP Ghost Race — UI | ☐ | Split/overlay view, result screen |

---

## Infrastructure / Quality

| # | Task | Status | Notes |
|---|------|--------|-------|
| 6.1 | Anti-cheat (server-side score validation) | ☐ | Plausibility checks, rate limits |
| 6.2 | Background music | ☐ | Looping BGM track |
| 6.3 | Settings / Options screen | ☐ | Volume, pause, controls |
| 6.4 | Dolphin saved cap | ☐ | Hard cap (5 recommended) |
| 6.5 | Tutorial / Onboarding | ☐ | Interactive first-run guide |
