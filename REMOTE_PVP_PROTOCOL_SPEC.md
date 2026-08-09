# Remote PvP Protocol Spec

## Status

Implementation-grade protocol spec for online PvP. This document is intended to follow [REMOTE_PVP_ARCHITECTURE.md](REMOTE_PVP_ARCHITECTURE.md) and be concrete enough for parallel frontend and backend work.

## Scope

This spec defines:

- REST endpoints required to bootstrap online PvP
- WebSocket message envelope and event payloads
- room and invite transition rules
- Redis write rules and idempotency expectations
- escrow transaction rules
- deterministic match-start contract
- file-by-file implementation plan

This spec does not redefine the remote PvP product goals or overall topology already documented in [REMOTE_PVP_ARCHITECTURE.md](REMOTE_PVP_ARCHITECTURE.md).

## Hard Requirements

- Existing single-player must remain unchanged.
- Existing same-device PvP must remain available and behaviorally unchanged.
- Online PvP must live in separate screens and state flows.
- Online winner/result must be server-authoritative.
- Online betting must use escrow, not `/api/pvp/settle-bet`.
- The deterministic core must be side-effect-free before authority is introduced.

## Terminology

- `gateway`: the realtime WebSocket service
- `authority`: the authoritative match runner
- `client`: the browser online PvP client
- `roomVersion`: server-assigned optimistic concurrency version for room state
- `requestId`: client-generated idempotency token for a command
- `ticket`: short-lived WebSocket authentication ticket

## Transport Split

### REST responsibilities

- authenticate and mint WebSocket tickets
- provide bootstrap snapshot
- provide inbox history
- provide fallback room/lobby snapshots
- provide historical match metadata

### WebSocket responsibilities

- presence enter/leave
- invite delivery
- room creation/mutation
- ready-check and locking
- reconnect resume
- countdown start
- match input relay
- match digest/correction delivery

## REST Endpoints

### `POST /api/pvp-online/ws-ticket`

Authenticated endpoint.

Purpose:

- exchange existing session-cookie auth for a short-lived WebSocket ticket

Request:

```json
{}
```

Response:

```json
{
  "ticket": "wst_abc123",
  "user": {
    "userId": "usr_123",
    "loginId": "player1"
  },
  "expiresAt": 1760000000000
}
```

Rules:

- requires valid existing session cookie
- ticket TTL should be short, for example 60 seconds
- ticket must be single-use

### `GET /api/pvp-online/bootstrap`

Authenticated endpoint.

Purpose:

- provide stable initial online PvP data without overloading `/api/auth/me`

Response:

```json
{
  "user": {
    "userId": "usr_123",
    "loginId": "player1",
    "refCode": "ABC123"
  },
  "inventory": {
    "coins": 1200,
    "dolphinSaved": 3,
    "tube": {
      "pieces": 2,
      "charges": 1
    },
    "skins": {
      "owned": ["default"],
      "equipped": "default"
    }
  },
  "inboxUnreadCount": 1,
  "activeRoomSummary": null,
  "presenceNotificationSettings": {
    "lobbyEntryEnabled": true
  }
}
```

Rules:

- must be read-oriented and side-effect-light
- should not claim rewards or mutate inventory

### `GET /api/pvp-online/inbox`

Authenticated endpoint.

Query params:

- `cursor` optional
- `limit` optional

Response:

```json
{
  "items": [
    {
      "inboxId": "inb_1",
      "type": "PVP_INVITE_RECEIVED",
      "createdAt": 1760000000000,
      "readAt": null,
      "actorUserId": "usr_999",
      "actorLoginId": "opponent",
      "roomId": "room_1",
      "matchId": null,
      "payload": {
        "expiresAt": 1760000060000
      }
    }
  ],
  "nextCursor": null
}
```

### `POST /api/pvp-online/inbox/:inboxId/read`

Authenticated endpoint.

Response:

```json
{
  "ok": true,
  "inboxId": "inb_1",
  "readAt": 1760000005000
}
```

### `POST /api/pvp-online/inbox/read-all`

Authenticated endpoint.

Response:

```json
{
  "ok": true,
  "readAt": 1760000005000
}
```

### `GET /api/pvp-online/lobby`

Authenticated endpoint.

Purpose:

- fallback snapshot for lobby presence
- debugging and recovery support

Response:

