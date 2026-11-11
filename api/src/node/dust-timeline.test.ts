// Copyright (C) Shielded Technologies
// SPDX-License-Identifier: Apache-2.0

/**
 * The search must land on the cursor the SDK's own search would: one event early serves the
 * ledger-9 variant an event its ledger cannot read, one late skips an event.
 */

import { describe, it, expect } from 'vitest';
import { Option } from 'effect';

import { searchDustTimelineStart, type DustEventMark } from './dust-timeline.js';

const BOUNDARY = 2_000_000n;

/** A timeline of dust events (id, version), probed the way the indexer answers. */
function timeline(events: Array<[number, bigint]>) {
  const maxId = events[events.length - 1][0];
  let probes = 0;
  const probe = async (id: number | null): Promise<DustEventMark> => {
    probes++;
    const e = events.find(([eid]) => id === null || eid >= id);
    if (e === undefined) throw new Error(`no event from ${id}`);
    return { id: e[0], maxId, protocolVersion: e[1] };
  };
  return { probe, probes: () => probes };
}

/** The answer by a plain scan: the last event under the boundary, and the first one's version. */
function byScan(events: Array<[number, bigint]>) {
  const firstAt = events.findIndex(([, v]) => v >= BOUNDARY);
  return { cursor: BigInt(events[firstAt - 1][0]), version: events[firstAt][1] };
}

describe('the dust timeline search', () => {
  it('finds the last ledger-8 event on a dense timeline, in a logarithmic number of probes', async () => {
    const events: Array<[number, bigint]> = [];
    for (let id = 1; id <= 1_977_119; id++)
      events.push([id, id < 1_623_187 ? 1_000_300n : 2_001_100n]);
    const t = timeline(events);
    const found = await searchDustTimelineStart(t.probe, BOUNDARY);
    expect(found).toEqual(Option.some({ cursor: 1_623_186n, version: 2_001_100n }));
    expect(t.probes()).toBeLessThanOrEqual(25);
  });

  it('steps over the ids zswap events hold', async () => {
    const events: Array<[number, bigint]> = [];
    for (let id = 1; id <= 5_001; id += 2) events.push([id, id < 3_001 ? 1_000_300n : 2_001_100n]);
    const found = await searchDustTimelineStart(timeline(events).probe, BOUNDARY);
    expect(found).toEqual(Option.some(byScan(events)));
  });

  it('crosses more than one earlier version on the way', async () => {
    const events: Array<[number, bigint]> = [];
    for (let id = 1; id <= 900; id++) {
      events.push([id * 3, id < 100 ? 22_000n : id < 640 ? 1_000_300n : 2_001_100n]);
    }
    const found = await searchDustTimelineStart(timeline(events).probe, BOUNDARY);
    expect(found).toEqual(Option.some(byScan(events)));
  });

  it('answers nothing on a chain born on ledger 9, or one that has not crossed', async () => {
    const born: Array<[number, bigint]> = [
      [1, 2_000_000n],
      [2, 2_001_100n],
    ];
    const before: Array<[number, bigint]> = [
      [1, 22_000n],
      [2, 1_000_300n],
    ];
    expect(await searchDustTimelineStart(timeline(born).probe, BOUNDARY)).toEqual(Option.none());
    expect(await searchDustTimelineStart(timeline(before).probe, BOUNDARY)).toEqual(Option.none());
  });
});
