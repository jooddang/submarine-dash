# Remote PvP Architecture

## Status

Draft technical design for adding online remote PvP without breaking existing same-device PvP or single-player gameplay.

## Goals

- Add online 1v1 PvP where players can:
  - enter an online PvP lobby
  - see who else is available
  - receive notifications when relevant players enter the lobby
  - create a room
  - invite a specific player into that room
  - mark themselves ready
  - start a synchronized match
- Preserve current local PvP as a separate mode.
- Preserve current single-player behavior and data models.
- Reuse the current deterministic PvP simulation where safe.
- Make the online winner and bet settlement server-authoritative.

## Non-Goals

- Replacing the shipped same-device PvP flow.
- Rewriting the single-player game loop.
- Building large-scale matchmaking or ranked ladders in the first release.
- Spectator mode, tournaments, or multi-region routing.
- Trusting clients for winner declaration, room state, or bet settlement.

## Existing Constraints

- Frontend: React 19, Canvas rendering, `src/pvp/` local PvP module.
- Backend: Vercel serverless functions plus Express dev server mirror.
- Persistent store: Redis.
- Current auth model: session cookie backed by Redis.
- Current PvP code is deterministic-oriented but not fully network-ready:
  - simulation lives in `src/pvp/pvpGameLogic.ts`
  - world generation lives in `src/pvp/pvpWorld.ts`
  - local orchestration lives in `src/pvp/PvpGame.tsx`
  - current bet settlement is post-match and not escrow-based

## Architectural Decision Summary

### ADR-RPVP-001: Keep local PvP intact and add online PvP beside it

- Decision: online PvP is a new vertical slice, not a rewrite of current `src/pvp/`.
- Reason:
  - local PvP is already shipped
  - remote PvP introduces presence, invite, reconnect, authority, and latency concerns absent from local mode
  - isolating online code reduces regression risk

### ADR-RPVP-002: Use a dedicated realtime gateway

- Decision: use a stateful WebSocket gateway for presence, room lifecycle, invite delivery, ready state, and live match coordination.
- Reason:
  - Vercel serverless is a poor fit for durable bidirectional realtime sessions
  - lobby presence and room state need low-latency fanout and connection-aware cleanup

### ADR-RPVP-003: Use server-authoritative deterministic simulation

- Decision: clients predict locally, but an authoritative match runner decides the official state and result.
- Reason:
  - current game already fits deterministic input-driven simulation
  - prevents basic client cheating
  - allows reconnect and replay validation

### ADR-RPVP-004: Escrow bets before match start

- Decision: bettable assets are reserved before countdown, then either finalized to the winner or refunded.
- Reason:
  - post-match transfer based on mutable balances is race-prone
  - online matches need idempotent failure handling

## High-Level Topology

```text
[Browser Client]
  |- Single-player
  |- Local PvP
  `- Online PvP Client
         |
         |- HTTPS -> [Existing API Layer on Vercel]
         |            |- auth
         |            |- profile / inventory
         |            |- inbox history
         |            `- room list snapshots / match history
         |
         `- WebSocket -> [Realtime Gateway]
                        |- presence service
                        |- invite service
                        |- room coordinator
                        |- match session coordinator
                        `- reconnect/session recovery
                                  |
                                  v
                           [Match Authority Worker]
                                  |
                                  v
                                [Redis]
```

## Bounded Contexts

### 1. Presence

- Tracks whether a user is:
  - offline
  - online but not in PvP
  - in the PvP lobby
  - in a room
  - in a live match
- Drives lobby list visibility and lobby-enter notifications.

### 2. Invite

- Lets a room owner invite a specific player.
- Handles accept, decline, expire, cancel.
- Produces realtime toasts plus durable inbox entries.

### 3. Room

- Owns pre-match configuration.
- Owns readiness.
- Locks before match creation.
- Handles disconnects before the match starts.

### 4. Match

- Creates server-issued seed and start tick.
- Runs deterministic simulation from input streams.
- Emits periodic state digests.
- Finalizes winner and triggers bet settlement.

### 5. Inbox / Notification

- Stores durable user-facing events:
  - incoming invite
  - invite expired while offline
  - match canceled
  - match result