```json
{
  "users": [
    {
      "userId": "usr_1",
      "loginId": "player1",
      "status": "IN_PVP_LOBBY",
      "enteredLobbyAt": 1760000000000
    }
  ],
  "asOf": 1760000001000
}
```

### `GET /api/pvp-online/rooms/:roomId`

Authenticated endpoint.

Purpose:

- fallback room recovery snapshot

Response:

```json
{
  "room": {
    "roomId": "room_1",
    "phase": "READY_CHECK",
    "version": 7,
    "ownerUserId": "usr_1",
    "config": {
      "format": "bo3",
      "powerUpMode": "earned",
      "betting": false,
      "p1Bet": { "coins": 0, "dolphins": 0, "tubePieces": 0 },
      "p2Bet": { "coins": 0, "dolphins": 0, "tubePieces": 0 }
    },
    "slots": {
      "host": {
        "userId": "usr_1",
        "loginId": "player1",
        "connected": true,
        "ready": false,
        "skinId": "default"
      },
      "guest": {
        "userId": "usr_2",
        "loginId": "player2",
        "connected": true,
        "ready": false,
        "skinId": "default"
      }
    },
    "pendingInviteId": null,
    "matchId": null
  }
}
```

### `GET /api/pvp-online/matches/:matchId`

Authenticated endpoint.

Purpose:

- result page or dispute/debug support

Response:

```json
{
  "match": {
    "matchId": "match_1",
    "roomId": "room_1",
    "phase": "MATCH_RESULT",
    "seed": 123456789,
    "winnerUserId": "usr_1",
    "resultReason": "normal",
    "p1Wins": 2,
    "p2Wins": 1,
    "createdAt": 1760000000000,
    "completedAt": 1760000040000
  }
}
```

## WebSocket Handshake

### Connect

Client opens:

```text
wss://<gateway>/ws?pvpTicket=<ticket>
```

Gateway validates:

- ticket exists
- ticket unexpired
- ticket unused
- ticket matches a valid user

On success, gateway emits:

```json
{
  "event": "session.authenticated",
  "ts": 1760000000000,
  "payload": {
    "userId": "usr_1",
    "loginId": "player1",
    "resumeToken": "resume_abc",
    "heartbeatIntervalMs": 10000,
    "presenceTtlMs": 30000
  }
}
```

## WebSocket Envelope

All WS messages use:

```ts
type WsEnvelope<T> = {
  event: string;
  requestId?: string;
  ts: number;
  payload: T;
};
```

### Envelope rules

- `requestId` is required for every client command that mutates state
- `requestId` is optional for server broadcasts
- `ts` is server-generated for server events and client-generated for client commands

## Error Model

Server rejections use:

```json
{
  "event": "error",
  "requestId": "req_123",
  "ts": 1760000000000,
  "payload": {
    "code": "ROOM_VERSION_CONFLICT",
    "message": "Room version mismatch",
    "roomId": "room_1",
    "roomVersion": 7,
    "retryable": true
  }
}
```

### Required stable error codes

- `UNAUTHENTICATED`
- `FORBIDDEN`
- `INVALID_PAYLOAD`
- `ROOM_NOT_FOUND`
- `ROOM_VERSION_CONFLICT`
- `ROOM_PHASE_INVALID`
- `USER_ALREADY_IN_ROOM`
- `TARGET_ALREADY_IN_ROOM`
- `INVITE_NOT_FOUND`
- `INVITE_NOT_PENDING`
- `INVITE_EXPIRED`
- `READY_PRECONDITION_FAILED`
- `ESCROW_HOLD_FAILED`
- `MATCH_ALREADY_STARTED`
- `RESUME_TOKEN_INVALID`

## Presence Events

### Client -> `presence.enter_lobby`

Payload:

```json
{}
```

Preconditions:

- authenticated socket
- user not already in match

Server action:

- write/update presence TTL
- add user to online-lobby set
- emit `presence.snapshot` to caller
- emit `presence.user_entered_lobby` to scoped audience

### Client -> `presence.leave_lobby`

Payload:

```json
{}
```

Server action:

- remove user from online-lobby set
- update presence status
- emit `presence.user_left_lobby` to scoped audience

### Server -> `presence.snapshot`

Payload:

```json
{
  "users": [
    {
      "userId": "usr_2",
      "loginId": "player2",
      "status": "IN_PVP_LOBBY",
      "enteredLobbyAt": 1760000000000
    }
  ],
  "asOf": 1760000001000
}
```

