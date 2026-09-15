// Copyright (C) Shielded Technologies
// SPDX-License-Identifier: Apache-2.0

/**
 * What the wrapper counts, and what it sends where.
 *
 * Both halves have bitten this project. The count exists because every statement about how close
 * the operator runs to the indexer's 300-per-5-minute cap was arithmetic over polling intervals,
 * and the arithmetic was wrong twice — it missed a double read per tick, then a per-tier lobby
 * read worth two thirds of the traffic. The header rule exists because the token is a shared
 * credential: a request to any other host must never carry it.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const INDEXER = 'https://indexer.example.test/api/v4/graphql';

describe('the indexer request wrapper', () => {
  let original: typeof globalThis.fetch;

  beforeEach(() => {
    original = globalThis.fetch;
    vi.resetModules();
    delete process.env.MIDNIGHT_INDEXER_BYPASS_TOKEN;
  });

  afterEach(() => {
    globalThis.fetch = original;
    delete process.env.MIDNIGHT_INDEXER_BYPASS_TOKEN;
  });

  it('counts requests to the indexer and ignores everything else', async () => {
    const seen: Request[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(new Request(input as RequestInfo, init));
      return new Response('{}');
    }) as typeof globalThis.fetch;

    const mod = await import('./indexer-bypass.js');
    mod.installIndexerBypass(INDEXER);

    await fetch(INDEXER, { method: 'POST' });
    await fetch(INDEXER, { method: 'POST' });
    await fetch('https://example.com/elsewhere');

    const stats = mod.indexerRequestStats();
    expect(stats.lastMinute).toBe(2);
    expect(stats.lastFiveMinutes).toBe(2);
    expect(stats.capPerFiveMinutes).toBe(300);
    expect(stats.exempt).toBe(false);
    expect(seen).toHaveLength(3);
  });

  it('sends the token to the indexer and to nowhere else', async () => {
    const seen: { url: string; token: string | null }[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input as RequestInfo, init);
      seen.push({ url: req.url, token: req.headers.get('x-shielded-ratelimit-bypass') });
      return new Response('{}');
    }) as typeof globalThis.fetch;

    process.env.MIDNIGHT_INDEXER_BYPASS_TOKEN = 'a-secret';
    const mod = await import('./indexer-bypass.js');
    const installed = mod.installIndexerBypass(INDEXER);
    expect(installed.enabled).toBe(true);

    await fetch(INDEXER, { method: 'POST' });
    await fetch('https://example.com/elsewhere');

    expect(seen[0]!.token).toBe('a-secret');
    expect(seen[1]!.token).toBeNull();
    expect(mod.indexerRequestStats().exempt).toBe(true);
  });
});
