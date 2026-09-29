// Copyright (C) Shielded Technologies
// SPDX-License-Identifier: Apache-2.0

/**
 * Reading a Backgammon table's seat slots (backgammon.compact section 6) -- the ONE place every
 * reader asks "who is at this table": the operator, the CLI, the website and both verifiers.
 *
 * While a table fills nothing on chain counts its players (a count would be a read-modify-write,
 * and two joins could not both land), so the count is the held slots. From the start on it is
 * `seatCount`, and the players are seats 0 and 1.
 */

import type { Ledger } from './managed/backgammon/contract/index.js';
import { freeSlots, heldSlots, randomFreeSlot, slotHeldBy } from './slots.ts';

/** The contract's `slotCount()`; src/test/backgammon.test.ts holds the two together. */
export const BG_SLOT_COUNT = 8;

/** `BgPhase.filling`, as the bindings number it. */
const FILLING = 0;

type SlotLedger = Pick<Ledger, 'phase' | 'seatCount' | 'joinSlots'>;

/** The slots someone holds, in index order. */
export function bgHeldSlots(l: SlotLedger): number[] {
  return heldSlots(l.joinSlots, BG_SLOT_COUNT);
}

/** The slots nobody holds, in index order. */
export function bgFreeSlots(l: SlotLedger): number[] {
  return freeSlots(l.joinSlots, BG_SLOT_COUNT);
}

/** Players at the table: the held slots while it fills, the seats once it has started. */
export function bgPlayerCount(l: SlotLedger): number {
  return Number(l.phase) === FILLING ? bgHeldSlots(l).length : Number(l.seatCount);
}

/** When the latest join was declared -- a filling table's clock (`abortTable`). 0 when empty. */
export function bgLastJoinAt(l: SlotLedger): bigint {
  let latest = 0n;
  for (const i of bgHeldSlots(l)) {
    const t = l.joinSlots.lookup(BigInt(i)).joinedAt;
    if (t > latest) latest = t;
  }
  return latest;
}

/** The slot a seat key holds while the table fills, or null. */
export function bgSlotHeldBy(l: SlotLedger, keyCommit: Uint8Array): number | null {
  return slotHeldBy(l.joinSlots, BG_SLOT_COUNT, keyCommit);
}

/**
 * A free slot at random, or null when there is none. Random, so two players joining at once
 * collide one time in `BG_SLOT_COUNT` rather than every time.
 */
export function bgRandomFreeSlot(l: SlotLedger, random: () => number = Math.random): number | null {
  return randomFreeSlot(l.joinSlots, BG_SLOT_COUNT, random);
}

/**
 * The two slots `start` seats, in seat order -- the two EARLIEST joiners by declared time, the
 * slot breaking a tie, exactly the contract's `pickTwo` -- or null with fewer than two held.
 * The operator needs it before it can answer the opening: the opening's VRF point hashes the
 * two seated joiners' join entropies (backgammon.compact `start`).
 */
export function bgStartPick(l: SlotLedger): [number, number] | null {
  const order = bgHeldSlots(l)
    .map((i) => ({ i, key: l.joinSlots.lookup(BigInt(i)).joinedAt * 16n + BigInt(i) }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return order.length < 2 ? null : [order[0]!.i, order[1]!.i];
}
