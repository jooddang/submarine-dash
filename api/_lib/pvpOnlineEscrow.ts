// Escrow types — implementation comes in Phase 5.

export type EscrowStatus = "NONE" | "PENDING" | "HELD" | "FINALIZED" | "REFUNDED";

export type EscrowRecord = {
  escrowId: string;
  roomId: string;
  matchId: string | null;
  p1UserId: string;
  p2UserId: string;
  p1Stake: { coins: number; dolphins: number; tubePieces: number };
  p2Stake: { coins: number; dolphins: number; tubePieces: number };
  status: EscrowStatus;
  createdAt: number;
  heldAt: number | null;
  finalizedAt: number | null;
  refundedAt: number | null;
  winnerUserId: string | null;
};