- Realtime delivery is best effort; inbox is the durable fallback.

## Isolation and Non-Regression Strategy

Online mode must not change the behavior of:

- single-player flow in `src/Game.tsx`
- local PvP flow in `src/pvp/PvpLobby.tsx` and `src/pvp/PvpGame.tsx`
- existing auth/session flow
- leaderboard submission rules

### Codebase isolation rules

- Keep current `src/pvp/` for local PvP.
- Add new online modules under:
  - `src/pvp-online/`
  - `api/pvp-online/` for REST endpoints
  - `api/_lib/pvpOnline*.ts` for shared helpers
- Extract only simulation-safe primitives from local PvP into shared deterministic modules.
- Do not route existing local PvP users through the online stack.

### Required refactor before live online play

The following is mandatory before using the simulation remotely:

1. Remove side effects from deterministic core.
   - `playSound(...)` calls must move out of `pvpGameLogic.ts`.
   - Simulation should emit events like `jump`, `oxygen_pickup`, `death_urchin` instead.
2. Remove real-time sources from deterministic state evolution.
   - no `Date.now()` inside match simulation
   - no `performance.now()` inside authoritative game logic
3. Make generated IDs deterministic or explicitly cosmetic-only.
   - background entity IDs should be sequence-based, not time-based
4. Add checksum support.
   - state digest must be derivable from authoritative state at fixed intervals

These changes should be done in a shared deterministic layer without changing visible local PvP behavior.

## Proposed Frontend Structure

```text
src/
  pvp/
    ... existing local PvP unchanged
  pvp-core/
    deterministicTypes.ts
    deterministicWorld.ts
    deterministicSimulation.ts
    deterministicEvents.ts
    checksum.ts
  pvp-online/
    OnlinePvpLobby.tsx
    OnlinePvpRoom.tsx
    OnlinePvpMatch.tsx
    onlinePvpClient.ts
    onlinePvpTypes.ts
    onlinePvpStore.ts
    reconnect.ts
```

### Screen-level flow

- Menu
  - `PVP MODE`
  - `ONLINE PVP`
- `ONLINE PVP` opens the online lobby, not the local lobby.
- Local PvP and online PvP stay as separate app modes.

### Recommended new app modes

- `pvp_online_lobby`
- `pvp_online_room`
- `pvp_online_match`
- `pvp_online_match_result`

## Proposed Backend Structure

### Existing Vercel API

Use for:

- auth and session bootstrap
- inventory reads
- inbox read API
- historical room and match metadata
- fallback room snapshot reads

### New Realtime Gateway

Responsibilities:

- authenticate websocket connection
- maintain connection registry
- maintain transient presence
- deliver realtime invites
- manage room state transitions
- coordinate countdown and match start
- forward player input frames to authority
- forward authoritative digests and result events
- handle reconnect and stale connection cleanup

### Match Authority Worker

Responsibilities:

- create authoritative match state from room snapshot
- run deterministic fixed-tick simulation
- ingest validated input frames from both players
- emit periodic digests and correction payloads
- finalize round and match winner
- persist replay/input log for debugging
- trigger escrow finalize/refund transition exactly once

The gateway and authority may start as one service process if operational simplicity is more important than separation. The interfaces should still be designed as separate concerns.

## Data Model

### Presence

```ts
type PresenceStatus =
  | "OFFLINE"
  | "ONLINE"
  | "IN_PVP_LOBBY"
  | "IN_ROOM"
  | "IN_MATCH";

type PvpPresence = {
  userId: string;
  loginId: string;
  status: PresenceStatus;
  roomId: string | null;
  matchId: string | null;
  enteredLobbyAt: number | null;
  lastSeenAt: number;
};
```

### Invite

```ts
type InviteStatus =
  | "PENDING"
  | "ACCEPTED"
  | "DECLINED"
  | "EXPIRED"
  | "CANCELED";

type PvpInvite = {
  inviteId: string;
  fromUserId: string;
  fromLoginId: string;
  toUserId: string;
  toLoginId: string;
  roomId: string;
  createdAt: number;
  expiresAt: number;
  status: InviteStatus;
};
```

### Room

