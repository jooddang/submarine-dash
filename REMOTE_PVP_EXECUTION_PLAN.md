# Remote PvP Execution Plan

## Status

CTO-level delivery plan for shipping online PvP without regressing the existing game.

This document sits on top of:

- [REMOTE_PVP_ARCHITECTURE.md](/Users/jooddang/Documents/submarine-dash/REMOTE_PVP_ARCHITECTURE.md)
- [REMOTE_PVP_PROTOCOL_SPEC.md](/Users/jooddang/Documents/submarine-dash/REMOTE_PVP_PROTOCOL_SPEC.md)

## Executive Direction

We should build online PvP, but only on a sequence that protects the shipped game:

1. extract deterministic `pvp-core`
2. validate it in local PvP first
3. build online room/presence/invite on top of that
4. introduce authority and escrow last

Do not begin with the gateway.
Do not begin with betting.
Do not try to retrofit the current local `PvpLobby` and `PvpGame` directly into a network stack.

The critical path is deterministic simulation extraction. Everything else depends on it.

## Product Boundary

### Release target

First release of online PvP includes:

- invite-driven 1v1 rooms
- online lobby presence
- direct invite notifications
- ready-check
- synchronized online match start
- server-authoritative result
- reconnect grace window

### Not in first release

- public matchmaking queue
- ranked ladder
- spectators
- tournaments
- cross-region routing
- reusing current `/api/pvp/settle-bet`

## Non-Negotiable Constraints

- Single-player must remain fully functional throughout development.
- Same-device PvP must remain fully functional throughout development.
- New online code must be additive and isolated.
- Room lifecycle must be gateway-owned.
- Match result must be authority-owned.
- Betting must be escrowed and idempotent.

## Strategic Sequencing

### Why `pvp-core` comes first

- current PvP logic is closest to reusable value
- online authority is impossible to trust without deterministic replay
- ghost race also benefits from the same extraction
- extracting core first de-risks both online PvP and future anti-cheat

### Why gateway comes before authority hardening

- presence, rooms, invites, and ready-check are product-visible and easier to validate
- they can be tested before live in-match authority exists
- the room stack is a dependency for all higher-level UX

### Why escrow comes after authoritative match

- betting without authoritative outcome invites disputes and exploits
- escrow complexity should not block deterministic core extraction

## Delivery Phases

## Phase 1: Deterministic Core Extraction

### Objective

Create a shared `pvp-core` that local PvP can run on without visible gameplay regression.

### Scope

- fixed-tick deterministic sim
- canonical simulation dimensions
- removal of render-owned state from authoritative state
- removal of audio side effects from simulation
- checksum and replay harness

### Success criteria

- same seed + same input log => same terminal checksum every run
- local PvP remains visually and mechanically equivalent
- current local modes still work:
  - earned
  - inventory
  - none
  - score attack

### Exit gate

Do not start live authority work until replay tests are green.

## Phase 2: Online Shell and Bootstrap

### Objective

Add the user-visible online entry path without live matches yet.

### Scope

- online PvP menu entry
- `GET /api/pvp-online/bootstrap`
- `POST /api/pvp-online/ws-ticket`
- inbox REST
- placeholder online lobby screen

### Success criteria

- authenticated user can enter online lobby screen
- unread invite/result badge is supported without breaking the current menu
- no effect on single-player or local PvP

### Exit gate

Do not build room UI against ad hoc client state; room UI must speak the protocol spec.

## Phase 3: Realtime Room System

### Objective

Ship presence, invites, room lifecycle, and ready-check through the gateway.

### Scope

- lobby presence
- scoped lobby-entry notifications
- room create/cancel
- invite create/accept/decline/expire
- room snapshots
- ready-check and lock

### Success criteria

- two users can discover each other
- host can invite guest
- guest can accept
- both can ready up
- room locking is versioned and idempotent

### Exit gate

Do not connect room lock to a match start until rollback on failure is proven.

## Phase 4: Authoritative Match Start and Live Play

### Objective

Use the shared deterministic core for real online matches.

### Scope

- authority runner
- `match.starting`
- input relay
- periodic digests
- correction path
- reconnect grace window
- result finalization

