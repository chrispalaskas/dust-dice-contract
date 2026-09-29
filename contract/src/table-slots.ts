// Copyright (C) Shielded Technologies
// SPDX-License-Identifier: Apache-2.0

/**
 * Reading a Yacht table's seat slots (table.compact section 9) -- the ONE place every reader asks
 * "who is at this table": the operator, the CLI, the website and both verifiers.
 *
 * While a table fills, `seatIdentity` 0..5 ARE the slots (a zero address is a free one) and
 * `seatCount` is 0. The start seats the joiners in join order, so from then on the players are
 * seats 0..seatCount-1 and a player finds its seat by its key commitment -- never by the slot it
 * joined, which is not its seat.
 */

import type { Ledger } from './managed/table/contract/index.js';
import { freeSlots, heldSlots, randomFreeSlot, sameBytes, slotHeldBy } from './slots.ts';

/** Slots a Yacht join may claim: `maxSeats()`, whatever the table's seat limit. */
export const TABLE_SLOT_COUNT = 6;

/** `Phase.filling`, as the bindings number it. */
const FILLING = 0;

type SlotLedger = Pick<
  Ledger,
  'phase' | 'seatCount' | 'activeSeats' | 'seatLimit' | 'seatIdentity'
>;

export const tableFilling = (l: Pick<Ledger, 'phase'>): boolean => Number(l.phase) === FILLING;

/** The slots someone holds, in index order (meaningful while filling). */
export function tableHeldSlots(l: SlotLedger): number[] {
  return heldSlots(l.seatIdentity, TABLE_SLOT_COUNT);
}

/** The slots nobody holds, in index order (meaningful while filling). */
export function tableFreeSlots(l: SlotLedger): number[] {
  return freeSlots(l.seatIdentity, TABLE_SLOT_COUNT);
}

/**
 * The players the start would count: held slots, one per entropy key. A second slot of one key
 * is refunded at the start and is not a player (`firstOfKey` in table.compact).
 */
export function tableJoinedPlayers(l: SlotLedger): number {
  const keys: Uint8Array[] = [];
  for (const i of tableHeldSlots(l)) {
    const k = l.seatIdentity.lookup(BigInt(i)).keyCommit;
    if (!keys.some((x) => sameBytes(x, k))) keys.push(k);
  }
  return keys.length;
}

/** Players at the table: the counted slots while it fills, the active seats once it has started. */
export function tablePlayerCount(l: SlotLedger): number {
  return tableFilling(l) ? tableJoinedPlayers(l) : Number(l.activeSeats);
}

/** Every seat is taken: the table starts at the next `abortTable`, by anybody. */
export function tableIsFull(l: SlotLedger): boolean {
  return tableFilling(l) && tableJoinedPlayers(l) >= Number(l.seatLimit);
}

/** The slot a seat key holds while the table fills, or null. */
export function tableSlotHeldBy(l: SlotLedger, keyCommit: Uint8Array): number | null {
  return tableFilling(l) ? slotHeldBy(l.seatIdentity, TABLE_SLOT_COUNT, keyCommit) : null;
}

/** The SEAT a key was given at the start, or null (not started, or not seated). */
export function tableSeatOf(l: SlotLedger, keyCommit: Uint8Array): number | null {
  if (tableFilling(l)) return null;
  for (let s = 0; s < Number(l.seatCount); s++) {
    if (sameBytes(l.seatIdentity.lookup(BigInt(s)).keyCommit, keyCommit)) return s;
  }
  return null;
}

/** A free slot at random, or null when there is none. */
export function tableRandomFreeSlot(
  l: SlotLedger,
  random: () => number = Math.random,
): number | null {
  return randomFreeSlot(l.seatIdentity, TABLE_SLOT_COUNT, random);
}

/**
 * The slots the start would seat, in seat order -- the mirror of `abortTable`'s start: the
 * earliest joiners by declared join time (the lower slot breaks a tie), one slot per entropy
 * key (its earliest), at most `seatLimit`. Seat `i` is the `i`-th slot here.
 */
export function tableStartOrder(l: SlotLedger & Pick<Ledger, 'slotJoinedAt'>): number[] {
  const order = (i: number): bigint => l.slotJoinedAt.lookup(BigInt(i)) * 8n + BigInt(i);
  const held = tableHeldSlots(l).sort((a, b) => (order(a) < order(b) ? -1 : 1));
  const keys: Uint8Array[] = [];
  const seated: number[] = [];
  for (const i of held) {
    const k = l.seatIdentity.lookup(BigInt(i)).keyCommit;
    if (keys.some((x) => sameBytes(x, k))) continue;
    keys.push(k);
    if (seated.length < Number(l.seatLimit)) seated.push(i);
  }
  return seated;
}
