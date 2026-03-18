// Side-effect events emitted by deterministic simulation.
// The sim core never calls playSound() or touches browser APIs directly.
// Instead it pushes events here; the host (local PvP or online client) interprets them.

export type SimulationSideEffect =
  | { type: "PLAY_SOUND"; sound: string; player: "p1" | "p2" }
  | { type: "SHOW_SCORE_POPUP"; player: "p1" | "p2"; text: string; x: number; y: number }
  | { type: "PLAYER_DIED"; player: "p1" | "p2"; cause: string };
