import { BridgeError } from "../utils/errors.js";
import type { Logger } from "../utils/logger.js";

export const UPSTREAM_MIN_DELAY_MS = 5_000;
export const UPSTREAM_RATE_LIMIT_BACKOFF_MS = [5_000, 10_000, 20_000, 40_000] as const;
export const UPSTREAM_TRANSIENT_BACKOFF_MS = [5_000, 10_000] as const;

export interface UpstreamRetryBudget {
  rateLimitRemaining: number;
  transientRemaining: number;
}

export interface UpstreamRequestLease {
  request<T>(operation: () => Promise<T>, attempt: number): Promise<T>;
}

export interface UpstreamControllerOptions {
  minDelayMs?: number;
  rateLimitBackoffMs?: readonly number[];
  transientBackoffMs?: readonly number[];
  jitterRatio?: number;
  random?: () => number;
  now?: () => number;
  sleep?: (delayMs: number, signal?: AbortSignal) => Promise<void>;
}

interface RunOptions {
  logger: Logger;
  signal?: AbortSignal;
  budget?: UpstreamRetryBudget;
}

interface QueuedJob<T> {
  operation: (lease: UpstreamRequestLease, attempt: number) => Promise<T>;
  options: RunOptions;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
  abort?: () => void;
}

type AnyQueuedJob = QueuedJob<unknown>;

function disconnected(stage: string): BridgeError {
  return new BridgeError("Downstream client disconnected.", {
    code: "CLIENT_DISCONNECTED",
    status: 499,
    retryable: false,
    upstreamStage: stage,
    causeCode: "downstream_disconnected",
  });
}

