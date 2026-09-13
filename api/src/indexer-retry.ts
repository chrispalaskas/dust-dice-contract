// Copyright (C) Shielded Technologies
// SPDX-License-Identifier: Apache-2.0

/**
 * Retrying an indexer query that failed for a reason that will probably not repeat.
 *
 * The public preprod indexer throttles in bursts: a run of `contractAction` queries from one
 * address starts answering `403 Forbidden` — an nginx page, not a GraphQL error — for a minute
 * or two, while trivial queries from the same address keep returning 200, and then it clears on
 * its own. Measured 2026-09-13: every `contractAction` query from the operator VM was refused
 * for several minutes, then all of them succeeded again with no change at either end.
 *
 * Untreated, that is an outage. The daemon's tick reads a table, the read throws, the tick dies,
 * and with enough of them in a row the tables stop being driven — which is what
 * "tick failed: indexer HTTP 403" and the OUTAGE lines in its log were.
 *
 * WHAT IS NOT RETRIED matters as much: a GraphQL error (the query is wrong, and asking again
 * will not fix it), a 400, a 404, or anything that parsed as a real answer. Retrying those turns
 * a clear failure into a slow one. Only transport-level refusals and server faults are retried —
 * 403/408/429 and 5xx, plus the network errors that mean the request never landed.
 *
 * Callers keep their own error types: this wraps a call, it does not translate anything.
 */

/** How a failed attempt is reported, for a caller that wants to log the wait. */
export interface IndexerRetryNotice {
  readonly attempt: number;
  readonly of: number;
  readonly delayMs: number;
  readonly error: unknown;
}

export interface IndexerRetryOptions {
  /** Total attempts, including the first. Default 5 — about 15 s of waiting in all. */
  readonly attempts?: number;
  /** First backoff step; each retry doubles it. Default 500 ms. */
  readonly baseDelayMs?: number;
  /** Cap on any single wait. Default 8 s: a tick that waits longer has already missed its turn. */
  readonly maxDelayMs?: number;
  readonly onRetry?: (notice: IndexerRetryNotice) => void;
  /** Injected for tests, so they need not sleep. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Injected for tests, so the jitter is not random. */
  readonly random?: () => number;
}

const RETRYABLE_STATUS = new Set([403, 408, 425, 429, 500, 502, 503, 504]);

/**
 * Network failures worth another go: the request never reached the indexer, so nothing it says
 * can be trusted as an answer. Matched on message text because this crosses four HTTP clients
 * — browser fetch, undici, Apollo, and whatever the SDK wraps them in — that agree on nothing.
 *
 * THE BROWSER WORDINGS ARE NOT OPTIONAL. Chrome says "Failed to fetch", Firefox "NetworkError
 * when attempting to fetch resource", Safari "Load failed"; Node says "fetch failed". Listing
 * only the Node one — as this did until 2026-09-13 — means a lobby page that hits a blip shows
 * the reader an error for a failure that a single retry would have cleared, which is exactly
 * what happened: "Could not read the lobby … Failed to fetch", fixed by pressing reload.
 *
 * An aborted request counts too: `fetchWithTimeout` below cuts off a request that hangs, and the
 * whole point of cutting it off is to try again.
 */
const RETRYABLE_TEXT =
  /(fetch failed|failed to fetch|networkerror|load failed|network error|socket hang up|connect timeout|request timed out|timeouterror|the operation was aborted|aborterror|signal is aborted|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|UND_ERR)/i;

/** The HTTP status an error carries, wherever the client happened to put it. */
function statusOf(err: unknown): number | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const e = err as Record<string, unknown>;
  for (const key of ['statusCode', 'status']) {
    const v = e[key];
    if (typeof v === 'number') return v;
  }
  // Apollo's ServerError keeps it on a nested response, and says it in the message besides:
  // "Response not successful: Received status code 403".
  const response = e.response as { status?: unknown } | undefined;
  if (response && typeof response.status === 'number') return response.status;
  const message = typeof e.message === 'string' ? e.message : '';
  const m = /(?:status code|HTTP)\s+(\d{3})\b/i.exec(message);
  return m ? Number(m[1]) : undefined;
}

export function isRetryableIndexerError(err: unknown): boolean {
  const status = statusOf(err);
  if (status !== undefined) return RETRYABLE_STATUS.has(status);
  // `TypeError` is what the browser throws when a fetch never completes — DNS, a dropped
  // connection, a refused preflight. Its `name` is stable where its message is not.
  const name = err instanceof Error ? err.name : '';
  if (name === 'TypeError' || name === 'AbortError' || name === 'TimeoutError') return true;
  const message = err instanceof Error ? err.message : String(err);
  return RETRYABLE_TEXT.test(message);
}

/**
 * `fetch` with a deadline, because nothing else bounds one.
 *
 * A request left to hang holds the page: the lobby showed "Failed to fetch" after more than
 * thirty seconds of nothing, when failing at ten and retrying would have been invisible. The
 * abort surfaces as a retryable error, so `withIndexerRetry` picks it up.
 */
export async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit = {},
  timeoutMs = 12_000,
): Promise<Response> {
  const abort = new AbortController();
  const timer = setTimeout(
    () => abort.abort(new Error(`indexer request timed out after ${timeoutMs} ms`)),
    timeoutMs,
  );
  try {
    return await fetch(input, { ...init, signal: abort.signal });
  } finally {
    clearTimeout(timer);
  }
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run an indexer call, retrying the failures that are worth retrying.
 *
 * Backoff doubles from `baseDelayMs` and carries up to 25% jitter, so a daemon whose reads all
 * fail at once does not march back in lockstep and trip the same limit again.
 */
export async function withIndexerRetry<T>(
  call: () => Promise<T>,
  options: IndexerRetryOptions = {},
): Promise<T> {
  const attempts = options.attempts ?? 5;
  const baseDelayMs = options.baseDelayMs ?? 500;
  const maxDelayMs = options.maxDelayMs ?? 8_000;
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;

  for (let attempt = 1; ; attempt++) {
    try {
      return await call();
    } catch (err) {
      if (attempt >= attempts || !isRetryableIndexerError(err)) throw err;
      const backoff = Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs);
      const delayMs = Math.round(backoff * (1 + 0.25 * random()));
      options.onRetry?.({ attempt, of: attempts, delayMs, error: err });
      await sleep(delayMs);
    }
  }
}