### Server -> `presence.user_entered_lobby`

Payload:

```json
{
  "userId": "usr_2",
  "loginId": "player2",
  "enteredLobbyAt": 1760000000000
}
```

### Server -> `presence.user_left_lobby`

Payload:

```json
{
  "userId": "usr_2",
  "leftAt": 1760000005000
}
```

## Invite Events

### Client -> `invite.create`

Payload:

```json
{
  "roomId": "room_1",
  "targetUserId": "usr_2",
  "roomVersion": 3
}
```

Preconditions:

- sender is room owner
- room phase is `OPEN` or `WAITING_FOR_INVITEE`
- target not in another room or match
- no conflicting guest in room

Server action:

- create invite record
- set room phase to `WAITING_FOR_INVITEE`
- set `pendingInviteId`
- emit `invite.received` to target
- emit `invite.updated` and `room.snapshot` to host
- optionally write durable inbox item

### Server -> `invite.received`

Payload:

```json
{
  "inviteId": "inv_1",
  "roomId": "room_1",
  "fromUserId": "usr_1",
  "fromLoginId": "player1",
  "expiresAt": 1760000060000
}
```

### Client -> `invite.accept`

Payload:

```json
{
  "inviteId": "inv_1"
}
```

Preconditions:

- invite exists
- invite status `PENDING`
- room still available
- target matches authenticated user

Server action:

- mark invite `ACCEPTED`
- assign guest slot
- clear `pendingInviteId`
- set room phase to `READY_CHECK`
- emit `invite.updated`
- emit `room.player_joined`
- emit `room.snapshot` to both users

Idempotency rule:

- repeated accept on already accepted invite returns current `room.snapshot`

### Client -> `invite.decline`

Payload:

```json
{
  "inviteId": "inv_1"
}
```

Server action:

- mark invite `DECLINED`
- if room still waiting on that invite, return room to `OPEN`
- emit `invite.updated` to both sides
- optionally write host inbox item if offline

### Client -> `invite.cancel`

Payload:

```json
{
  "inviteId": "inv_1",
  "roomId": "room_1",
  "roomVersion": 4
}
```

Preconditions:

- sender is host
- invite belongs to sender’s room
- invite status `PENDING`

Server action:

- mark invite `CANCELED`
- room returns to `OPEN`
- clear `pendingInviteId`

### Server -> `invite.updated`

Payload:

```json
{
  "inviteId": "inv_1",
  "status": "ACCEPTED",
  "roomId": "room_1",
  "updatedAt": 1760000003000
}
```

### Server -> `invite.expired`

Payload:

```json
{
  "inviteId": "inv_1",
  "roomId": "room_1",
  "expiredAt": 1760000060000
}
```

## Room Events

### Client -> `room.create`

Payload:

```json
{
  "config": {
    "format": "single",
    "powerUpMode": "earned",
    "betting": false,
    "p1Bet": { "coins": 0, "dolphins": 0, "tubePieces": 0 },
    "p2Bet": { "coins": 0, "dolphins": 0, "tubePieces": 0 }
  },
  "skinId": "default"
}
```

Preconditions:

- user not already in room or match

Server action:

- create room with version `1`
- assign host slot
- emit `room.snapshot` to host

### Client -> `room.update_config`

Payload:

```json
{
  "roomId": "room_1",
  "roomVersion": 3,
  "config": {
    "format": "bo3",
    "powerUpMode": "inventory",
    "betting": true,
    "p1Bet": { "coins": 100, "dolphins": 1, "tubePieces": 0 },
    "p2Bet": { "coins": 100, "dolphins": 1, "tubePieces": 0 }
  }
}
```

Preconditions:

- sender is host
- room phase is `OPEN` or `READY_CHECK`
- room not `LOCKED`

Server action:

- validate config
- clear both ready flags
- increment room version
- emit `room.config_updated`
- emit `room.ready_updated`
- emit `room.snapshot`

### Client -> `room.set_ready`

Payload:

```json
{
  "roomId": "room_1",
  "roomVersion": 5,
  "ready": true
}
```

Preconditions:

- sender occupies host or guest slot
- room phase is `READY_CHECK`

Server action:

