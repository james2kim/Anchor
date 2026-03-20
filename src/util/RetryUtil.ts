import type { RedisClientType } from 'redis';

interface RetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  timeoutMs?: number;
  label?: string;
}

// ============================================================================
// Per-attempt timeout
// ============================================================================

export class TimeoutError extends Error {
  constructor(ms: number) {
    super(`Operation timed out after ${ms}ms`);
    this.name = 'TimeoutError';
  }
}

export function withTimeout<T>(
  fn: (signal?: AbortSignal) => Promise<T>,
  ms: number
): Promise<T> {
  const controller = new AbortController();
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      controller.abort();
      reject(new TimeoutError(ms));
    }, ms);

    fn(controller.signal).then(
      (result) => {
        clearTimeout(timer);
        resolve(result);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

// ============================================================================
// Circuit breaker — Redis-backed for cross-instance consistency
// ============================================================================

const CIRCUIT_FAILURE_THRESHOLD = 5;
const CIRCUIT_COOLDOWN_S = 60; // 1 minute
const CB_PREFIX = 'cb:';

let redisClient: RedisClientType | null = null;

/** Provide a Redis client for cross-instance circuit breaker state. */
export function setCircuitBreakerRedis(client: RedisClientType): void {
  redisClient = client;
}

// In-memory fallback for when Redis is unavailable
interface CircuitState {
  consecutiveFailures: number;
  openUntil: number;
}
const localCircuits = new Map<string, CircuitState>();

class CircuitOpenError extends Error {
  constructor(label: string, remainingMs: number) {
    super(
      `Circuit breaker open for "${label}" — ${Math.ceil(remainingMs / 1000)}s remaining`
    );
    this.name = 'CircuitOpenError';
  }
}

function getLocalCircuit(label: string): CircuitState {
  let state = localCircuits.get(label);
  if (!state) {
    state = { consecutiveFailures: 0, openUntil: 0 };
    localCircuits.set(label, state);
  }
  return state;
}

async function recordSuccess(label: string): Promise<void> {
  if (redisClient) {
    try {
      await redisClient.del(`${CB_PREFIX}${label}`);
      return;
    } catch { /* fall through to local */ }
  }
  const state = getLocalCircuit(label);
  state.consecutiveFailures = 0;
  state.openUntil = 0;
}

async function recordFailure(label: string): Promise<void> {
  if (redisClient) {
    try {
      const key = `${CB_PREFIX}${label}`;
      const count = await redisClient.incr(key);
      // Set TTL on first failure so it auto-resets (acts as cooldown)
      if (count === 1) {
        await redisClient.expire(key, CIRCUIT_COOLDOWN_S);
      }
      if (count >= CIRCUIT_FAILURE_THRESHOLD) {
        console.warn(
          `[circuitBreaker:${label}] Circuit OPEN after ${count} consecutive failures. Cooldown ${CIRCUIT_COOLDOWN_S}s.`
        );
      }
      return;
    } catch { /* fall through to local */ }
  }
  const state = getLocalCircuit(label);
  state.consecutiveFailures++;
  if (state.consecutiveFailures >= CIRCUIT_FAILURE_THRESHOLD) {
    state.openUntil = Date.now() + CIRCUIT_COOLDOWN_S * 1000;
    console.warn(
      `[circuitBreaker:${label}] Circuit OPEN after ${state.consecutiveFailures} consecutive failures. Cooldown ${CIRCUIT_COOLDOWN_S}s.`
    );
  }
}

async function assertCircuitClosed(label: string): Promise<void> {
  if (redisClient) {
    try {
      const key = `${CB_PREFIX}${label}`;
      const raw = await redisClient.get(key);
      const count = raw ? parseInt(raw, 10) : 0;
      if (count >= CIRCUIT_FAILURE_THRESHOLD) {
        const ttl = await redisClient.ttl(key);
        throw new CircuitOpenError(label, ttl * 1000);
      }
      return;
    } catch (err) {
      if (err instanceof CircuitOpenError) throw err;
      // Redis unavailable — fall through to local
    }
  }
  const state = getLocalCircuit(label);
  if (state.openUntil === 0) return;

  const now = Date.now();
  if (now >= state.openUntil) {
    state.openUntil = 0;
    state.consecutiveFailures = CIRCUIT_FAILURE_THRESHOLD - 1;
    console.log(`[circuitBreaker:${label}] Circuit half-open — allowing probe request.`);
    return;
  }

  throw new CircuitOpenError(label, state.openUntil - now);
}

// ============================================================================
// Retryable error detection
// ============================================================================

function isRetryable(error: unknown): boolean {
  if (error instanceof CircuitOpenError) return false;

  // Status code is the most reliable signal — check it first
  const statusCode =
    (error as any)?.status ?? (error as any)?.statusCode ?? (error as any)?.response?.status;
  if (typeof statusCode === 'number') {
    if ([429, 500, 502, 503, 529].includes(statusCode)) return true;
    if (statusCode >= 400 && statusCode < 500) return false; // all 4xx are non-retryable
  }

  // Timeout errors from our own withTimeout are always retryable
  if (error instanceof TimeoutError) return true;

  // Fall back to message matching only for errors without status codes (e.g. network-level)
  const message = error instanceof Error ? error.message : String(error);
  const retryablePatterns = [
    /\b429\b/,
    /\b500\b/,
    /\b502\b/,
    /\b503\b/,
    /\b529\b/,
    /rate.?limit/i,
    /overloaded/i,
    /ECONNRESET/,
    /ETIMEDOUT/,
    /ECONNREFUSED/,
    /ENETUNREACH/,
    /fetch failed/i,
    /socket hang up/i,
  ];

  return retryablePatterns.some((pattern) => pattern.test(message));
}

// ============================================================================
// Main retry function
// ============================================================================

const DEFAULT_TIMEOUT_MS = 30_000;

export async function withRetry<T>(
  fn: (signal?: AbortSignal) => Promise<T>,
  options?: RetryOptions
): Promise<T> {
  const maxAttempts = options?.maxAttempts ?? 3;
  const baseDelayMs = options?.baseDelayMs ?? 1000;
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const label = options?.label ?? 'unknown';

  // Circuit breaker gate — fail fast if circuit is open
  await assertCircuitClosed(label);

  let lastError: unknown;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const result = await withTimeout(fn, timeoutMs);
      await recordSuccess(label);
      return result;
    } catch (error) {
      lastError = error;

      const isLastAttempt = attempt === maxAttempts - 1;
      if (isLastAttempt || !isRetryable(error)) {
        await recordFailure(label);
        throw error;
      }

      const delay = baseDelayMs * Math.pow(2, attempt) + Math.random() * (baseDelayMs / 2);
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.warn(
        `[withRetry:${label}] Attempt ${attempt + 1}/${maxAttempts} failed: ${errorMsg}. Retrying in ${Math.round(delay)}ms...`
      );

      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  await recordFailure(label);
  throw lastError;
}