function defaultSleep(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(disconnected("upstream_retry_wait"));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, delayMs);
    const abort = (): void => {
      clearTimeout(timer);
      reject(disconnected("upstream_retry_wait"));
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function upstreamStatus(error: unknown): number | null {
  if (!(error instanceof BridgeError)) return null;
  if (error.code === "DEEPSEEK_RATE_LIMIT" || error.status === 429) return 429;
  const match = /^http_(502|503|504)$/.exec(error.causeCode ?? "");
  if (match) return Number(match[1]);
  if (
    error.retryable
    && error.causeCode === "transport_error"
    && (error.upstreamStage === "challenge_headers" || error.upstreamStage === "session_create_headers")
  ) return 502;
  return null;
}

export function createUpstreamRetryBudget(
  rateLimitRetries: number = UPSTREAM_RATE_LIMIT_BACKOFF_MS.length,
  transientRetries: number = UPSTREAM_TRANSIENT_BACKOFF_MS.length,
): UpstreamRetryBudget {
  return {
    rateLimitRemaining: rateLimitRetries,
    transientRemaining: transientRetries,
  };
}

export class UpstreamController {
  private readonly minDelayMs: number;
  private readonly rateLimitBackoffMs: readonly number[];
  private readonly transientBackoffMs: readonly number[];
  private readonly jitterRatio: number;
  private readonly random: () => number;
  private readonly now: () => number;
  private readonly sleep: (delayMs: number, signal?: AbortSignal) => Promise<void>;
  private readonly queue: AnyQueuedJob[] = [];
  private active = false;
  private lastRequestFinishedAt: number | null = null;

  constructor(options: UpstreamControllerOptions = {}) {
    this.minDelayMs = Math.max(0, options.minDelayMs ?? UPSTREAM_MIN_DELAY_MS);
    this.rateLimitBackoffMs = options.rateLimitBackoffMs ?? UPSTREAM_RATE_LIMIT_BACKOFF_MS;
    this.transientBackoffMs = options.transientBackoffMs ?? UPSTREAM_TRANSIENT_BACKOFF_MS;
    this.jitterRatio = Math.max(0, Math.min(0.2, options.jitterRatio ?? 0.15));
    this.random = options.random ?? Math.random;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? defaultSleep;
  }

  createBudget(): UpstreamRetryBudget {
    return createUpstreamRetryBudget(this.rateLimitBackoffMs.length, this.transientBackoffMs.length);
  }

  run<T>(
    operation: (lease: UpstreamRequestLease, attempt: number) => Promise<T>,
    options: RunOptions,
  ): Promise<T> {
    if (options.signal?.aborted) return Promise.reject(disconnected("upstream_queue_wait"));
    return new Promise<T>((resolve, reject) => {
      const job: QueuedJob<T> = { operation, options, resolve, reject };
      if (this.active || this.queue.length > 0) {
        options.logger.info("upstream_queue_wait", { attempt: 1, delay_ms: 0, status: "queued" });
      }
      const abort = (): void => {
        const index = this.queue.indexOf(job as AnyQueuedJob);
        if (index >= 0) this.queue.splice(index, 1);
        options.signal?.removeEventListener("abort", abort);
        reject(disconnected("upstream_queue_wait"));
      };
      job.abort = abort;
      options.signal?.addEventListener("abort", abort, { once: true });
      this.queue.push(job as AnyQueuedJob);
      this.drain();
    });
  }

  private drain(): void {
    if (this.active) return;
    const job = this.queue.shift();
    if (!job) return;
    this.active = true;
    if (job.abort) job.options.signal?.removeEventListener("abort", job.abort);
    void this.execute(job).then(job.resolve, job.reject).finally(() => {
      this.active = false;
      this.drain();
    });
  }

  private async execute<T>(job: QueuedJob<T>): Promise<T> {
    const { logger, signal } = job.options;
    const budget = job.options.budget ?? createUpstreamRetryBudget(
      this.rateLimitBackoffMs.length,
      this.transientBackoffMs.length,
    );
    let attempt = 1;
    let rateRetries = 0;
    let transientRetries = 0;
    let retried = false;
    const lease: UpstreamRequestLease = {
      request: async <R>(operation: () => Promise<R>, requestAttempt: number): Promise<R> => {
        if (signal?.aborted) throw disconnected("upstream_throttle_wait");
        if (this.lastRequestFinishedAt !== null) {
          const delayMs = Math.max(0, this.lastRequestFinishedAt + this.minDelayMs - this.now());
          if (delayMs > 0) {
            logger.info("upstream_throttle_wait", { attempt: requestAttempt, delay_ms: delayMs, status: "waiting" });
            await this.sleep(delayMs, signal);
          }
        }
        if (signal?.aborted) throw disconnected("upstream_request");
        try {
          return await operation();
        } finally {
          this.lastRequestFinishedAt = this.now();
        }
      },
    };

    for (;;) {
      if (signal?.aborted) throw disconnected("upstream_retry_wait");
      try {
        const result = await job.operation(lease, attempt);
        if (retried) logger.info("upstream_retry_success", { attempt, delay_ms: 0, status: 200 });
        return result;
      } catch (error) {
        const status = upstreamStatus(error);
        const rateLimited = status === 429;
        const transient = status === 502 || status === 503 || status === 504;
        const remaining = rateLimited ? budget.rateLimitRemaining : transient ? budget.transientRemaining : 0;
        if (!rateLimited && !transient) throw error;
        if (rateLimited) {
          logger.warn("upstream_rate_limited", { attempt, delay_ms: 0, status: 429 });
        }
        if (remaining <= 0) {
          logger.warn("upstream_retry_exhausted", { attempt, delay_ms: 0, status });
          throw error;
        }
        const retryIndex = rateLimited ? rateRetries++ : transientRetries++;
        if (rateLimited) budget.rateLimitRemaining--;
        else budget.transientRemaining--;
        const configured = rateLimited
          ? this.rateLimitBackoffMs[Math.min(retryIndex, this.rateLimitBackoffMs.length - 1)] ?? 0
          : this.transientBackoffMs[Math.min(retryIndex, this.transientBackoffMs.length - 1)] ?? 0;
        const retryAfter = error instanceof BridgeError ? error.retryAfterMs : null;
        const baseDelay = retryAfter !== null ? retryAfter : configured;
        const jitter = retryAfter !== null ? 1 : 1 + (this.random() * 2 - 1) * this.jitterRatio;
        const delayMs = Math.max(0, Math.round(baseDelay * jitter));
        logger.warn("upstream_retry_scheduled", { attempt, delay_ms: delayMs, status });
        await this.sleep(delayMs, signal);
        retried = true;
        attempt++;
      }
    }
  }
}