- update sender ready flag
- increment room version
- emit `room.ready_updated`
- if both ready and preconditions satisfied:
  - transition to `LOCKED`
  - begin escrow hold if needed
  - continue into countdown path

### Client -> `room.leave`

Payload:

```json
{
  "roomId": "room_1",
  "roomVersion": 5
}
```

Preconditions:

- sender in room
- room not `LOCKED` or later

Server action:

- if guest leaves:
  - clear guest slot
  - clear both ready flags
  - room phase becomes `OPEN`
- if host leaves:
  - cancel room

### Client -> `room.cancel`

Payload:

```json
{
  "roomId": "room_1",
  "roomVersion": 5
}
```

Preconditions:

- sender is host
- room not `IN_MATCH`

Server action:

- cancel room
- clear pending invite
- refund escrow if held
- emit `room.canceled`

### Server -> `room.snapshot`

Canonical room payload:

```json
{
  "room": {
    "roomId": "room_1",
    "ownerUserId": "usr_1",
    "phase": "READY_CHECK",
    "version": 6,
    "config": {
      "format": "bo3",
      "powerUpMode": "inventory",
      "betting": true,
      "p1Bet": { "coins": 100, "dolphins": 1, "tubePieces": 0 },
      "p2Bet": { "coins": 100, "dolphins": 1, "tubePieces": 0 }
    },
    "slots": {
      "host": {
        "userId": "usr_1",
        "loginId": "player1",
        "connected": true,
        "ready": true,
        "skinId": "default"
      },
      "guest": {
        "userId": "usr_2",
        "loginId": "player2",
        "connected": true,
        "ready": false,
        "skinId": "default"
      }
    },
    "pendingInviteId": null,
    "matchId": null,
    "escrow": {
      "status": "NONE"
    }
  }
}
```

### Server -> `room.ready_updated`

Payload:

```json
{
  "roomId": "room_1",
  "roomVersion": 6,
  "hostReady": true,
  "guestReady": false
}
```

### Server -> `room.locked`

Payload:

```json
{
  "roomId": "room_1",
  "roomVersion": 7,
  "escrow": {
    "status": "HELD",
    "escrowId": "esc_1"
  }
}
```

### Server -> `room.canceled`

Payload:

```json
{
  "roomId": "room_1",
  "reason": "HOST_LEFT",
  "canceledAt": 1760000006000
}
```

## Match Start Contract

### Server -> `match.starting`

Payload:

```json
{
  "roomId": "room_1",
  "matchId": "match_1",
  "seed": 123456789,
  "tickRate": 60,
  "countdownMs": 3000,
  "startTick": 500,
  "simDimensions": {
    "width": 1280,
    "height": 720
  },
  "playerAssignment": "p1",
  "config": {
    "format": "bo3",
    "powerUpMode": "inventory",
    "betting": true
  },
  "loadout": {
    "dolphinCount": 3,
    "tubeCharges": 1,
    "skinId": "default"
  }
}
```

Rules:

- `seed` is server-generated
- `simDimensions` are canonical and fixed
- `loadout` is room-lock snapshot, not live Redis state
- clients must not start simulation before `startTick`

## Match Input Events

### Client -> `match.input`

Payload:

```json
{
  "matchId": "match_1",
  "tick": 503,
  "input": {
    "jumpPressed": true,
    "jumpHeld": true
  },
  "inputSeq": 12
}
```

Rules:

- one input frame per tick
- `jumpPressed` is edge-triggered
- `jumpHeld` is continuous state
- duplicate `(matchId, tick, userId)` messages are idempotent; latest identical value is safe

### Authority -> `match.digest`

Payload:

```json
{
  "matchId": "match_1",
  "currentTick": 510,
  "checksumTick": 510,
  "checksum": 2459911221,
  "phase": "PLAYING",
  "summary": {
    "p1Alive": true,
    "p2Alive": true,
    "p1Score": 220,
    "p2Score": 210
  }
}
```

Rules:

- emit every 10 ticks
- checksum excludes cosmetic state

### Authority -> `match.correction`

Payload:

```json
{
  "matchId": "match_1",
  "fromTick": 500,
  "authoritativeTick": 510,
  "stateAnchor": {
    "tick": 500,
    "p1": {},
    "p2": {}
  }
}
```

Rules:

- used only on detected divergence or reconnect
- client rewinds to `fromTick` and replays cached inputs

### Server -> `match.player_disconnected`

Payload:

