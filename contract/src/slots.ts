// Copyright (C) Shielded Technologies
// SPDX-License-Identifier: Apache-2.0

/**
 * Seat slots, for every game (table.compact section 9, backgammon.compact section 6).
 *
 * A join claims a pre-inserted slot -- an identity cell whose zero address means "free" -- so
 * two players can join in one block. While a table fills nothing on chain counts its players (a
 * count would be a read-modify-write), so the held slots are the count. The game readers
 * (table-slots.ts, bg-slots.ts) put their contract's map and slot count on these.
 */

/** A game's slot map, as the generated bindings expose it. */
export interface SlotIdentities {
  lookup(i: bigint): { addr: { bytes: Uint8Array }; keyCommit: Uint8Array };
}

const isEmpty = (b: Uint8Array): boolean => b.every((x) => x === 0);

export const sameBytes = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.every((x, j) => x === b[j]);

/** The slots someone holds, in index order. */
export function heldSlots(ids: SlotIdentities, count: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    if (!isEmpty(ids.lookup(BigInt(i)).addr.bytes)) out.push(i);
  }
  return out;
}

/** The slots nobody holds, in index order. */
export function freeSlots(ids: SlotIdentities, count: number): number[] {
  const held = new Set(heldSlots(ids, count));
  return [...Array(count).keys()].filter((i) => !held.has(i));
}

/** The slot a seat key holds, or null. */
export function slotHeldBy(
  ids: SlotIdentities,
  count: number,
  keyCommit: Uint8Array,
): number | null {
  for (const i of heldSlots(ids, count)) {
    if (sameBytes(ids.lookup(BigInt(i)).keyCommit, keyCommit)) return i;
  }
  return null;
}

/**
 * A free slot at random, or null when there is none. Random, so two players joining at once
 * collide one time in the number of free slots rather than every time.
 */
export function randomFreeSlot(
  ids: SlotIdentities,
  count: number,
  random: () => number = Math.random,
): number | null {
  const free = freeSlots(ids, count);
  return free.length === 0 ? null : free[Math.floor(random() * free.length)]!;
}
