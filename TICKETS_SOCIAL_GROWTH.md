### Ticket set: Social Growth + Auth + Missions
These tickets are designed to be implemented incrementally. Each ticket should be independently testable.

---

## Ticket 1 — Add Auth entry in MENU (pre-run login/signup)
**Goal**
- Users can **sign up / log in before starting** (MENU overlay), not only after game over.

**Scope**
- UI: add a “Log in” button (and optional “Streak”, “Inbox” placeholders).
- Auth modal: reuse across MENU / INPUT_NAME / GAME_OVER.

**Acceptance Criteria**
- MENU screen shows a **Log in** button.
- Clicking opens modal with **Login ID / Password / Display Name(optional)** and actions.
- Users can close modal and still start the game.

**Dependencies**
- Ticket 2 (Auth API) for full end-to-end, but UI can be shipped with mocked state first.

**Related files**
- `src/components/UIOverlays.tsx` (Menu overlay)
- `src/Game.tsx` (wiring modal visibility/state)

---

## Ticket 2 — Server-side auth (register/login/logout/me) with Redis + hashed password
**Goal**
- Store credentials in Redis securely; server-only verification.

**API**
- `POST /api/auth/register` → sets `httpOnly` cookie
- `POST /api/auth/login` → sets cookie
- `POST /api/auth/logout` → clears cookie
- `GET /api/auth/me` → returns `{ userId, displayName, refCode }`

**Security**
- Hash password with Node `crypto.scrypt` + per-user salt.
- Rate limit endpoints.
- Generic error messages to avoid user enumeration.

**Acceptance Criteria**
- Password is never stored in plaintext.
- Register then login works; session persists via cookie.
- `me` returns user identity when logged in.

**Related files**
- `api/auth/register.ts` (CREATE)
- `api/auth/login.ts` (CREATE)
- `api/auth/logout.ts` (CREATE)
- `api/auth/me.ts` (CREATE)
- `api/_lib/auth.ts` (CREATE helper for hashing + session)

---

## Ticket 3 — Tie leaderboard submission to account identity (optional guest mode)
**Goal**
- Keep leaderboard display name, but optionally require login for submitting scores.

**Behavior**
- If not logged in:
  - Show auth modal in INPUT_NAME and/or GAME_OVER when user tries to submit.
- If logged in:
  - Submit score includes userId server-side (not trusted from client).

**Acceptance Criteria**
- Logged-in users can submit and appear on leaderboard with displayName.
- Guests can still view leaderboard; submission behavior matches decided policy.

**Dependencies**
- Ticket 2

**Related files**
- `api/leaderboard.ts` (TO_MODIFY)
- `src/Game.tsx` (TO_MODIFY submit flow)
- `src/api.ts` (TO_MODIFY: auth endpoints + credentials include)

---

## Ticket 4 — Daily missions (server-side state) + Daily streak panel
**Goal**
- Add “3 daily missions” + streak tracking UI.

**Missions (starter)**
- Reach 800 points
- Play 3 runs
- Collect 3 oxygen tanks
… (from `SOCIAL_GROWTH_PLAN.md`)

**Data model (Redis)**
- `sd:missions:daily:<yyyy-mm-dd>` → mission definitions (global)
- `sd:user:<userId>:daily:<yyyy-mm-dd>` → progress + completion
- `sd:user:<userId>:streak` → current streak metadata

**API**
- `GET /api/missions/daily`
- `POST /api/missions/event` (run_end, oxygen_collected, etc.)

**UI**
- MENU: add **Streak** button → opens panel showing:
  - current streak
  - today’s missions + progress
  - next milestone reward preview

**Acceptance Criteria**
- Logged-in user sees today’s missions and progress persists across sessions.
- Completing any one daily mission marks today as “kept” and increments streak rules.

**Dependencies**
- Ticket 2 (identity)

**Related files**
- `api/missions/daily.ts` (CREATE)
- `api/missions/event.ts` (CREATE)
- `src/components/UIOverlays.tsx` (TO_MODIFY)
- `src/Game.tsx` (TO_MODIFY: emit mission events)

---

## Ticket 5 — Challenge system: inbox + provocative challenge cards
**Goal**
- Support friend challenges with a compelling “taunt” UX.

**Flow**
- Sender generates a share link `/?challenge=<score>&from=<userId>` (optional `challengeId`)
- Receiver opens link:
  - server creates a challenge record for their account (or stores pending until login)
- MENU shows **Inbox** button with badge count.
- Inbox card copy example:
  - “<FriendName> thinks you can’t beat 8,274. Prove them wrong.”

**Data model (Redis)**
- `sd:challenge:<challengeId>` → `{ fromUserId, toUserId?, targetScore, createdAt, status }`
- `sd:user:<userId>:inbox` → list of challengeIds (or JSON array)
- `sd:pendingChallenge:<sessionToken>` → challenge payload (if not logged in yet)

**Acceptance Criteria**
- Challenge link can be created and opened.
- Logged-in receiver sees it in Inbox and can “Accept” to start a run with target pinned.

**Dependencies**
- Ticket 2 (identity) recommended

**Related files**
- `src/Game.tsx` (TO_MODIFY: read URL params, start challenge run)
- `src/components/UIOverlays.tsx` (TO_MODIFY: inbox UI)
- `api/challenge/create.ts` (CREATE) (optional if we create challenge ids server-side)
- `api/challenge/inbox.ts` (CREATE)
- `api/challenge/accept.ts` (CREATE)


