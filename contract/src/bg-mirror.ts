// Copyright (C) Shielded Technologies
// SPDX-License-Identifier: Apache-2.0

/**
 * TypeScript mirror of backgammon-dice.compact: the Backgammon table's rolls and forced entropy.
 *
 * Together with api/src/backgammon.ts (the board rules) this IS the Backgammon verifier's
 * randomness half: given the public log and the seed revealed at settle, it reproduces every
 * roll of a game with no proof server and no chain. src/test/backgammon.test.ts holds it to the
 * contract's own `pureCircuits` on random inputs, so any edit to the Compact must land here too.
 */

import {
  CompactTypeBytes,
  CompactTypeUnsignedInteger,
  persistentHash,
  type CompactType,
} from '@midnight-ntwrk/compact-runtime';

import { dieFromBytes, pad } from './dice-mirror.ts';

export const BG_ROLL_DOMAIN: Uint8Array = pad(32, 'dust-dice:bg:v1:roll');
export const BG_ENTROPY_DOMAIN: Uint8Array = pad(32, 'dust-dice:bg:v1:entropy');

/** Stream 0 rolls a ply; stream 1 is the opening. */
export const BG_STREAM_PLY = 0n;
export const BG_STREAM_OPENING = 1n;

/** Accept a byte below this for the opening's five-face die; buckets of 50. */
export const FIVE_ACCEPT_LIMIT = 250;

const BYTES32 = new CompactTypeBytes(32);
const UINT8 = new CompactTypeUnsignedInteger(255n, 1);
const UINT16 = new CompactTypeUnsignedInteger(65535n, 2);

export type BgRollContextTs = {
  domain: Uint8Array;
  tableId: Uint8Array;
  seed: Uint8Array;
  entropy: Uint8Array;
  other: Uint8Array;
  turn: bigint;
  stream: bigint;
};

const BG_ROLL_CONTEXT_TYPE: CompactType<BgRollContextTs> = {
  alignment: () =>
    BYTES32.alignment()
      .concat(BYTES32.alignment())
      .concat(BYTES32.alignment())
      .concat(BYTES32.alignment())
      .concat(BYTES32.alignment())
      .concat(UINT16.alignment())
      .concat(UINT8.alignment()),
  toValue: (v: BgRollContextTs) =>
    BYTES32.toValue(v.domain)
      .concat(BYTES32.toValue(v.tableId))
      .concat(BYTES32.toValue(v.seed))
      .concat(BYTES32.toValue(v.entropy))
      .concat(BYTES32.toValue(v.other))
      .concat(UINT16.toValue(v.turn))
      .concat(UINT8.toValue(v.stream)),
  fromValue: (value) => ({
    domain: BYTES32.fromValue(value),
    tableId: BYTES32.fromValue(value),
    seed: BYTES32.fromValue(value),
    entropy: BYTES32.fromValue(value),
    other: BYTES32.fromValue(value),
    turn: UINT16.fromValue(value),
    stream: UINT8.fromValue(value),
  }),
};

type BgEntropyContextTs = { domain: Uint8Array; sk: Uint8Array; tableId: Uint8Array; turn: bigint };

const BG_ENTROPY_CONTEXT_TYPE: CompactType<BgEntropyContextTs> = {
  alignment: () =>
    BYTES32.alignment()
      .concat(BYTES32.alignment())
      .concat(BYTES32.alignment())
      .concat(UINT16.alignment()),
  toValue: (v: BgEntropyContextTs) =>
    BYTES32.toValue(v.domain)
      .concat(BYTES32.toValue(v.sk))
      .concat(BYTES32.toValue(v.tableId))
      .concat(UINT16.toValue(v.turn)),
  fromValue: (value) => ({
    domain: BYTES32.fromValue(value),
    sk: BYTES32.fromValue(value),
    tableId: BYTES32.fromValue(value),
    turn: UINT16.fromValue(value),
  }),
};

/** A seat's forced entropy for ply `turn`: `H(sk, tableId, turn)`. Mirrors `bgForcedEntropy`. */
export function bgForcedEntropyTs(
  sk: Uint8Array,
  tableId: Uint8Array,
  turn: number | bigint,
): Uint8Array {
  return persistentHash(BG_ENTROPY_CONTEXT_TYPE, {
    domain: BG_ENTROPY_DOMAIN,
    sk,
    tableId,
    turn: BigInt(turn),
  });
}

/** The 32 bytes behind one roll. Mirrors `bgRollBytes`. */
export function bgRollBytesTs(
  tableId: Uint8Array,
  seed: Uint8Array,
  entropy: Uint8Array,
  other: Uint8Array,
  turn: number | bigint,
  stream: bigint,
): Uint8Array {
  return persistentHash(BG_ROLL_CONTEXT_TYPE, {
    domain: BG_ROLL_DOMAIN,
    tableId,
    seed,
    entropy,
    other,
    turn: BigInt(turn),
    stream,
  });
}

/** 1..5 from candidate bytes; the opening's second die before it skips the first's face. */
export function fiveFromBytes(cands: ArrayLike<number>): number {
  for (let i = 0; i < cands.length; i++) {
    const b = cands[i]!;
    if (b < FIVE_ACCEPT_LIMIT) {
      return 1 + (b >= 50 ? 1 : 0) + (b >= 100 ? 1 : 0) + (b >= 150 ? 1 : 0) + (b >= 200 ? 1 : 0);
    }
  }
  return 1;
}

/** The two dice. For the opening, `a` is seat 0's die and `b` seat 1's, never equal. */
export type BgDiceTs = { a: number; b: number };

/** Mirrors `bgDice`: the dice for ply `turn`, or when `opening` the two opening dice. */
export function bgDiceTs(
  tableId: Uint8Array,
  seed: Uint8Array,
  entropy: Uint8Array,
  other: Uint8Array,
  turn: number | bigint,
  opening: boolean,
): BgDiceTs {
  const v = bgRollBytesTs(
    tableId,
    seed,
    entropy,
    other,
    turn,
    opening ? BG_STREAM_OPENING : BG_STREAM_PLY,
  );
  const a = dieFromBytes(v.subarray(0, 4));
  if (!opening) return { a, b: dieFromBytes(v.subarray(4, 8)) };
  const five = fiveFromBytes(v.subarray(4, 8));
  return { a, b: five + (five >= a ? 1 : 0) };
}

/**
 * The roll `resolveRoll` makes, from the public ledger: at ply 0 the opening from both seats'
 * e(1); after that the mover's pending entropy with the opponent's.
 */
export function bgRollForPly(
  tableId: Uint8Array,
  seed: Uint8Array,
  pending: readonly [Uint8Array, Uint8Array],
  turn: number,
  mover: number,
): BgDiceTs {
  const opening = turn === 0;
  const first = opening || mover === 0;
  return bgDiceTs(
    tableId,
    seed,
    first ? pending[0] : pending[1],
    first ? pending[1] : pending[0],
    turn,
    opening,
  );
}

/** Who starts, from the opening dice: the higher die (seat 0's is `a`). */
export function bgStarter(opening: BgDiceTs): number {
  return opening.a > opening.b ? 0 : 1;
}
