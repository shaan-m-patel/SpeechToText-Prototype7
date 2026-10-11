/**
 * Guards one in-flight transcription at a time.
 * The attempt token is local to the run that acquired the guard. Completing an
 * older run cannot clear the guard or schedule another upload after Stop.
 */
export class SingleFlightGate {
  private inFlight = false;
  private pending = false;
  private active = false;
  private attempt = 0;

  get isActive(): boolean {
    return this.active;
  }

  beginRecording(): void {
    this.active = true;
    this.pending = false;
    this.inFlight = false;
    this.attempt += 1;
  }

  /** Drop follow-up work for the run that is currently inside the guard. */
  cancelRecording(): void {
    this.active = false;
    this.pending = false;
    this.inFlight = false;
    this.attempt += 1;
  }

  /** @returns a token for this attempt, or null when another attempt already holds the guard. */
  requestRun(): number | null {
    if (this.inFlight) {
      if (this.active) this.pending = true;
      return null;
    }
    this.pending = false;
    this.inFlight = true;
    this.attempt += 1;
    return this.attempt;
  }

  /**
   * Releases the guard for `token` only.
   * @returns true when recording is still active and one newer chunk should be submitted.
   */
  finishRun(token: number): boolean {
    if (token !== this.attempt) return false;
    this.inFlight = false;
    if (this.pending && this.active) {
      this.pending = false;
      return true;
    }
    this.pending = false;
    return false;
  }
}
