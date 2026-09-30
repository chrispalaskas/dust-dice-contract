// Copyright (C) Shielded Technologies
// SPDX-License-Identifier: Apache-2.0

/**
 * The off-chain halves of the Backgammon table's VRF dice (backgammon-dice.compact): what the
 * seat computes before and after the operator answers, what the operator answers, and how a
 * replay recomputes every roll once `settle` has revealed the key.
 *
 * EVERY HASH AND CURVE OPERATION GOES THROUGH THE BACKGAMMON CONTRACT'S OWN PURE CIRCUITS, for
 * the reason vrf.ts gives: a second implementation of Jubjub is how this class of protocol dies.
 * The only arithmetic done here is the scalar inverse that unblinds, and the contract checks
 * that (`S == rho*Gamma`). The byte ladder has a TypeScript twin, held to the circuit by
 * src/test/backgammon.test.ts, because the verifier and the tests read dice by the thousand.
 *
 * Indices, as the contract numbers them (a "ply" is `turn`):
 *
 *   join           reveals bgJoinEntropy(sk)       posts the query for ply 1
 *   move at ply t  reveals bgRollSecret(sk, t)     posts the query for ply t+2
 *   roll at ply t  input point from bgRollSecret(sk, t), blinding bgBlindingFor(sk, t),
 *                  dice mixed with the secret the move at t-1 revealed (`lastSecret`)
 */

import type { JubjubPoint } from '@midnight-ntwrk/compact-runtime';

import { dieFromBytes } from './dice-mirror.ts';
import { pureCircuits as bg } from './managed/backgammon/contract/index.js';
import { evaluate, JUBJUB_ORDER, unblind, verifyDleq, type DleqProof } from './vrf.ts';

/** Accept a byte below this for the opening's five-face die; buckets of 50. */
export const FIVE_ACCEPT_LIMIT = 250;

/** The two dice. For the opening, `a` is seat 0's die and `b` seat 1's, never equal. */
export type BgDiceTs = { a: number; b: number };

const ZEROS32 = new Uint8Array(32);
const toDice = (d: { a: bigint; b: bigint }): BgDiceTs => ({ a: Number(d.a), b: Number(d.b) });

// ---------------------------------------------------------------------------------------------
// The seat
// ---------------------------------------------------------------------------------------------

/** What `join` reveals, and the opening hashes. */
export const bgJoinEntropyTs = (sk: Uint8Array, tableId: Uint8Array): Uint8Array =>
  bg.bgJoinEntropy(sk, tableId);

/** The secret behind a seat's roll at ply `turn`, which its move at that ply reveals. */
export const bgRollSecretTs = (
  sk: Uint8Array,
  tableId: Uint8Array,
  turn: number | bigint,
): Uint8Array => bg.bgRollSecret(sk, tableId, BigInt(turn));

/** The blinded query a seat posts for its roll at ply `turn`: `B = rho*P`. */
export function bgQueryFor(
  sk: Uint8Array,
  tableId: Uint8Array,
  turn: number | bigint,
): JubjubPoint {
  const t = BigInt(turn);
  const input = bg.bgVrfInputPoint(tableId, t, bg.bgRollSecret(sk, tableId, t));
  return bg.vrfScalarMul(input, bg.bgBlindingFor(sk, tableId, t));
}

/** Unblind the operator's answer to this seat's query for ply `turn`: `Gamma = rho^-1 * S`. */
export const bgGammaFor = (
  sk: Uint8Array,
  tableId: Uint8Array,
  turn: number | bigint,
  response: JubjubPoint,
): JubjubPoint => unblind(response, bg.bgBlindingFor(sk, tableId, BigInt(turn)));

/** The dice of a ply from its VRF output and the secret the previous move revealed. */
export const bgDiceOf = (
  tableId: Uint8Array,
  gamma: JubjubPoint,
  lastSecret: Uint8Array,
  turn: number | bigint,
): BgDiceTs => toDice(bg.bgDice(tableId, gamma, lastSecret, BigInt(turn), false));