```json
{
  "matchId": "match_1",
  "userId": "usr_2",
  "graceExpiresAt": 1760000020000
}
```

### Server -> `match.player_reconnected`

Payload:

```json
{
  "matchId": "match_1",
  "userId": "usr_2",
  "reconnectedAt": 1760000010000
}
```

### Server -> `match.result`

Payload:

```json
{
  "matchId": "match_1",
  "roomId": "room_1",
  "winnerUserId": "usr_1",
  "reason": "normal",
  "p1Wins": 2,
  "p2Wins": 1,
  "escrow": {
    "status": "FINALIZED",
    "escrowId": "esc_1"
  }
}
```

## Session and Resume Events

### Client -> `session.heartbeat`

Payload:

```json
{}
```

Rules:

- sent every `heartbeatIntervalMs`
- refreshes presence TTL and connection freshness

### Client -> `session.resume`

Payload:

```json
{
  "resumeToken": "resume_abc"
}
```

Server action:

- validate token
- rebind connection
- emit `session.resynced`
- resend latest room snapshot or match correction anchor

### Server -> `session.resynced`

Payload:

```json
{
  "userId": "usr_1",
  "roomId": "room_1",
  "matchId": null
}
```

## Room State Machine

### Valid transitions

| From | To | Trigger |
|------|----|---------|
| `OPEN` | `WAITING_FOR_INVITEE` | host sends invite |
| `OPEN` | `READY_CHECK` | guest joins without pending invite in future public-room mode |
| `OPEN` | `CANCELED` | host cancels or disconnects |
| `WAITING_FOR_INVITEE` | `OPEN` | invite declined/canceled/expired |
| `WAITING_FOR_INVITEE` | `READY_CHECK` | invite accepted |
| `WAITING_FOR_INVITEE` | `CANCELED` | host cancels |
| `READY_CHECK` | `OPEN` | guest leaves or guest disconnect cleanup before lock |
| `READY_CHECK` | `LOCKED` | both ready and preconditions pass |
| `READY_CHECK` | `CANCELED` | host cancels |
| `LOCKED` | `COUNTDOWN` | escrow hold succeeded and match contract created |
| `LOCKED` | `READY_CHECK` | lock rollback due to pre-start failure |
| `LOCKED` | `CANCELED` | unrecoverable pre-start failure |
| `COUNTDOWN` | `IN_MATCH` | start tick reached |
| `COUNTDOWN` | `READY_CHECK` | countdown abort with recoverable rollback |
| `COUNTDOWN` | `CANCELED` | countdown abort with room failure |
| `IN_MATCH` | `COMPLETED` | authority produces result |
| `IN_MATCH` | `CANCELED` | unrecoverable authority failure before valid result |

### Illegal transitions

Everything not listed above is invalid.

Particularly invalid:

- `OPEN -> LOCKED`
- `WAITING_FOR_INVITEE -> IN_MATCH`
- `LOCKED -> OPEN` by client command
- `IN_MATCH -> READY_CHECK`
- `COMPLETED -> OPEN`

## Actor Permission Table

| Command | Host | Guest | Other user |
|---------|------|-------|------------|
| `room.create` | yes | yes if no active room | no |
| `room.update_config` | yes | no | no |
| `invite.create` | yes | no | no |
| `invite.accept` | no | yes if target | no |
| `invite.decline` | no | yes if target | no |
| `room.set_ready` | yes for self | yes for self | no |
| `room.leave` | yes before lock, acts as cancel | yes before lock | no |
| `room.cancel` | yes | no | no |
| `match.input` | yes if participant | yes if participant | no |

## Redis Key Contract

### Presence

- `sd:pvp:presence:<userId>` -> JSON + TTL
- `sd:pvp:lobby:online` -> ZSET or SET

Presence JSON:

```json
{
  "userId": "usr_1",
  "loginId": "player1",
  "status": "IN_PVP_LOBBY",
  "roomId": null,
  "matchId": null,
  "enteredLobbyAt": 1760000000000,
  "lastSeenAt": 1760000001000
}
```

### Rooms

- `sd:pvp:room:<roomId>` -> canonical room JSON
- `sd:pvp:room-membership:<userId>` -> `roomId`

### Invites

- `sd:pvp:invite:<inviteId>` -> invite JSON
- `sd:pvp:user-invites:<userId>` -> invite ids

### Matches

