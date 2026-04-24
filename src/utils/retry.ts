import { Logger } from './logger.js';

/**
 * Options for the retry utility
 */
export interface RetryOptions {
  maxAttempts?: number;
  delay?: number;
  factor?: number;
  shouldRetry?: (error: unknown) => boolean;
}

/**
 * Retries an asynchronous function with exponential backoff
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const {
    maxAttempts = 3,
    delay = 1000,
    factor = 2,
    shouldRetry = (err: unknown) => {
      const message = (err instanceof Error ? err.message : String(err)).toLowerCase();
      // Retry on common network errors
      return (
        message.includes('fetch failed') ||
        message.includes('socket hang up') ||
        message.includes('timeout') ||
        message.includes('econnreset') ||
        message.includes('rate limit') ||
        message.includes('429') ||
        message.includes('resource_exhausted') ||
        message.includes('503') ||
        message.includes('502') ||
        message.includes('504')
      );
    },
  } = options;

  let lastError: unknown;
  let currentDelay = delay;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error: unknown) {
      lastError = error;
      
      const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
      const isRateLimit = message.includes('429') || message.includes('rate limit') || message.includes('quota') || message.includes('resource_exhausted');

      if (attempt === maxAttempts || !shouldRetry(error)) {
        throw error;
      }

      // 🔍 Precision Retry: Look for specific retry instructions (e.g., "retry in 42s")
      let waitTime = currentDelay;
      
      const retryMatch = message.match(/retry in ([\d.]+)\s*s/i);
      if (retryMatch && retryMatch[1]) {
        waitTime = Math.ceil(parseFloat(retryMatch[1]) * 1000) + 2000; // Add 2s safety buffer
      } else if (isRateLimit && waitTime < 10000) {
        waitTime = 10000;
      }

      Logger.warn(`Retry Attempt ${attempt} failed: ${message.slice(0, 150)}. Waiting ${waitTime}ms...`);
      await new Promise((resolve) => globalThis.setTimeout(resolve, waitTime));
      
      // Update delay for next iteration (exponential backoff)
      currentDelay = Math.max(currentDelay * factor, waitTime);
      
      if (currentDelay > 90000) {
        currentDelay = 90000; // Cap at 90s
      }
    }
  }

  throw lastError;
}
