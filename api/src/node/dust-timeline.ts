// Copyright (C) Shielded Technologies
// SPDX-License-Identifier: Apache-2.0

// Where a fresh dust wallet starts on a chain that crossed into ledger 9: after the last dust event
// below the boundary, so it never replays the ledger-8 dust history.
//
// wallet-sdk-dust-wallet 5.0.0 has this search (`skipLedgerV8DustHistory`), but it runs its probes
// on one connection whose client leaves each probe's subscription streaming history. Against
// Blockfrost every probe then answers later than the last until one passes the SDK's 10 s bound;
// the search answers nothing and the wallet replays every ledger-8 dust event, which on mainnet is
// about ten hours. Completing each subscription before opening the next, it takes half a second.

import { Option } from 'effect';
import type { DustTimelineStartProbe, DustWalletTypes } from '@midnightntwrk/wallet-sdk';

/** One dust ledger event as the search reads it: its id, the timeline's tip, and its protocol. */
export type DustEventMark = { id: number; maxId: number; protocolVersion: bigint };

/** The first dust event at or after `id`; `null` asks for the first one ever. */
export type DustEventProbe = (id: number | null) => Promise<DustEventMark>;

/**
 * The SDK's own narrowing (`findDustTimelineStart`), step for step, on any probe — so the cursor is
 * exactly the one the SDK would have found. Nothing when the timeline never crosses `boundary`.
 */
export async function searchDustTimelineStart(
  probe: DustEventProbe,
  boundary: bigint,
): Promise<Option.Option<{ cursor: bigint; version: bigint }>> {
  const first = await probe(null);
  const last = await probe(first.maxId);
  if (first.protocolVersion >= boundary || last.protocolVersion < boundary) return Option.none();
  let low = first.id + 1;
  let high = last.id;
  let atHigh = last;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    const probed = await probe(middle);
    if (probed.protocolVersion >= boundary) {
      high = middle;
      atHigh = probed;
    } else {
      low = probed.id + 1;
    }
  }
  return Option.some({ cursor: BigInt(low - 1), version: atHigh.protocolVersion });
}

const QUERY =
  'subscription DustEventMark($id: Int) { dustLedgerEvents(id: $id) { id maxId protocolVersion } }';

type Connection = { probe: DustEventProbe; close: () => void };

/** One graphql-transport-ws connection that asks for one event at a time and ends each ask. */
function connect(wsUrl: string, timeoutMs: number): Promise<Connection> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl, 'graphql-transport-ws');
    const pending = new Map<string, { ok: (e: DustEventMark) => void; fail: (e: Error) => void }>();
    let nextId = 0;
    const failAll = (err: Error) => {
      for (const p of pending.values()) p.fail(err);
      pending.clear();
    };
    const ackTimer = setTimeout(() => {
      reject(new Error(`no connection_ack in ${timeoutMs} ms`));
      ws.close();
    }, timeoutMs);
    const lost = (err: Error) => {
      clearTimeout(ackTimer);
      reject(err);
      failAll(err);
    };

    const probe: DustEventProbe = (id) => {
      const sid = String(++nextId);
      return new Promise<DustEventMark>((ok, fail) => {
        const timer = setTimeout(
          () => fail(new Error(`no dust event from ${id} in ${timeoutMs} ms`)),
          timeoutMs,
        );
        pending.set(sid, {
          ok: (e) => (clearTimeout(timer), ok(e)),
          fail: (e) => (clearTimeout(timer), fail(e)),
        });
        ws.send(
          JSON.stringify({
            id: sid,
            type: 'subscribe',
            payload: { query: QUERY, variables: { id } },
          }),
        );
      }).finally(() => {
        // Ending the subscription as soon as it answered is the whole fix: left open, it streams on.
        pending.delete(sid);
        if (ws.readyState === WebSocket.OPEN)
          ws.send(JSON.stringify({ id: sid, type: 'complete' }));
      });
    };

    ws.addEventListener('open', () =>
      ws.send(JSON.stringify({ type: 'connection_init', payload: {} })),
    );
    ws.addEventListener('error', () => lost(new Error('indexer WebSocket error')));
    ws.addEventListener('close', (ev) => lost(new Error(`indexer WebSocket closed (${ev.code})`)));
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(String(ev.data));
      if (msg.type === 'connection_ack') {
        clearTimeout(ackTimer);
        resolve({ probe, close: () => ws.close() });
      } else if (msg.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong' }));
      } else {
        const p = pending.get(msg.id);
        const event = msg.payload?.data?.dustLedgerEvents;
        if (p === undefined) return;
        if (msg.type === 'next' && event) {
          p.ok({
            id: Number(event.id),
            maxId: Number(event.maxId),
            protocolVersion: BigInt(event.protocolVersion),
          });
        } else if (msg.type === 'complete') {
          p.fail(new Error('the indexer ended a dust event probe with no event'));
        } else {
          p.fail(
            new Error(`dust event probe refused: ${JSON.stringify(msg.payload).slice(0, 200)}`),
          );
        }
      }
    });
  });
}

/**
 * The dust wallet's `dustTimelineStartProbe`: the search above over one connection to the indexer.
 * Any failure answers nothing, which the SDK takes as "start from the beginning"; it is reported,
 * because that start is hours long and otherwise silent.
 */
export function dustTimelineStartProbe(
  indexerWsUrl: string,
  boundary: bigint,
  probeTimeoutMs = 5_000,
): DustTimelineStartProbe {
  return async () => {
    const started = Date.now();
    let conn: Connection | undefined;
    try {
      conn = await connect(indexerWsUrl, probeTimeoutMs);
      const found = await searchDustTimelineStart(conn.probe, boundary);
      return Option.map(found, ({ cursor, version }) => ({
        cursor,
        version: version as DustWalletTypes.DustTimelineStart['version'],
      }));
    } catch (err) {
      console.warn(
        `dust timeline search failed after ${Date.now() - started} ms; this wallet replays the dust ` +
          `history from the start: ${(err as Error).message}`,
      );
      return Option.none();
    } finally {
      conn?.close();
    }
  };
}
