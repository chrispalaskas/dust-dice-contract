// Copyright (C) Shielded Technologies
// SPDX-License-Identifier: Apache-2.0

/**
 * The off-chain halves of the Backgammon table's dice (backgammon-dice.compact): what a seat
 * computes before it moves, and how a replay recomputes every roll from the public log.
 *
 * Every roll hashes a secret from each player and nothing of the operator's, so there is no
 * answer to wait for and no key to reveal: a seat computes its own roll the moment the opponent's
 * move lands, and anyone replays a finished game from the secrets the moves revealed.
 *
 * EVERY HASH GOES THROUGH THE BACKGAMMON CONTRACT'S OWN PURE CIRCUITS: a second implementation is
 * how this class of protocol dies. The byte ladder has a TypeScript twin, held to the circuit by
 * src/test/backgammon.test.ts, because the verifier and the tests read dice by the thousand.
 *
 * Indices, as the contract numbers them (a "ply" is `turn`):
 *
 *   reveal         discloses bgOpeningSecret(sk)          the seat's share of the opening
 *   move at ply t  discloses bgRollSecret(sk, t)          the ply's own secret
 *   opening        bgOpeningDice(share 0, share 1)        a die per seat, never a double
 *   roll at ply t  bgPlyDice(bgRollSecret(mover sk, t), the secret the move at t-1 disclosed)
 */

import { dieFromBytes } from './dice-mirror.ts';
import { pureCircuits as bg } from './managed/backgammon/contract/index.js';

/** Accept a byte below this for the opening's five-face die; buckets of 50. */
export const FIVE_ACCEPT_LIMIT = 250;

/** The two dice. For the opening, `a` is seat 0's die and `b` seat 1's, never equal. */
export type BgDiceTs = { a: number; b: number };

const toDice = (d: { a: bigint; b: bigint }): BgDiceTs => ({ a: Number(d.a), b: Number(d.b) });

// ---------------------------------------------------------------------------------------------
// The seat
// ---------------------------------------------------------------------------------------------

/** A seat's share of the opening, which its `reveal` discloses after the start. */
export const bgOpeningSecretTs = (sk: Uint8Array, tableId: Uint8Array): Uint8Array =>
  bg.bgOpeningSecret(sk, tableId);

/** The secret behind a seat's roll at ply `turn`, which its move at that ply reveals. */
export const bgRollSecretTs = (
  sk: Uint8Array,
  tableId: Uint8Array,
  turn: number | bigint,
): Uint8Array => bg.bgRollSecret(sk, tableId, BigInt(turn));

/** A ply's dice from the mover's secret for it and the secret the previous move revealed. */
export const bgPlyDiceTs = (
  tableId: Uint8Array,
  mine: Uint8Array,
  lastSecret: Uint8Array,
  turn: number | bigint,
): BgDiceTs => toDice(bg.bgPlyDice(tableId, mine, lastSecret, BigInt(turn)));

/**
 * The mover's roll for ply `turn`, as only the mover can compute it: its own secret for the ply
 * and the one the opponent's last move revealed (`lastSecret` on the ledger).
 */
export const bgMyRoll = (args: {
  sk: Uint8Array;
  tableId: Uint8Array;
  turn: number | bigint;
  lastSecret: Uint8Array;
}): BgDiceTs =>
  bgPlyDiceTs(
    args.tableId,
    bgRollSecretTs(args.sk, args.tableId, args.turn),
    args.lastSecret,
    args.turn,
  );

// ---------------------------------------------------------------------------------------------
// The opening
// ---------------------------------------------------------------------------------------------

/** Both seats' shares of the opening, in seat order, as the ledger holds them. */
export type BgOpeningShares = readonly [Uint8Array, Uint8Array];

/** A share not yet revealed reads as zeros on the ledger. */
export const bgHasShare = (share: Uint8Array): boolean => share.some((b) => b !== 0);

/** The opening pair from both shares: `a` is seat 0's die, `b` seat 1's. */
export const bgOpeningDiceTs = (tableId: Uint8Array, shares: BgOpeningShares): BgDiceTs =>
  toDice(bg.bgOpeningDice(tableId, shares[0], shares[1]));

/** Who starts, from the opening dice: the higher die (seat 0's is `a`). */
export function bgStarter(opening: BgDiceTs): number {
  return opening.a > opening.b ? 0 : 1;
}

// ---------------------------------------------------------------------------------------------
// The ladder's twin
// ---------------------------------------------------------------------------------------------

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

/** Mirrors `bgDiceFromBytes`: two dice from a roll's 32 bytes, or the opening pair. */
export function bgDiceFromBytesTs(v: Uint8Array, opening: boolean): BgDiceTs {
  const a = dieFromBytes(v.subarray(0, 4));
  if (!opening) return { a, b: dieFromBytes(v.subarray(4, 8)) };
  const five = fiveFromBytes(v.subarray(4, 8));
  return { a, b: five + (five >= a ? 1 : 0) };
}