- `sd:pvp:match:<matchId>` -> match metadata
- `sd:pvp:match-input:<matchId>:<userId>` -> stream/list of input frames
- `sd:pvp:match-replay:<matchId>` -> authoritative replay log

### Escrow

- `sd:pvp:escrow:<escrowId>` -> escrow JSON
- optional:
  - `sd:pvp:user-active-escrow:<userId>` -> `escrowId`

### Inbox

- `sd:inbox:<userId>` -> list/stream of inbox items
- `sd:inbox:unread:<userId>` -> unread count

## Redis Mutation Rules

### Rule 1: Room writes must be versioned

Every room mutation must:

1. read current room
2. verify `roomVersion`
3. apply mutation
4. increment version
5. publish resulting room snapshot

If versions mismatch:

- reject with `ROOM_VERSION_CONFLICT`

### Rule 2: Membership uniqueness

Before creating or joining a room:

- check `sd:pvp:room-membership:<userId>`
- reject if user already bound to a nonterminal room

### Rule 3: Invite acceptance must be atomic

Accept path must atomically:

- verify invite `PENDING`
- verify invite target is caller
- verify room guest slot still empty
- set invite `ACCEPTED`
- assign guest slot
- write membership key
- clear `pendingInviteId`
- set room phase `READY_CHECK`

### Rule 4: Lock and escrow must behave atomically to the user

If room enters `LOCKED`, the user-facing effect must be one of:

- lock succeeded and escrow is `HELD`
- lock rolled back and room returns to `READY_CHECK`

Never leave room visually locked with failed escrow state hidden.

### Rule 5: Terminal escrow states are exclusive

Allowed terminal escrow states:

- `FINALIZED`
- `REFUNDED`

Once terminal:

- all subsequent finalize/refund attempts must become no-ops or reject idempotently

## Escrow Record Spec

Escrow JSON:

```json
{
  "escrowId": "esc_1",
  "roomId": "room_1",
  "matchId": null,
  "p1UserId": "usr_1",
  "p2UserId": "usr_2",
  "p1Stake": { "coins": 100, "dolphins": 1, "tubePieces": 0 },
  "p2Stake": { "coins": 100, "dolphins": 1, "tubePieces": 0 },
  "status": "HELD",
  "createdAt": 1760000000000,
  "heldAt": 1760000001000,
  "finalizedAt": null,
  "refundedAt": null,
  "winnerUserId": null
}
```

### Escrow transitions

| From | To | Trigger |
|------|----|---------|
| `PENDING` | `HELD` | hold succeeded |
| `PENDING` | `REFUNDED` | hold aborted after partial prep |
| `HELD` | `FINALIZED` | match result final |
| `HELD` | `REFUNDED` | match canceled / failed start |

### Escrow hold algorithm

1. validate both players’ balances
2. create escrow record in `PENDING`
3. decrement/reserve assets from both users
4. mark escrow `HELD`
5. attach `escrowId` to room

If any reserve step fails:

1. rollback already-reserved assets
2. mark escrow `REFUNDED`
3. return lock failure

### Escrow finalize algorithm

1. load escrow by `escrowId`
2. reject if status not `HELD`
3. transfer both stakes to winner
4. mark `FINALIZED` with `winnerUserId`
5. write ledger events

### Escrow refund algorithm

1. load escrow by `escrowId`
2. reject if status terminal
3. restore both players’ held stakes
4. mark `REFUNDED`
5. write ledger events

## Match Start Preconditions

Before emitting `match.starting`, server must verify:

- room phase is `READY_CHECK`
- host and guest both present
- both connected
- both ready
- config valid
- if `inventory` mode, loadout snapshot valid for both players
- if betting enabled, escrow is `HELD`

## Deterministic Core Contract

This spec assumes a shared `pvp-core` with:

- fixed canonical simulation dimensions
- fixed tick rate
- deterministic world generation from server-provided seed
- no browser APIs
- no audio calls
- no render-owned state
- checksum support

### Required authoritative payload fields

Authority must be able to reconstruct a match from:

- `seed`
- `format`
- `powerUpMode`
- `playerAssignment`
- `initialLoadout` for each player
- ordered input frames per player

## Reconnect Rules

### Lobby and room reconnect

- if presence TTL not expired:
  - restore room membership and emit `room.snapshot`
- if TTL expired but room membership still exists:
  - restore room membership and update connected flag

