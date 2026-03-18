// WebSocket client placeholder — Phase 3 will implement actual connection.

export class OnlinePvpClient {
  private connected = false;

  async connect(_ticket: string): Promise<void> {
    // TODO: Phase 3 - WebSocket connection to realtime gateway
    console.log('[OnlinePvP] WebSocket connection not yet implemented');
  }

  disconnect(): void {
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected;
  }
}
