// Copyright (C) Shielded Technologies
// SPDX-License-Identifier: Apache-2.0

/**
 * The operator's exemption from the indexer's per-IP rate limit.
 *
 * The public indexer blocks an address past **300 requests in 5 minutes** and then answers a
 * bare nginx `403` for the rest of the window — no GraphQL error, no Retry-After, and it applies
 * to everything behind that address. An operator polling dozens of tables lives close to that
 * line by design, and on 2026-09-13 crossed it repeatedly: ticks died, rounds went unclosed, and
 * a table sat unplayable while its seats waited on an operator that was being refused.
 *
 * Shielded's WAF exempts a request carrying a shared token in a header
 * (`x-shielded-ratelimit-bypass`; the rule is a `scope_down_statement` of `NOT(header == token)`,
 * so a matching request is never counted). The SDK's `indexerPublicDataProvider` takes a URL and
 * nothing else, so the only place to add a header to ITS requests is `fetch` itself.
 *
 * THE TOKEN IS A CREDENTIAL and this module is careful with it in three ways:
 *
 *   - it is read from the environment only — never a default, never in this repository;
 *   - it is attached ONLY to requests aimed at the configured indexer origin, so it cannot leak
 *     to any other host this process happens to call;
 *   - this is a Node-side module. Nothing here may be imported into the browser bundle, which
 *     is public static files: shipping the token there would publish it to everyone.
 */

/** Set once, so repeated calls (a restart in-process, a second wallet) do not re-wrap. */
let installed = false;

/**
 * When each indexer request was made, newest last, trimmed to the window below.
 *
 * COUNTED BECAUSE THE LIMIT IS COUNTED. The cap is 300 requests in 5 minutes per IP, and every
 * estimate of how close we run to it — including the ones in this repository's commit messages —
 * was arithmetic over the polling intervals, never a measurement. Arithmetic missed that the
 * daemon read every table twice a tick, and missed a per-tick lobby read that was two thirds of
 * the total. A number the process actually observed does not miss those.
 */
const requestTimes: number[] = [];
const WINDOW_MS = 5 * 60 * 1000;

function record(): void {
  const now = Date.now();
  requestTimes.push(now);
  // Trim from the front; the array is at most a few hundred entries by construction.
  while (requestTimes.length > 0 && now - requestTimes[0]! > WINDOW_MS) requestTimes.shift();
}

export interface IndexerRequestStats {
  /** Requests in the last 60 seconds. */
  readonly lastMinute: number;
  /** Requests in the last 5 minutes — the window the WAF actually counts. */
  readonly lastFiveMinutes: number;
  /** What the public indexer allows per IP in that window. */
  readonly capPerFiveMinutes: number;
  /** Whether this process is exempt from that cap. */
  readonly exempt: boolean;
}

let exemptNow = false;

/** What this process has asked the indexer for, lately. */
export function indexerRequestStats(): IndexerRequestStats {
  const now = Date.now();
  let lastMinute = 0;
  for (let i = requestTimes.length - 1; i >= 0; i--) {
    if (now - requestTimes[i]! > 60_000) break;
    lastMinute += 1;
  }
  return {
    lastMinute,
    lastFiveMinutes: requestTimes.length,
    capPerFiveMinutes: 300,
    exempt: exemptNow,
  };
}

export interface IndexerBypass {
  readonly enabled: boolean;
  readonly header?: string;
  readonly origin?: string;
}

/**
 * Attach the bypass header to every request this process makes to `indexerUrl`'s origin.
 *
 * Returns what it did, so a daemon can say so in its log — silently having or not having an
 * exemption is exactly the kind of thing that is discovered later, during an outage.
 */
export function installIndexerBypass(indexerUrl: string): IndexerBypass {
  const token = process.env.MIDNIGHT_INDEXER_BYPASS_TOKEN;
  const header = process.env.MIDNIGHT_INDEXER_BYPASS_HEADER ?? 'x-shielded-ratelimit-bypass';
  exemptNow = token !== undefined && token !== '';

  let origin: string;
  try {
    origin = new URL(indexerUrl).origin;
  } catch {
    return { enabled: false };
  }
  if (installed) return token ? { enabled: true, header, origin } : { enabled: false };

  const original = globalThis.fetch;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : (input as Request).url;
    let matches = false;
    try {
      matches = new URL(url).origin === origin;
    } catch {
      matches = false;
    }
    if (!matches) return original(input, init);
    record();
    // No token: the wrapper is here only to count, so pass the request through untouched.
    if (!token) return original(input, init);
    // Headers may arrive as a Headers, an array of pairs, or a plain object; `new Headers`
    // normalises all three, and setting after copying means a caller's own value wins only if
    // it set this same header deliberately.
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : {}));
    if (!headers.has(header)) headers.set(header, token);
    return original(input, { ...init, headers });
  };
  installed = true;
  return token ? { enabled: true, header, origin } : { enabled: false };
}
