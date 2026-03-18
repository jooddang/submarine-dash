// Input processing types and helpers for online PvP.

export type SimulationInputFrame = {
  tick: number;
  jumpPressed: boolean;
  jumpHeld: boolean;
};

// Convert raw input frame to the format expected by attemptJump / updatePlayerState
export function applyInputToState(
  state: { jumpInputActive: boolean; jumpBufferTimer: number; rescueJumpCharges: number; rescue: { active: boolean }; tubeRescue: { active: boolean } },
  input: SimulationInputFrame,
  jumpBufferTime: number,
): void {
  if (input.jumpPressed) {
    if (state.rescue.active || state.tubeRescue.active) {
      state.rescueJumpCharges += 1;
    }
    state.jumpInputActive = true;
    state.jumpBufferTimer = jumpBufferTime;
  }
  if (!input.jumpHeld) {
    state.jumpInputActive = false;
  }
}
