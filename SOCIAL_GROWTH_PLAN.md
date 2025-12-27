### Goal
Make **Deep Dive Dash** more social to improve:
- **UA** (user acquisition): referrals + sharing loops
- **Retention**: recurring goals, competition, identity/progression

This doc proposes a **phased plan (lowest effort → highest impact)** and includes a **simple login system** required for keep-track/referrals.

References:
- Profanity list library (EN): `@coffeeandfun/google-profanity-words` ([repo](https://github.com/coffee-and-fun/google-profanity-words))
- Upstash Redis REST API conceptually used via HTTP clients in serverless ([docs](https://upstash.com/docs/redis/features/restapi))

---

### Non-goals (for now)
- Real-time multiplayer
- OAuth / social login (Google, Apple, etc.)
- Client-side moderation (all validation must be server-side)

---

### Key Product Loops
#### Viral / UA loop
Play → get a shareable “moment” → friend opens link → friend plays → friend shares

#### Retention loop
Daily/weekly goal → “just one more run” → progress/reward → compare with friends → repeat

---

### Priority Roadmap (Phases)
#### Phase 0 — Measurement & safety (minimum foundation)
- **Add event tracking** (anonymous): session start, run end, submit attempt, share click, referral accept.
- **Rate limits** on API endpoints (per IP + per session).
- **Profanity + safety**: keep server-side name sanitation (already in place); reduce false positives by token-based checks.

Acceptance:
- We can compute: D1 retention proxy, share CTR, submit conversion, referral conversion.

#### Phase 1 — “Identity” (Simple Login) + “Keep Track”
Add a lightweight account system so we can tie progress/referrals to a user.

**UX entry points**
- **Before starting a run (MENU)**:
  - Add a **Log in** button on the start screen so users can sign up / log in without finishing a run first.
- **After a run ends**:
  - When we show **Name entry overlay** (qualified high score), OR
  - When we show **Game-over leaderboard overlay** (not qualified / didn’t submit)
- In all entry points, show a compact modal:
  - **Name** (still used for leaderboard display; sanitized)
  - **Login ID**
  - **Password**
  - Buttons: **Sign up / Log in / Continue as Guest**

**Behavior**
- If user chooses **Guest**, they can still play and see leaderboard.
- To **submit a score**, require auth (recommended). Alternative: allow guest submit but no referral/progression credit.
- If auth succeeds:
  - store/refresh session cookie
  - allow score submit with userId attached server-side

**Data model (Redis)**
Keys (namespacing example `sd:`):
- `sd:user:<userId>` → JSON
  - `{ userId, loginId, passwordHash, passwordSalt, createdAt, displayName, refCode, referredBy?, stats? }`
- `sd:loginId:<loginIdLower>` → `userId` (for lookup)
- `sd:session:<sessionToken>` → `userId` (TTL e.g. 30 days)

**Password storage (must)**
- Never store plaintext.
- Use **Node built-in `crypto.scrypt`** (or PBKDF2) with:
  - per-user random salt
  - constant-time compare (`timingSafeEqual`)
  - store: `{ salt, hash, paramsVersion }`
Why `crypto.scrypt`: no native addon dependency, good default in serverless.

**Auth API (Vercel /api)**
- `POST /api/auth/register`
  - input: `{ loginId, password, displayName }`
  - validate: length/charset, rate limit, unique `loginId`
  - store hashed password + `refCode`
  - set httpOnly cookie `sd_session=<token>`
- `POST /api/auth/login`
  - input: `{ loginId, password }`
  - verify hash
  - set cookie
- `POST /api/auth/logout` (clears cookie + deletes session key)
- `GET /api/auth/me` (returns `{ userId, displayName, refCode }`)

Security notes:
- Prevent user enumeration: return generic error for wrong login/password.
- Rate limit login/register aggressively.
- Store cookie as `httpOnly; secure; sameSite=Lax`.

Acceptance:
- A user can create account, log in/out, and submit score tied to their account.

#### Phase 2 — Referral loop (deep-link + double-sided reward)
**Mechanic**
- Each user has a `refCode` (short, URL-safe).
- Share URL like: `/?ref=<refCode>`
- On landing:
  - store `pendingRefCode` in cookie/localStorage (server should not trust client blindly)
- On **first successful registration**:
  - write `referredBy=<inviterUserId>`
  - award: inviter + invitee (double-sided)

**Anti-fraud constraints**
- Only reward when invitee hits a meaningful milestone:
  - e.g. first score submit OR score >= N
- One reward per device/session fingerprint (lightweight)
- Per-inviter daily cap

**Data model**
- `sd:refCode:<code>` → `userId`
- `sd:referral:<inviterUserId>` → counters / recent rewards
- `sd:pendingRef:<sessionToken>` → `refCode` (short TTL)

Acceptance:
- Referral link creates measurable conversions and grants rewards with basic abuse prevention.

#### Phase 3 — Social competition (low-cost, high-retention)
- **Friend leaderboard** (within referral graph or “party code” rooms)
- **Challenges**: “Beat my score” link `/?challenge=<score>&from=<userId>`
- **Weekly reset leaderboard** (seasonal competition)

**Challenge UX (must feel provocative)**
- Add a **Challenge Inbox** entry point in MENU (and optionally Game Over) with a badge count.
- When a challenge is received, show a card:
  - “**<FriendName> thinks you can’t beat 8,274. Prove them wrong.**”
  - CTA: **Accept challenge** → starts a run with target score pinned in HUD
  - Secondary: **Send one back** (creates a new challenge link)
- Challenge link contains: `?challenge=<targetScore>&from=<userId>` (plus optional `challengeId`)

Acceptance:
- Users can compete in a smaller social context (higher motivation than global top-5).

#### Phase 4 — Retention content
- **Daily missions + streak**
- **Cosmetic progression** (titles/skins unlocked via missions + referrals)
- **Community goal** (global milestone events)

**Concrete Missions (initial set)**
- Daily (3 shown each day; refresh daily):
  - **Reach 800 points** (reward: `Booster: +10% score for 1 run`)
  - **Play 3 runs** (reward: `Cosmetic: Bubble Trail (common)`)
  - **Collect 3 oxygen tanks** (reward: `Title: “Air Breather”`)
  - **Survive 45 seconds** (reward: `Booster: Extra Oxygen +10s (1 run)`)
  - **Defeat 1 urchin with swordfish** (reward: `Cosmetic: Golden Name Glow (1 day)`)
- Weekly (2–3 active; refresh weekly):
  - **Score 5,000+ once** (reward: `Cosmetic: Submarine Skin (rare)`)
  - **Play 25 runs this week** (reward: `Title: “Deep Diver”`)
  - **Invite 1 friend who submits a score** (reward: `Booster pack (3 runs)`)

**Rewards catalog (starter)**
- Boosters (consumable, 1 run):
  - `score_boost_10` (+10% score)
  - `oxygen_bonus_10s` (+10 seconds oxygen)
  - `retry_token` (one free continue; optional)
- Cosmetics (non-consumable):
  - `trail_bubbles_common`
  - `skin_submarine_rare`
  - `name_glow_gold` (can be time-limited if desired)
- Titles:
  - `Air Breather`
  - `Deep Diver`

**Daily streak UI (must)**
- Add a **Streak** button in MENU (and/or HUD) that opens a small panel:
  - current streak count (days)
  - today’s mission completion status
  - next streak milestone rewards (e.g. day 3/7/14)
- Streak rules:
  - Completing **any 1 daily mission** marks the day as “kept”
  - Allow 1 “grace day” token per 7 days (optional; reduces churn from missed day)

Acceptance:
- D7 retention improves; missions completion rate measurable.

---

### Implementation Notes (Engineering)
#### Storage format
Current leaderboard is a JSON array in one key. For more social features, consider migrating to:
- **ZSET leaderboard** for ranking (score-based)
- separate user profile storage (already planned above)

But migration can be phased:
- Keep current JSON leaderboard short-term
- Introduce new keys for auth/referrals without breaking existing leaderboard

#### Minimal UI changes
- Add a small **AuthModal** component that can be shown from:
  - Name entry overlay (high score)
  - Game over overlay (no score submit)
- Store session state in memory; rely on cookie for persistence.

---

### Open Questions (decisions needed)
- **Should guests be allowed to submit scores?**
  - Recommendation: allow play + view, but require login to submit.
- **Login ID constraints**: allow email-like? or simple username?
- **Rewards**: what’s the initial reward catalog (cosmetics vs boosters)?