```ts
type RoomPhase =
  | "OPEN"
  | "WAITING_FOR_INVITEE"
  | "READY_CHECK"
  | "LOCKED"
  | "COUNTDOWN"
  | "IN_MATCH"
  | "CANCELED"
  | "COMPLETED";

type RoomSlot = {
  userId: string;
  loginId: string;
  connected: boolean;
  ready: boolean;
  joinedAt: number;
  skinId: string;
};

type EscrowState =
  | { status: "NONE" }
  | { status: "PENDING"; escrowId: string }
  | { status: "HELD"; escrowId: string; heldAt: number }
  | { status: "FINALIZED"; escrowId: string; finalizedAt: number; winnerUserId: string }
  | { status: "REFUNDED"; escrowId: string; refundedAt: number };

type OnlineRoom = {
  roomId: string;
  ownerUserId: string;
  phase: RoomPhase;
  config: {
    format: "single" | "bo3" | "bo5";
    powerUpMode: "inventory" | "earned" | "none" | "score_attack";
    betting: boolean;
    p1Bet: { coins: number; dolphins: number; tubePieces: number };
    p2Bet: { coins: number; dolphins: number; tubePieces: number };
  };
  slots: {
    host: RoomSlot;
    guest: RoomSlot | null;
  };
  escrow: EscrowState;
  pendingInviteId: string | null;
  matchId: string | null;
  createdAt: number;
  updatedAt: number;
  version: number;
};
```

### Match

```ts
type MatchPhase =
  | "INIT"
  | "COUNTDOWN"
  | "PLAYING"
  | "ROUND_RESULT"
  | "MATCH_RESULT"
  | "ABORTED";

type AuthoritativeMatch = {
  matchId: string;
  roomId: string;
  phase: MatchPhase;
  seed: number;
  tickRate: 60;
  startTick: number;
  currentTick: number;
  players: {
    p1UserId: string;
    p2UserId: string;
  };
  roundIndex: number;
  roundsNeeded: number;
  p1Wins: number;
  p2Wins: number;
  result: null | {
    winnerUserId: string;
    reason: "normal" | "disconnect_forfeit" | "opponent_timeout";
  };
  checksumEveryTicks: number;
};
```

## Redis Key Design

Use new namespace prefix:

- `sd:pvp:presence:<userId>`
- `sd:pvp:lobby:online`
- `sd:pvp:invite:<inviteId>`
- `sd:pvp:user-invites:<userId>`
- `sd:pvp:room:<roomId>`
- `sd:pvp:room-membership:<userId>`
- `sd:pvp:room-events:<roomId>`
- `sd:pvp:match:<matchId>`
- `sd:pvp:match-input:<matchId>:<userId>`
- `sd:pvp:match-digest:<matchId>:<tick>`
- `sd:pvp:match-replay:<matchId>`
- `sd:pvp:bet-escrow:<escrowId>`
- `sd:inbox:<userId>`

### Redis structure recommendations

- presence:
  - JSON value with TTL
  - lobby online set or sorted set for quick lobby listing
- room:
  - single JSON blob with optimistic version field
- room events:
  - append-only stream or capped list for replay/reconnect
- match inputs:
  - stream keyed by user and tick
- replay:
  - compressed append-only input log plus final result metadata

## WebSocket Authentication

### Flow

1. Browser calls `POST /api/pvp-online/ws-ticket`.
2. Existing session cookie is validated using current auth library.
3. API returns:
   - `ticket`
   - `userId`
   - `expiresAt`
4. Browser connects to gateway with `ticket`.
5. Gateway validates ticket against Redis and upgrades the socket.
6. Ticket is single-use and short-lived.

### Why not use raw session cookie directly

- keeps gateway independent of cookie parsing and browser-origin quirks
- reduces exposure of long-lived session credentials
- makes reconnect explicit and auditable

## Room State Machine

```text
OPEN
  -> WAITING_FOR_INVITEE
  -> READY_CHECK
  -> CANCELED

WAITING_FOR_INVITEE
  -> READY_CHECK
  -> OPEN
  -> CANCELED

READY_CHECK
  -> LOCKED
  -> OPEN
  -> CANCELED

LOCKED
  -> COUNTDOWN
  -> CANCELED

COUNTDOWN
  -> IN_MATCH
  -> CANCELED

IN_MATCH
  -> COMPLETED
  -> CANCELED
```

