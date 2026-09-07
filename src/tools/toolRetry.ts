export interface ToolRetryPolicy {
  maxRetries: number;
}

export class ToolRetryTracker {
  private readonly attempts = new Map<string, number>();

  constructor(private readonly maxRetries = 1) {}

  canRetry(callId: string): boolean {
    return (this.attempts.get(callId) ?? 0) < this.maxRetries;
  }

  recordFailure(callId: string): number {
    const next = (this.attempts.get(callId) ?? 0) + 1;
    this.attempts.set(callId, next);
    return next;
  }

  reset(callId: string): void {
    this.attempts.delete(callId);
  }
}
