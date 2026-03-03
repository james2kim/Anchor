interface RetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  label?: string;
}

function isRetryable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);

  // Check for status code properties on the error object
  const statusCode =
    (error as any)?.status ?? (error as any)?.statusCode ?? (error as any)?.response?.status;
  if (typeof statusCode === 'number') {
    if ([429, 500, 502, 503, 529].includes(statusCode)) return true;
    if (statusCode === 401 || statusCode === 403 || statusCode === 400) return false;
  }

  // Check error message for retryable patterns
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
    /fetch failed/i,
    /socket hang up/i,
    /network/i,
    /timeout/i,
  ];

  return retryablePatterns.some((pattern) => pattern.test(message));
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  options?: RetryOptions
): Promise<T> {
  const maxAttempts = options?.maxAttempts ?? 3;
  const baseDelayMs = options?.baseDelayMs ?? 1000;
  const label = options?.label ?? 'unknown';

  let lastError: unknown;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      const isLastAttempt = attempt === maxAttempts - 1;
      if (isLastAttempt || !isRetryable(error)) {
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

  throw lastError;
}