### Success criteria

- two browsers can complete a real online match
- authoritative replay matches official result
- disconnects are handled predictably

### Exit gate

Do not enable betting until result ownership is fully server-side.

## Phase 5: Escrow Betting and Hardening

### Objective

Make online betting safe enough for real users.

### Scope

- escrow hold/finalize/refund
- inbox result notifications
- inventory snapshot at room lock
- ledger events
- operational logging and alerting

### Success criteria

- no double-settlement
- refund-on-failed-start works exactly once
- online inventory mode uses match snapshot, not live Redis reads per action

## Team Topology

Recommended minimum staffing:

- 1 gameplay engineer
  - owns `pvp-core`, replay harness, local PvP adapter
- 1 realtime/backend engineer
  - owns gateway, room lifecycle, presence, reconnect
- 1 full-stack/product engineer
  - owns online lobby UI, room UI, inbox UX, bootstrap wiring

If only one engineer is available:

- still follow the same phase order
- do not attempt gateway and authority at the same time

## Ownership Boundaries

### Gameplay owner

- `src/pvp-core/*`
- local PvP adapter layer
- checksum and replay tests
- authority simulation package

### Backend owner

- `api/pvp-online/*`
- `api/_lib/pvpOnline*.ts`
- gateway service
- escrow implementation
- Redis transaction correctness

### Frontend owner

- `src/pvp-online/*`
- menu entry
- room lobby UX
- inbox surfaces
- reconnect UX states

## Risks and Mitigations

### Risk 1: Simulation extraction subtly changes local PvP feel

Mitigation:

- golden replay fixtures
- side-by-side old/new terminal outcome comparison
- keep constants stable until replay is proven

### Risk 2: Gateway is introduced before deterministic core is reliable

Mitigation:

- hard gate: no live online play until replay harness exists

### Risk 3: Betting ships before authoritative results are trustworthy

Mitigation:

- hard gate: no online betting until authority result ownership and escrow idempotency are proven

### Risk 4: Online mode contaminates existing flows

Mitigation:

- separate modules
- separate app modes
- additive menu entry
- no shared mutable UI state with local PvP

### Risk 5: Operational complexity grows too fast

Mitigation:

- first release is invite-only
- no ranked queue
- no public rooms
- one gateway service before any multi-service split

## Go / No-Go Gates

### Gate A: Core readiness

Go only if:

- deterministic replay tests pass
- local PvP unchanged in manual QA

### Gate B: Room readiness

Go only if:

- invite accept is idempotent
- room version conflicts are handled cleanly
- reconnect restores room snapshot

### Gate C: Live match readiness

Go only if:

- authoritative runner reproduces the same result as client replay
- correction path works under induced latency

### Gate D: Betting readiness

Go only if:

- escrow finalize/refund are mutually exclusive
- disconnect/cancel flows refund correctly

## Manual QA Matrix

### Existing regression

- start single-player run
- submit leaderboard score
- use inventory and skins
- start local PvP from existing menu
- play all local PvP power-up modes
- settle same-device bet

### Online feature QA

- enter/leave online lobby
- send invite
- accept invite
- decline invite
- invite expiry
- host cancel
- guest leave before lock
- ready toggle reset after config change
- reconnect in room
- reconnect during match
- disconnect forfeit
- inbox unread count updates

## Recommended Feature Flags

- `online_pvp_ui`
- `online_pvp_gateway`
- `online_pvp_matches`
- `online_pvp_betting`

Rollout rule:

- enable in that order only

## What We Should Not Do

- do not rewrite local PvP from scratch
- do not add betting first
- do not overload `/api/auth/me` for online bootstrap
- do not store every presence event as durable inbox history
- do not let clients declare winners or trigger settlement directly

## Immediate Next Actions

1. Start Phase 1 and create `pvp-core`.
2. Add deterministic replay tests before any gateway work.
3. Keep local PvP on top of the extracted core until parity is proven.
4. Only then start online bootstrap and room lifecycle work.

This is the highest-confidence path to online PvP that behaves like a disciplined product team, not a gamble.
