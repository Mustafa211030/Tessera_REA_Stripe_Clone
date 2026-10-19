import { ApiError } from '../lib/errors.ts';

/**
 * Object-level locks. Concurrent mutations of the same object wait briefly, then fail
 * with 429 `lock_timeout`, the same contract the public API documents.
 */
const held = new Map<string, Promise<void>>();

export async function withLock<T>(key: string, fn: () => Promise<T>, timeoutMs = 2000): Promise<T> {
  const start = Date.now();
  while (held.has(key)) {
    if (Date.now() - start > timeoutMs) {
      throw new ApiError(429, 'invalid_request_error', 'This object cannot be accessed right now because another API request or process is currently accessing it. If you see this error intermittently, retry the request.', { code: 'lock_timeout' });
    }
    await Promise.race([held.get(key), new Promise((r) => setTimeout(r, 25))]);
  }
  let release!: () => void;
  held.set(key, new Promise<void>((r) => (release = r)));
  try {
    return await fn();
  } finally {
    held.delete(key);
    release();
  }
}
