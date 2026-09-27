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

/** The contract's `slotCount()`; src/test/backgammon.test.ts holds the two together. */
export const BG_SLOT_COUNT = 8;

/** `BgPhase.filling`, as the bindings number it. */
const FILLING = 0;

type SlotLedger = Pick<Ledger, 'phase' | 'seatCount' | 'slotIdentity' | 'slotJoinedAt'>;

const isEmpty = (b: Uint8Array): boolean => b.every((x) => x === 0);

/** The slots someone holds, in index order. */
export function bgHeldSlots(l: SlotLedger): number[] {
  const out: number[] = [];
  for (let i = 0; i < BG_SLOT_COUNT; i++) {
    if (!isEmpty(l.slotIdentity.lookup(BigInt(i)).addr.bytes)) out.push(i);
  }
  return out;
}

/** The slots nobody holds, in index order. */
export function bgFreeSlots(l: SlotLedger): number[] {
  const held = new Set(bgHeldSlots(l));
  return [...Array(BG_SLOT_COUNT).keys()].filter((i) => !held.has(i));
}

/** Players at the table: the held slots while it fills, the seats once it has started. */
export function bgPlayerCount(l: SlotLedger): number {
  return Number(l.phase) === FILLING ? bgHeldSlots(l).length : Number(l.seatCount);
}

/** When the latest join was declared -- a filling table's clock (`abortTable`). 0 when empty. */
export function bgLastJoinAt(l: SlotLedger): bigint {
  let latest = 0n;
  for (const i of bgHeldSlots(l)) {
    const t = l.slotJoinedAt.lookup(BigInt(i));
    if (t > latest) latest = t;
  }
  return latest;
}

/** The slot a seat key holds while the table fills, or null. */
export function bgSlotHeldBy(l: SlotLedger, keyCommit: Uint8Array): number | null {
  const same = (x: Uint8Array): boolean =>
    x.length === keyCommit.length && x.every((b, j) => b === keyCommit[j]);
  for (const i of bgHeldSlots(l)) {
    if (same(l.slotIdentity.lookup(BigInt(i)).keyCommit)) return i;
  }
  return null;
}

/**
 * A free slot at random, or null when there is none. Random, so two players joining at once
 * collide one time in `BG_SLOT_COUNT` rather than every time.
 */
export function bgRandomFreeSlot(l: SlotLedger, random: () => number = Math.random): number | null {
  const free = bgFreeSlots(l);
  return free.length === 0 ? null : free[Math.floor(random() * free.length)]!;
}
