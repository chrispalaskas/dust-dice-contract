// Copyright (C) Shielded Technologies
// SPDX-License-Identifier: Apache-2.0

/**
 * What must and must not be retried, and that the waiting actually backs off.
 *
 * The errors here are the real shapes seen in the field: nginx's bare 403 page reaching us as
 * `Error: indexer HTTP 403: <html>…`, Apollo's `ServerError` with the status on a nested
 * response, and undici's `fetch failed`.
 */

import { describe, expect, it, vi } from 'vitest';

import { isRetryableIndexerError, withIndexerRetry } from './indexer-retry.js';

const apolloServerError = (status: number): Error =>
  Object.assign(new Error(`Response not successful: Received status code ${status}`), {
    name: 'ServerError',
    statusCode: status,
    response: { status },
  });

describe('which indexer failures are worth retrying', () => {
  it('retries the burst throttling the public indexer answers with', () => {
    expect(isRetryableIndexerError(new Error('indexer HTTP 403: <html>403 Forbidden</html>'))).toBe(
      true,
    );
    expect(isRetryableIndexerError(apolloServerError(403))).toBe(true);
    expect(isRetryableIndexerError(apolloServerError(429))).toBe(true);
  });

  it('retries what a BROWSER says when a fetch never completes', () => {
    // The gap this pins: the matcher listed Node's "fetch failed" but not the browser's
    // wordings, so a lobby page that hit a blip showed the reader an error for a failure one
    // retry would have cleared — "Could not read the lobby … Failed to fetch", fixed by reload.
    const typeError = (message: string): Error =>
      Object.assign(new TypeError(message), { name: 'TypeError' });
    expect(isRetryableIndexerError(typeError('Failed to fetch'))).toBe(true); // Chrome
    expect(
      isRetryableIndexerError(typeError('NetworkError when attempting to fetch resource.')),
    ).toBe(true); // Firefox
    expect(isRetryableIndexerError(typeError('Load failed'))).toBe(true); // Safari
    // And a request this code cut off itself, which exists precisely to be tried again.
    expect(
      isRetryableIndexerError(Object.assign(new Error('aborted'), { name: 'AbortError' })),
    ).toBe(true);
    expect(isRetryableIndexerError(new Error('indexer request timed out after 12000 ms'))).toBe(
      true,
    );
  });

  it('retries server faults and requests that never landed', () => {
    for (const status of [500, 502, 503, 504, 408]) {
      expect(isRetryableIndexerError(apolloServerError(status))).toBe(true);
    }
    for (const message of [
      'fetch failed',
      'socket hang up',
      'ECONNRESET',
      'getaddrinfo EAI_AGAIN',
    ]) {
      expect(isRetryableIndexerError(new Error(message))).toBe(true);
    }
  });

  it('does NOT retry an answer the indexer meant — asking again cannot change it', () => {
    // A GraphQL error is a real answer: the query is wrong.
    expect(isRetryableIndexerError(new Error('indexer GraphQL: Unknown field "contract"'))).toBe(
      false,
    );
    expect(isRetryableIndexerError(apolloServerError(400))).toBe(false);
    expect(isRetryableIndexerError(apolloServerError(404))).toBe(false);
    expect(isRetryableIndexerError(new Error('no contract state at abc123'))).toBe(false);
  });
});

describe('withIndexerRetry', () => {
  const noJitter = { sleep: async () => {}, random: () => 0 };

  it('returns the first success without sleeping', async () => {
    const sleep = vi.fn(async () => {});
    const call = vi.fn(async () => 'ok');
    expect(await withIndexerRetry(call, { ...noJitter, sleep })).toBe('ok');
    expect(call).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('retries a throttled read and returns the answer when it clears', async () => {
    // One retry is all a quota refusal gets (see the rate-limit test below), so this clears on
    // the second attempt — the brief case, where another client tripped a shared limit.
    let calls = 0;
    const result = await withIndexerRetry(async () => {
      calls += 1;
      if (calls < 2) throw new Error('indexer HTTP 403: <html>403 Forbidden</html>');
      return 'state';
    }, noJitter);
    expect(result).toBe('state');
    expect(calls).toBe(2);
  });

  it('retries a server fault the full number of times, since retrying does fix those', async () => {
    let calls = 0;
    const result = await withIndexerRetry(async () => {
      calls += 1;
      if (calls < 4) throw new Error('indexer HTTP 503: upstream unavailable');
      return 'state';
    }, noJitter);
    expect(result).toBe('state');
    expect(calls).toBe(4);
  });

  it('doubles the wait between attempts and caps it', async () => {
    const waits: number[] = [];
    await expect(
      withIndexerRetry(
        async () => {
          throw apolloServerError(503);
        },
        {
          attempts: 6,
          baseDelayMs: 1_000,
          maxDelayMs: 4_000,
          random: () => 0,
          sleep: async (ms) => {
            waits.push(ms);
          },
        },
      ),
    ).rejects.toThrow('503');
    expect(waits).toEqual([1_000, 2_000, 4_000, 4_000, 4_000]);
  });

  it('stops after TWO tries when the failure is a rate limit — the retry is the load', async () => {
    // The indexer blocks an IP for five minutes past 300 requests in five minutes, answering
    // 403 throughout. Five attempts is five more requests inside the window that is counting
    // them; the caller's own pacing has to take over instead.
    const call = vi.fn(async () => {
      throw apolloServerError(403);
    });
    await expect(withIndexerRetry(call, { ...noJitter, attempts: 5 })).rejects.toThrow('403');
    expect(call).toHaveBeenCalledTimes(2);

    const throttled = vi.fn(async () => {
      throw apolloServerError(429);
    });
    await expect(withIndexerRetry(throttled, { ...noJitter, attempts: 5 })).rejects.toThrow('429');
    expect(throttled).toHaveBeenCalledTimes(2);
  });

  it('still tries five times for a server fault, which retrying does fix', async () => {
    const call = vi.fn(async () => {
      throw apolloServerError(503);
    });
    await expect(withIndexerRetry(call, { ...noJitter, attempts: 5 })).rejects.toThrow('503');
    expect(call).toHaveBeenCalledTimes(5);
  });

  it('gives up after the last attempt and throws the indexer’s own error', async () => {
    const err = apolloServerError(503);
    const call = vi.fn(async () => {
      throw err;
    });
    await expect(withIndexerRetry(call, { ...noJitter, attempts: 3 })).rejects.toBe(err);
    expect(call).toHaveBeenCalledTimes(3);
  });

  it('rethrows a non-retryable failure immediately', async () => {
    const call = vi.fn(async () => {
      throw new Error('indexer GraphQL: Unknown field "contract" on type "Query"');
    });
    await expect(withIndexerRetry(call, noJitter)).rejects.toThrow('Unknown field');
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('reports each retry so a daemon can say why it paused', async () => {
    const notices: string[] = [];
    await withIndexerRetry(
      (() => {
        let n = 0;
        return async () => {
          n += 1;
          if (n === 1) throw new Error('indexer HTTP 429: slow down');
          return n;
        };
      })(),
      {
        ...noJitter,
        onRetry: ({ attempt, of, delayMs }) => notices.push(`${attempt}/${of} in ${delayMs}ms`),
      },
    );
    expect(notices).toEqual(['1/2 in 500ms']);
  });
});