### Transition rules

- `OPEN`
  - created by host only
  - no invite yet
- `WAITING_FOR_INVITEE`
  - host has sent an invite
  - room is reserved for that target user until invite resolution or timeout
- `READY_CHECK`
  - two players are present
  - config can still be changed until both ready
- `LOCKED`
  - both ready
  - config immutable
  - escrow in progress if betting enabled
- `COUNTDOWN`
  - authoritative seed and start tick assigned
  - disconnects can still cancel with refund
- `IN_MATCH`
  - state owned by match authority

### Invariants

- exactly one room per user at a time
- max two players per room
- only room owner can send invite or kick before lock
- config cannot change after `LOCKED`
- a user cannot be invited if they are already in another room or match

## Invite Lifecycle

### Flow

1. Host creates room.
2. Host selects a user from the live lobby list.
3. Client sends `invite.create`.
4. Gateway validates:
   - host owns room
   - room phase allows invite
   - target is in PvP lobby or online
   - target is not already in a room or match
5. Gateway stores invite and emits:
   - realtime toast to invitee
   - inbox item for durability
6. Invitee may:
   - accept
   - decline
   - ignore until expiry
7. On accept:
   - room guest slot is assigned
   - room phase becomes `READY_CHECK`
   - both users receive room snapshot

### Invite expiration

- default: 60 seconds
- on expiry:
  - invite status becomes `EXPIRED`
  - room returns to `OPEN`
  - host sees timeout notification

## Lobby Presence and Notification Semantics

### Presence update model

- Socket heartbeat updates presence TTL every 10 seconds.
- Presence expires after 30 seconds without heartbeat.
- Entering the online PvP lobby flips status to `IN_PVP_LOBBY`.
- Leaving the screen or disconnecting flips status to `ONLINE` or lets TTL expire.

### Notification fanout policy

To avoid spam, lobby-entry notifications should be scoped.

First-release recommendation:

- notify users currently viewing the PvP online lobby
- optionally notify only users with prior social relation:
  - referrals
  - recent opponents
  - manually followed players

Do not broadcast every lobby entry to every online user globally.

## Match Start Protocol

### Preconditions

- room phase is `READY_CHECK`
- both players connected
- both players ready
- config validated
- escrow successful if betting enabled

### Start flow

1. Gateway transitions room to `LOCKED`.
2. Gateway requests authority to create match.
3. Authority returns:
   - `matchId`
   - `seed`
   - `tickRate`
   - `startTick`
   - `playerAssignment` (`p1` or `p2`)
4. Gateway broadcasts `match.starting`.
5. Clients preload match scene and begin local countdown aligned to `startTick`.
6. At `startTick`, clients begin prediction and start sending input frames.

## Netcode Model

### Recommendation

Use deterministic fixed-tick simulation with client prediction plus authoritative reconciliation.

### Why this model fits the current game

- each player primarily interacts with their own lane
- the world is seeded and mostly deterministic
- inputs are small and sparse
- local responsiveness matters
- direct player-vs-player collisions do not exist

### Tick model

- simulation tick rate: 60 Hz
- input payload contains:
  - `tick`
  - `jumpPressed`
  - `jumpHeld`
  - `inputSeq`
- client stores last 3-5 seconds of local predicted state and input history
- authority consumes per-tick inputs from both players

### Authority output

- every 10 ticks:
  - authoritative checksum
  - round/match phase
  - scores
  - alive state
- on significant divergence:
  - send correction anchor at tick `T`
  - client rewinds to `T`, applies authority snapshot, replays cached inputs

### Input buffering

- clients should send inputs ahead by a small lead window, for example 2-3 ticks
- authority tolerates late inputs up to a configured grace threshold
- missing input defaults to last-known hold state plus no new press edge

### Disconnect policy during match

- short disconnect grace period: 20 seconds
- if reconnect succeeds:
  - gateway reattaches socket
  - client receives latest room/match snapshot plus replay cursor
- if reconnect fails:
  - authority declares disconnect forfeit