### Match reconnect

On successful resume during grace window:

- emit `session.resynced`
- emit latest `match.digest`
- emit `match.correction` anchor
- continue match

If grace window expires:

- authority resolves disconnect forfeit

## File-by-File Build Plan

### Phase 1: shared deterministic core

Add:

- `src/pvp-core/types.ts`
- `src/pvp-core/rng.ts`
- `src/pvp-core/init.ts`
- `src/pvp-core/input.ts`
- `src/pvp-core/world.ts`
- `src/pvp-core/sim.ts`
- `src/pvp-core/events.ts`
- `src/pvp-core/checksum.ts`

Adjust:

- [src/pvp/pvpGameLogic.ts](src/pvp/pvpGameLogic.ts)
- [src/pvp/pvpWorld.ts](src/pvp/pvpWorld.ts)
- [src/pvp/PvpGame.tsx](src/pvp/PvpGame.tsx)

Goal:

- local PvP runs through extracted core with unchanged behavior

### Phase 2: online frontend shell

Add:

- `src/pvp-online/onlinePvpTypes.ts`
- `src/pvp-online/onlinePvpClient.ts`
- `src/pvp-online/onlinePvpStore.ts`
- `src/pvp-online/OnlinePvpLobby.tsx`
- `src/pvp-online/OnlinePvpRoom.tsx`
- `src/pvp-online/OnlinePvpMatch.tsx`
- `src/pvp-online/reconnect.ts`

Adjust:

- [index.tsx](index.tsx)
- [src/components/UIOverlays.tsx](src/components/UIOverlays.tsx)
- [src/api.ts](src/api.ts)

Goal:

- menu can enter online PvP lobby
- inbox badge can show durable unread count later

### Phase 3: Vercel REST support

Add:

- `api/pvp-online/ws-ticket.ts`
- `api/pvp-online/bootstrap.ts`
- `api/pvp-online/inbox.ts`
- `api/pvp-online/inbox/[id]/read.ts`
- `api/pvp-online/inbox/read-all.ts`
- `api/pvp-online/lobby.ts`
- `api/pvp-online/rooms/[roomId].ts`
- `api/pvp-online/matches/[matchId].ts`

Add shared libs:

- `api/_lib/pvpOnlineAuth.ts`
- `api/_lib/pvpOnlineInbox.ts`
- `api/_lib/pvpOnlinePresence.ts`
- `api/_lib/pvpOnlineEscrow.ts`
- `api/_lib/pvpOnlineRooms.ts`

Goal:

- authenticated bootstrap and inbox support exist before gateway rollout

### Phase 4: realtime gateway

Separate service codebase recommended:

- `realtime-gateway/src/server.ts`
- `realtime-gateway/src/auth.ts`
- `realtime-gateway/src/presence.ts`
- `realtime-gateway/src/invites.ts`
- `realtime-gateway/src/rooms.ts`
- `realtime-gateway/src/matches.ts`
- `realtime-gateway/src/resume.ts`
- `realtime-gateway/src/protocol.ts`

Goal:

- invite-driven room lifecycle works with versioned room snapshots

### Phase 5: authority runner

Add:

- `realtime-gateway/src/authority/runner.ts`
- `realtime-gateway/src/authority/replay.ts`
- `realtime-gateway/src/authority/checksums.ts`

Goal:

- authoritative result and reconnect correction path

## Verification Checklist

### Non-regression

- local PvP still starts from existing local lobby
- local PvP visuals and controls remain unchanged
- single-player unaffected
- existing auth flows unaffected
- existing missions/leaderboard unaffected

### Protocol verification

- duplicate `requestId` does not duplicate state mutation
- stale `roomVersion` is rejected
- invite accept is idempotent
- room lock rolls back cleanly if escrow hold fails
- match start uses server-provided seed only
- escrow finalizes exactly once
- reconnect within grace restores authoritative state

## Recommended Immediate Build Order

1. Extract `pvp-core` and checksum harness.
2. Add `GET /api/pvp-online/bootstrap` and `POST /api/pvp-online/ws-ticket`.
3. Add inbox model and unread count plumbing.
4. Implement gateway room/invite lifecycle without live matches yet.
5. Add authority match start with input relay.
6. Add escrow hold/finalize/refund.

This order keeps existing features safe while allowing the new system to be validated layer by layer.
