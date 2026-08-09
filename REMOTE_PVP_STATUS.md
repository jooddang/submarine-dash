# Remote PvP Status

> Snapshot date: 2026-03-18

Status semantics used here:

- `done`: code exists and the main path is wired
- `in progress`: code exists but contract gaps, placeholders, or partial wiring remain
- `todo`: design exists but implementation does not

## Done

- Architecture/design docs are in place:
  - [REMOTE_PVP_ARCHITECTURE.md](REMOTE_PVP_ARCHITECTURE.md)
  - [REMOTE_PVP_PROTOCOL_SPEC.md](REMOTE_PVP_PROTOCOL_SPEC.md)
  - [REMOTE_PVP_EXECUTION_PLAN.md](REMOTE_PVP_EXECUTION_PLAN.md)
- App entry points are wired:
  - [index.tsx](index.tsx)
  - [src/components/UIOverlays.tsx](src/components/UIOverlays.tsx)
- Initial online REST surface exists:
  - bootstrap, ws-ticket, inbox, lobby, room create/get, invite send/accept/decline/cancel/pending
- `pvp-core` scaffold exists:
  - [src/pvp-core/types.ts](src/pvp-core/types.ts)
  - [src/pvp-core/sim.ts](src/pvp-core/sim.ts)
  - [src/pvp-core/checksum.ts](src/pvp-core/checksum.ts)

## In Progress

- Deterministic simulation extraction
  - core exists, but local PvP and authoritative-state separation are not fully complete
- Online UI shell
  - [src/pvp-online/OnlinePvpLobby.tsx](src/pvp-online/OnlinePvpLobby.tsx)
  - [src/pvp-online/OnlinePvpRoom.tsx](src/pvp-online/OnlinePvpRoom.tsx)
  - [src/pvp-online/OnlinePvpMatch.tsx](src/pvp-online/OnlinePvpMatch.tsx)
- Polling-based authoritative match alpha
  - split-screen top/bottom online match rendering now exists
  - room -> match -> result -> room loop is wired
  - host-authoritative simulation still needs real runtime QA and reconnect hardening
- Online REST/API contract
  - routes exist, but were partially mismatched before this turn and still need runtime QA
- Room/presence/invite flow
  - logic exists, but still polling-based and not gateway-based

## Todo

- Realtime gateway / WebSocket transport
- Authoritative live match runner
- Escrow-based online bet settlement
- Reconnect correction path for real live matches
- Observability, rollout flags, and operational hardening

## Fixed This Turn

- client/server API path mismatches around room and invite operations
- missing room config update endpoint
- invalid room default config values from server-side room creation
- stale room membership cleanup on room lookup
- lobby invite UI guarded more tightly by actual room ownership/phase
- lobby presence filtering excludes users who are already in rooms
- online room to match handoff now advances into an explicit match route/state
- online PvP now uses explicit hash URLs for `lobby`, `room`, and `match`
- leaving a room and going back to lobby are unified as room-destroying exit behavior
- lobby now shows joinable open rooms and supports public join without an invite
- invite popup now appears from the main menu and local single/local-PvP screens instead of only inside online lobby flows
- online match now initializes from actual match state after both players ready, instead of getting stuck on host bootstrap timing
- online match now renders split-screen gameplay, round result, match result, celebration overlay, and returns to the room after completion

## Remaining High-Risk Areas

- `OnlinePvpMatch` is an alpha host-authoritative implementation, not a hardened realtime transport
- gateway client is still placeholder-level
- room version conflicts now need runtime QA in localhost with real multi-user flows
- backend and Vercel API parity should be retested after each online PvP change