## Deterministic Simulation Requirements

The authoritative runner and browser client must share a simulation package with:

- fixed-step update entry point
- deterministic seeded RNG
- no audio calls
- no canvas calls
- no wall-clock calls
- no browser-only APIs

### Required interface

```ts
type SimulationInputFrame = {
  tick: number;
  jumpPressed: boolean;
  jumpHeld: boolean;
};

type SimulationSideEffect =
  | { type: "PLAY_SOUND"; sound: string; player: "p1" | "p2" }
  | { type: "SHOW_SCORE_POPUP"; player: "p1" | "p2"; text: string; x: number; y: number }
  | { type: "ROUND_END"; winner: "p1" | "p2" }
  | { type: "PLAYER_DIED"; player: "p1" | "p2"; cause: string };

type SimulationStepResult = {
  nextState: DeterministicMatchState;
  effects: SimulationSideEffect[];
  checksum: string;
};
```

This keeps gameplay behavior intact while separating presentation effects from authority.

## Betting and Escrow Design

### Problems with current approach

Current local PvP uses post-match transfer logic. That is insufficient online because:

- balances can change between ready-up and settlement
- retries can double-settle
- disconnect/cancel needs refund semantics

### Escrow flow

1. Both players configure bets in room.
2. On `LOCKED`, server validates current balances.
3. Server reserves assets into escrow:
   - coins
   - dolphins
   - tube pieces
4. On match completion:
   - finalize escrow to winner
5. On pre-start failure or room cancellation:
   - refund escrow

### Escrow invariants

- exactly one final terminal state:
  - `FINALIZED`
  - `REFUNDED`
- operations must be idempotent
- finalization keyed by `escrowId`

## REST Endpoints

These complement WebSocket events.

### Session/bootstrap

- `POST /api/pvp-online/ws-ticket`
  - returns short-lived websocket ticket
- `GET /api/pvp-online/bootstrap`
  - returns:
    - auth user
    - online PvP feature flags
    - current inbox unread count
    - current room membership if any

### Lobby and inbox

- `GET /api/pvp-online/lobby`
  - fallback snapshot of currently visible lobby users
- `GET /api/pvp-online/inbox`
  - durable inbox events
- `POST /api/pvp-online/inbox/:itemId/read`

### Match history

- `GET /api/pvp-online/matches`
- `GET /api/pvp-online/matches/:matchId`

## WebSocket Event Contract

### Client -> Server

- `presence.enter_lobby`
- `presence.leave_lobby`
- `room.create`
- `room.cancel`
- `room.update_config`
- `room.invite_user`
- `room.accept_invite`
- `room.decline_invite`
- `room.join`
- `room.leave`
- `room.set_ready`
- `match.input`
- `match.ack_digest`
- `session.heartbeat`

### Server -> Client

- `presence.snapshot`
- `presence.user_entered_lobby`
- `presence.user_left_lobby`
- `invite.received`
- `invite.updated`
- `room.snapshot`
- `room.player_joined`
- `room.player_left`
- `room.config_updated`
- `room.ready_updated`
- `room.locked`
- `room.countdown_started`
- `match.starting`
- `match.digest`
- `match.correction`
- `match.player_disconnected`
- `match.result`
- `error`

### Message envelope

```ts
type WsEnvelope<T> = {
  event: string;
  requestId?: string;
  ts: number;
  payload: T;
};
```

### Idempotency

- all mutating client events should carry `requestId`
- server stores recent `requestId` per user/session for dedupe during reconnect/retry

## Room and Match Validation Rules

### Room config validation

- `format` must be one of current supported local formats
- `powerUpMode` must match current supported modes
- `betting=true` requires authenticated users on both slots
- `inventory` mode requires authenticated users on both slots
- bet amounts must be integers >= 0

### Ready validation

Ready button is enabled only when:

- both players present
- both sockets connected
- room config valid
- if betting enabled:
  - both players have valid balances
  - both explicitly confirmed their bet

## Failure Modes

### Before countdown

- guest declines invite
  - room returns to `OPEN`
- guest disconnects
  - room remains `OPEN` or `WAITING_FOR_INVITEE`
