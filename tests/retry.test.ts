import test from 'node:test';
import assert from 'node:assert/strict';
import { withRetry } from '../src/utils/retry.js';

test('withRetry returns result immediately on first attempt success', async () => {
  let calls = 0;
  const result = await withRetry(async () => {
    calls++;
    return 'success';
  }, { maxAttempts: 3, delay: 5 });

  assert.equal(result, 'success');
  assert.equal(calls, 1);
});

test('withRetry retries on transient network error and succeeds', async () => {
  let calls = 0;
  const result = await withRetry(async () => {
    calls++;
    if (calls < 2) {
      throw new Error('socket hang up');
    }
    return 'recovered';
  }, { maxAttempts: 3, delay: 5 });

  assert.equal(result, 'recovered');
  assert.equal(calls, 2);
});

test('withRetry fails immediately on non-retryable error', async () => {
  let calls = 0;
  await assert.rejects(
    async () => {
      await withRetry(async () => {
        calls++;
        throw new Error('fatal authorization error');
      }, {
        maxAttempts: 3,
        delay: 5,
        shouldRetry: (err) => (err instanceof Error ? err.message.includes('socket hang up') : false),
      });
    },
    /fatal authorization error/
  );
  assert.equal(calls, 1);
});