/**
 * The mover's roll, as its browser sees it the moment the operator's answer lands: nobody else
 * can compute this until the move reveals it.
 */
export function bgMyRoll(args: {
  sk: Uint8Array;
  tableId: Uint8Array;
  turn: number | bigint;
  response: JubjubPoint;
  lastSecret: Uint8Array;
}): { gamma: JubjubPoint; dice: BgDiceTs } {
  const gamma = bgGammaFor(args.sk, args.tableId, args.turn, args.response);
  return { gamma, dice: bgDiceOf(args.tableId, gamma, args.lastSecret, args.turn) };
}

// ---------------------------------------------------------------------------------------------
// The operator
// ---------------------------------------------------------------------------------------------

/** The two join entropies, in seat order, as the ledger holds them. */
export type BgJoinEntropies = readonly [Uint8Array, Uint8Array];

/** The opening's VRF input: public, from both seats' join entropies. */
export const bgOpeningPointTs = (tableId: Uint8Array, join: BgJoinEntropies): JubjubPoint =>
  bg.bgOpeningPoint(tableId, join[0], join[1]);

/**
 * The point `resolveRoll` must answer at ply `turn`: the opening point at ply 0, the mover's
 * blinded query after it. `mover` is `toMove` and `query` that seat's query cell.
 */
export function bgResolvePoint(args: {
  tableId: Uint8Array;
  turn: number | bigint;
  join: BgJoinEntropies;
  query: { turn: bigint; blinded: JubjubPoint };
}): JubjubPoint {
  if (BigInt(args.turn) === 0n) return bgOpeningPointTs(args.tableId, args.join);
  if (args.query.turn !== BigInt(args.turn)) {
    throw new Error(
      `the player to move has no query for ply ${args.turn} (its query is for ply ${args.query.turn})`,
    );
  }
  return args.query.blinded;
}

/** The operator's answer and its proof -- exactly what `resolveRoll` takes. */
export const bgAnswer = (
  secret: bigint,
  point: JubjubPoint,
): { response: JubjubPoint; proof: DleqProof } => evaluate(secret, point);

/** Does an answer really come from the table's key? The browser checks before it trusts one. */
export const bgAnswerHolds = (
  pk: JubjubPoint,
  point: JubjubPoint,
  response: JubjubPoint,
  proof: DleqProof,
): boolean => verifyDleq(pk, point, response, proof);

/** The opening pair from the operator's answer to the opening point. */
export const bgOpeningThrow = (tableId: Uint8Array, response: JubjubPoint): BgDiceTs =>
  toDice(bg.bgDice(tableId, response, ZEROS32, 0n, true));

/** Who starts, from the opening dice: the higher die (seat 0's is `a`). */
export function bgStarter(opening: BgDiceTs): number {
  return opening.a > opening.b ? 0 : 1;
}

// ---------------------------------------------------------------------------------------------
// A replay, with the key `settle` revealed
// ---------------------------------------------------------------------------------------------

const modR = (a: bigint): bigint => ((a % JUBJUB_ORDER) + JUBJUB_ORDER) % JUBJUB_ORDER;

/** The opening, recomputed from the key: `x*P_open`, no answer needed. */
export const bgReplayOpening = (
  secret: bigint,
  tableId: Uint8Array,
  join: BgJoinEntropies,
): BgDiceTs =>
  bgOpeningThrow(tableId, bg.vrfScalarMul(bgOpeningPointTs(tableId, join), modR(secret)));

/**
 * A ply's roll, recomputed from the key and the public log: `rollSecret` is what the move at
 * this ply revealed, `lastSecret` what the move before it revealed.
 */
export function bgReplayRoll(args: {
  secret: bigint;
  tableId: Uint8Array;
  turn: number | bigint;
  rollSecret: Uint8Array;
  lastSecret: Uint8Array;
}): BgDiceTs {
  const t = BigInt(args.turn);
  const gamma = bg.vrfScalarMul(
    bg.bgVrfInputPoint(args.tableId, t, args.rollSecret),
    modR(args.secret),
  );
  return bgDiceOf(args.tableId, gamma, args.lastSecret, t);
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