- escrow fails
  - room returns to `READY_CHECK`
  - clear error shown

### During countdown

- any disconnect
  - cancel match start
  - refund escrow
  - return to `READY_CHECK` if both recover quickly, otherwise cancel room

### During match

- one client diverges
  - reconcile using authoritative snapshot
- one client disconnects
  - grace timer starts
- authority crash
  - room marked failed
  - escrow refunded if no valid winner was persisted

## Security Model

### Trust boundaries

- client may request actions
- gateway validates identity and room membership
- authority validates input timeline and computes result
- only server may:
  - assign seed
  - assign `p1` and `p2`
  - start countdown
  - declare winner
  - finalize bets

### Abuse protections

- websocket connection rate limits per session and IP
- invite rate limits per user
- room creation rate limits per user
- per-user single active room restriction
- per-user single active match restriction

## Observability

### Logs

Every room and match should log:

- room creation
- invite create/accept/decline/expire
- ready transitions
- escrow hold/finalize/refund
- countdown start
- match start
- disconnects and reconnects
- result
- authoritative checksum mismatch rate

### Metrics

- lobby concurrency
- invite acceptance rate
- room creation to match start conversion
- countdown cancellation rate
- disconnect forfeit rate
- average input latency
- divergence correction count

## Rollout Plan

### Phase 0: Simulation extraction

Deliverables:

- shared deterministic simulation package
- side effects removed from simulation core
- checksum support

Verification:

- local PvP behavior visually unchanged
- same seed + same input log produces identical final checksum in browser and headless runner

### Phase 1: Presence and inbox

Deliverables:

- online PvP lobby screen
- websocket auth ticket
- presence enter/leave
- inbox read API
- scoped lobby-entry notifications

Verification:

- existing menu and local PvP still work
- two browsers see each other in lobby without affecting gameplay

### Phase 2: Invite and room lifecycle

Deliverables:

- room create/cancel
- user invite
- invite accept/decline/expire
- ready state and config locking

Verification:

- no user can occupy two rooms
- reconnect refresh restores room snapshot

### Phase 3: Authoritative match start

Deliverables:

- seed assignment
- countdown synchronization
- authority runner
- digest/correction protocol

Verification:

- two real clients complete a match with the same official result as the authority replay

### Phase 4: Escrow betting and reconnect

Deliverables:

- escrow hold/finalize/refund
- disconnect grace period
- disconnect forfeit policy

Verification:

- no double settlement
- refunds happen exactly once on canceled starts

### Phase 5: Match history and hardening

Deliverables:

- persisted match metadata
- replay debugging tools
- admin visibility for disputes

Verification:

- operators can reconstruct disputed results from replay logs

## Verification Matrix

### Must-pass regression checks

- single-player run start, play, game over, leaderboard flow unchanged
- local PvP lobby still starts same-device match unchanged
- `inventory` mode in local PvP remains correct
- current auth login/logout/me flows unchanged
- current bet settlement endpoint is not used by online mode until escrow replacement is complete

### New automated verification targets

1. deterministic replay test
   - same seed + input log => same result on every run
2. room state machine tests
   - illegal transitions rejected
3. invite expiry tests
   - timeout returns room to expected phase
4. escrow idempotency tests
   - finalize and refund cannot both succeed
5. reconnect tests
   - resumed client receives latest snapshot and can continue
6. authority divergence tests
   - intentional client perturbation gets corrected

## Open Decisions

These should be resolved before implementation begins:

1. Realtime service hosting choice.
   - Recommendation: a small stateful Node service outside Vercel serverless.
2. Scope of lobby-entry notifications.
   - Recommendation: online-lobby viewers plus social graph, not everyone.
3. Player presentation during online match.
   - Recommendation: full-screen own lane plus opponent status panel, not local split-screen.
4. Whether first release includes public rooms or only direct invites.
   - Recommendation: direct invites first; public discoverable rooms later.

## Recommended Next Implementation Spec

After this document, the next concrete artifact should be a protocol spec containing:

- exact WebSocket payload schemas
- room transition table with actor permissions
- Redis transaction rules per mutation
- escrow algorithm
- deterministic checksum fields

That spec should be detailed enough for parallel frontend and backend implementation.
