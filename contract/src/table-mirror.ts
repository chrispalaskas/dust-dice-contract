// Copyright (C) Shielded Technologies
// SPDX-License-Identifier: Apache-2.0

/**
 * TypeScript mirror of table.compact's event hash chain.
 *
 * Third and last of the mirrors (dice-mirror.ts, policy-mirror.ts, this). Together they are
 * the settlement verifier: given the public log of a table -- its constructor arguments, its
 * joins, each round's per-seat entropies and policies, the resolved dice, and the seed revealed
 * at `settle` -- they re-derive `roundDigest` at every step and every die of every roll,
 * offline, with no proof server and no chain access.
 *
 * The digest is what makes that replay worth doing. Every seat's rolls in round `r` hash the
 * digest AS IT STOOD WHEN ROUND r OPENED, and the next round's digest is a hash of round r's
 * results in SEAT ORDER. A verifier therefore cannot check any single roll without having
 * replayed every join and every earlier round in order -- and because the fold is by seat index
 * rather than by the order transactions landed, the replay is deterministic even though six
 * seats played simultaneously and the chain ordered them however it liked.
 *
 * THIS FILE CHANGED SHAPE WITH THE SIMULTANEOUS-ROUNDS REDESIGN. There is no longer a
 * per-resolve `resolveDigestTs`: the digest advances once per ROUND, in `closeRound`, not once
 * per turn. `roundDigestTs` replaces it. See docs/simultaneous-rounds.md and section 2 of
 * table.compact's header for why that is a security requirement rather than a simplification.
 *
 * Any edit to the event structs in table.compact must be made here too: Compact encodes a
 * struct as its fields concatenated in declaration order, so a field added or moved on one side
 * silently changes every hash and nothing but the cross-check notices.
 */

import {
  CompactTypeBoolean,
  CompactTypeBytes,
  CompactTypeUnsignedInteger,
  CompactTypeVector,
  persistentHash,
  type CompactType,
} from '@midnight-ntwrk/compact-runtime';
import { pad } from './dice-mirror.ts';

const BYTES32 = new CompactTypeBytes(32);
const UINT8 = new CompactTypeUnsignedInteger(255n, 1);
const UINT64 = new CompactTypeUnsignedInteger(18446744073709551615n, 8);
const BOOL = CompactTypeBoolean;
const VEC2_BYTES32 = new CompactTypeVector(2, BYTES32);
const VEC13_UINT8 = new CompactTypeVector(13, UINT8);
const VEC13_BOOL = new CompactTypeVector(13, BOOL);

/** Domain tags. Must equal the `pad(32, ...)` literals in table.compact. */
export const TAG_GENESIS = 'yahtzee:v1:genesis';
export const TAG_JOIN = 'yahtzee:v1:join';
export const TAG_ROUND = 'yahtzee:v1:round';
export const TAG_ELIMINATED = 'yahtzee:v1:eliminated';
export const TAG_REDEEMED = 'yahtzee:v1:redeemed';
export const TAG_FINAL = 'yahtzee:v1:final';

/**
 * `Phase` as the contract numbers it. The `ending` field of a final certificate is one of
 * `settled` or `aborted`; the others cannot appear there.
 */
export const Phase = {
  filling: 0,
  playing: 1,
  settled: 2,
  aborted: 3,
  abandoned: 4,
} as const;

/** `maxSeats()`. Also the `winner` a final certificate carries when nobody won. */
export const NO_WINNER = 6;

/** Mirror of `genesisDigest`: the digest a fresh table starts from. */
export function genesisDigestTs(tableId: Uint8Array): Uint8Array {
  return persistentHash(VEC2_BYTES32, [pad(32, TAG_GENESIS), tableId]);
}

// ---------------------------------------------------------------------------------------
// join
// ---------------------------------------------------------------------------------------

export type JoinEventTs = {
  domain: Uint8Array;
  prev: Uint8Array;
  seat: bigint;
  /** A `UserAddress` is a one-field struct, so it encodes as its `bytes` field alone. */
  addr: Uint8Array;
  keyCommit: Uint8Array;
};

const JOIN_EVENT_TYPE: CompactType<JoinEventTs> = {
  alignment: () =>
    BYTES32.alignment()
      .concat(BYTES32.alignment())
      .concat(UINT8.alignment())
      .concat(BYTES32.alignment())
      .concat(BYTES32.alignment()),
  toValue: (v) =>
    BYTES32.toValue(v.domain)
      .concat(BYTES32.toValue(v.prev))
      .concat(UINT8.toValue(v.seat))
      .concat(BYTES32.toValue(v.addr))
      .concat(BYTES32.toValue(v.keyCommit)),
  fromValue: (value) => ({
    domain: BYTES32.fromValue(value),
    prev: BYTES32.fromValue(value),
    seat: UINT8.fromValue(value),
    addr: BYTES32.fromValue(value),
    keyCommit: BYTES32.fromValue(value),
  }),
};

/** Mirror of `joinDigest`. */
export function joinDigestTs(
  prev: Uint8Array,
  seat: number | bigint,
  addr: Uint8Array,
  keyCommit: Uint8Array,
): Uint8Array {
  return persistentHash(JOIN_EVENT_TYPE, {
    domain: pad(32, TAG_JOIN),
    prev,
    seat: BigInt(seat),
    addr,
    keyCommit,
  });
}

// ---------------------------------------------------------------------------------------
// closeRound
// ---------------------------------------------------------------------------------------

/**
 * One seat's contribution to a round's result.
 *
 * `dice` are the seat's dice AS THEY STAND AT THE ROUND BOUNDARY -- the five it just rolled, or,
 * for a seat that did not roll this round (round 13, or an eliminated seat), whatever it last
 * held. A `Dice` is a five-field struct of `Uint<8>`, so it encodes as five bytes in order.
 */
export type RoundResultTs = {
  dice: readonly number[];
  out: boolean;
};

const ROUND_RESULT_TYPE: CompactType<RoundResultTs> = {
  alignment: () =>
    UINT8.alignment()
      .concat(UINT8.alignment())
      .concat(UINT8.alignment())
      .concat(UINT8.alignment())
      .concat(UINT8.alignment())
      .concat(BOOL.alignment()),
  toValue: (v) =>
    UINT8.toValue(BigInt(v.dice[0]!))
      .concat(UINT8.toValue(BigInt(v.dice[1]!)))
      .concat(UINT8.toValue(BigInt(v.dice[2]!)))
      .concat(UINT8.toValue(BigInt(v.dice[3]!)))
      .concat(UINT8.toValue(BigInt(v.dice[4]!)))
      .concat(BOOL.toValue(v.out)),
  fromValue: (value) => ({
    dice: [
      Number(UINT8.fromValue(value)),
      Number(UINT8.fromValue(value)),
      Number(UINT8.fromValue(value)),
      Number(UINT8.fromValue(value)),
      Number(UINT8.fromValue(value)),
    ],
    out: BOOL.fromValue(value),
  }),
};

const VEC6_ROUND_RESULT = new CompactTypeVector(6, ROUND_RESULT_TYPE);

export type RoundEventTs = {
  domain: Uint8Array;
  prev: Uint8Array;
  round: bigint;
  seatCount: bigint;
  results: RoundResultTs[];
};

const ROUND_EVENT_TYPE: CompactType<RoundEventTs> = {
  alignment: () =>
    BYTES32.alignment()
      .concat(BYTES32.alignment())
      .concat(UINT8.alignment())
      .concat(UINT8.alignment())
      .concat(VEC6_ROUND_RESULT.alignment()),
  toValue: (v) =>
    BYTES32.toValue(v.domain)
      .concat(BYTES32.toValue(v.prev))
      .concat(UINT8.toValue(v.round))
      .concat(UINT8.toValue(v.seatCount))
      .concat(VEC6_ROUND_RESULT.toValue(v.results)),
  fromValue: (value) => ({
    domain: BYTES32.fromValue(value),
    prev: BYTES32.fromValue(value),
    round: UINT8.fromValue(value),
    seatCount: UINT8.fromValue(value),
    results: VEC6_ROUND_RESULT.fromValue(value),
  }),
};

/**
 * Mirror of `roundDigestOf` -- the once-per-round fold that `closeRound` performs.
 *
 * `results` MUST carry all six slots in seat order, including slots no player took: the circuit
 * reads `seatProgress.lookup(0..5)` unconditionally and the constructor pre-inserts every slot
 * with `dice = [1,1,1,1,1]` and `out = false`. A replay that passed only the seated rows would
 * produce a different hash. `emptyRoundResult()` is the value to pad with.
 */
export function roundDigestTs(
  prev: Uint8Array,
  round: number | bigint,
  seatCount: number | bigint,
  results: readonly RoundResultTs[],
): Uint8Array {
  if (results.length !== 6) {
    throw new Error(`roundDigestTs needs all six slots, got ${results.length}`);
  }
  return persistentHash(ROUND_EVENT_TYPE, {
    domain: pad(32, TAG_ROUND),
    prev,
    round: BigInt(round),
    seatCount: BigInt(seatCount),
    results: results.map((r) => ({ dice: r.dice, out: r.out })),
  });
}

/** The value an unoccupied slot contributes to a round digest: the constructor's defaults. */
export function emptyRoundResult(): RoundResultTs {
  return { dice: [1, 1, 1, 1, 1], out: false };
}

// ---------------------------------------------------------------------------------------
// Per-seat receipts
// ---------------------------------------------------------------------------------------

export type EliminateEventTs = {
  domain: Uint8Array;
  prev: Uint8Array;
  tableId: Uint8Array;
  seat: bigint;
  round: bigint;
  tier: bigint;
  penalty: bigint;
  refund: bigint;
};

const ELIMINATE_EVENT_TYPE: CompactType<EliminateEventTs> = {
  alignment: () =>
    BYTES32.alignment()
      .concat(BYTES32.alignment())
      .concat(BYTES32.alignment())
      .concat(UINT8.alignment())
      .concat(UINT8.alignment())
      .concat(UINT64.alignment())
      .concat(UINT64.alignment())
      .concat(UINT64.alignment()),
  toValue: (v) =>
    BYTES32.toValue(v.domain)
      .concat(BYTES32.toValue(v.prev))
      .concat(BYTES32.toValue(v.tableId))
      .concat(UINT8.toValue(v.seat))
      .concat(UINT8.toValue(v.round))
      .concat(UINT64.toValue(v.tier))
      .concat(UINT64.toValue(v.penalty))
      .concat(UINT64.toValue(v.refund)),
  fromValue: (value) => ({
    domain: BYTES32.fromValue(value),
    prev: BYTES32.fromValue(value),
    tableId: BYTES32.fromValue(value),
    seat: UINT8.fromValue(value),
    round: UINT8.fromValue(value),
    tier: UINT64.fromValue(value),
    penalty: UINT64.fromValue(value),
    refund: UINT64.fromValue(value),
  }),
};

/** Mirror of `eliminateDigest`: the receipt `eliminate` chains into `seatReceipt`. */
export function eliminateDigestTs(
  prev: Uint8Array,
  tableId: Uint8Array,
  seat: number | bigint,
  round: number | bigint,
  tier: bigint,
  penalty: bigint,
  refund: bigint,
): Uint8Array {
  return persistentHash(ELIMINATE_EVENT_TYPE, {
    domain: pad(32, TAG_ELIMINATED),
    prev,
    tableId,
    seat: BigInt(seat),
    round: BigInt(round),
    tier,
    penalty,
    refund,
  });
}

/**
 * A scorecard in the shape the circuit hashes it: thirteen scores, thirteen filled bits, and
 * the Yahtzee-bonus count. The reference's `number | null` per category splits into the two.
 */
export type ScorecardTs = {
  scores: readonly (number | bigint)[];
  filled: readonly boolean[];
  yahtzeeBonuses: number | bigint;
};

const SCORECARD_TYPE: CompactType<ScorecardTs> = {
  alignment: () => VEC13_UINT8.alignment().concat(VEC13_BOOL.alignment()).concat(UINT8.alignment()),
  toValue: (v) =>
    VEC13_UINT8.toValue(v.scores.map((s) => BigInt(s)))
      .concat(VEC13_BOOL.toValue([...v.filled]))
      .concat(UINT8.toValue(BigInt(v.yahtzeeBonuses))),
  fromValue: (value) => ({
    scores: VEC13_UINT8.fromValue(value),
    filled: VEC13_BOOL.fromValue(value),
    yahtzeeBonuses: UINT8.fromValue(value),
  }),
};

export type RedeemEventTs = {
  domain: Uint8Array;
  prev: Uint8Array;
  tableId: Uint8Array;
  seat: bigint;
  amount: bigint;
  addr: Uint8Array;
  card: ScorecardTs;
};

const REDEEM_EVENT_TYPE: CompactType<RedeemEventTs> = {
  alignment: () =>
    BYTES32.alignment()
      .concat(BYTES32.alignment())
      .concat(BYTES32.alignment())
      .concat(UINT8.alignment())
      .concat(UINT64.alignment())
      .concat(BYTES32.alignment())
      .concat(SCORECARD_TYPE.alignment()),
  toValue: (v) =>
    BYTES32.toValue(v.domain)
      .concat(BYTES32.toValue(v.prev))
      .concat(BYTES32.toValue(v.tableId))
      .concat(UINT8.toValue(v.seat))
      .concat(UINT64.toValue(v.amount))
      .concat(BYTES32.toValue(v.addr))
      .concat(SCORECARD_TYPE.toValue(v.card)),
  fromValue: (value) => ({
    domain: BYTES32.fromValue(value),
    prev: BYTES32.fromValue(value),
    tableId: BYTES32.fromValue(value),
    seat: UINT8.fromValue(value),
    amount: UINT64.fromValue(value),
    addr: BYTES32.fromValue(value),
    card: SCORECARD_TYPE.fromValue(value),
  }),
};

/** Mirror of `redeemDigest`: the receipt `redeem` chains into `seatReceipt`. */
export function redeemDigestTs(
  prev: Uint8Array,
  tableId: Uint8Array,
  seat: number | bigint,
  amount: bigint,
  addr: Uint8Array,
  card: ScorecardTs,
): Uint8Array {
  return persistentHash(REDEEM_EVENT_TYPE, {
    domain: pad(32, TAG_REDEEMED),
    prev,
    tableId,
    seat: BigInt(seat),
    amount,
    addr,
    card,
  });
}

// ---------------------------------------------------------------------------------------
// The closing certificate
// ---------------------------------------------------------------------------------------

export type FinalEventTs = {
  domain: Uint8Array;
  prev: Uint8Array;
  tableId: Uint8Array;
  ending: bigint;
  winner: bigint;
  seatCount: bigint;
  paid: bigint;
  rake: bigint;
  perSeat: bigint;
  verifiable: boolean;
};

const FINAL_EVENT_TYPE: CompactType<FinalEventTs> = {
  alignment: () =>
    BYTES32.alignment()
      .concat(BYTES32.alignment())
      .concat(BYTES32.alignment())
      .concat(UINT8.alignment())
      .concat(UINT8.alignment())
      .concat(UINT8.alignment())
      .concat(UINT64.alignment())
      .concat(UINT64.alignment())
      .concat(UINT64.alignment())
      .concat(BOOL.alignment()),
  toValue: (v) =>
    BYTES32.toValue(v.domain)
      .concat(BYTES32.toValue(v.prev))
      .concat(BYTES32.toValue(v.tableId))
      .concat(UINT8.toValue(v.ending))
      .concat(UINT8.toValue(v.winner))
      .concat(UINT8.toValue(v.seatCount))
      .concat(UINT64.toValue(v.paid))
      .concat(UINT64.toValue(v.rake))
      .concat(UINT64.toValue(v.perSeat))
      .concat(BOOL.toValue(v.verifiable)),
  fromValue: (value) => ({
    domain: BYTES32.fromValue(value),
    prev: BYTES32.fromValue(value),
    tableId: BYTES32.fromValue(value),
    ending: UINT8.fromValue(value),
    winner: UINT8.fromValue(value),
    seatCount: UINT8.fromValue(value),
    paid: UINT64.fromValue(value),
    rake: UINT64.fromValue(value),
    perSeat: UINT64.fromValue(value),
    verifiable: BOOL.fromValue(value),
  }),
};

/**
 * Mirror of `finalDigestOf`: the one value that says how a table ended.
 *
 * `prev` is the FINAL round digest, so the certificate is bound to the whole game that produced
 * it. For a settlement, `winner` is the winning seat, `paid`/`rake` are the two halves of the
 * pot and `perSeat` is 0; for an abort, `winner` is `NO_WINNER`, `paid` is 0, `rake` is the
 * all-eliminated waiver's rake (0 on the other two abort paths) and `perSeat` is what each
 * seated player may redeem.
 */
export function finalDigestTs(
  prev: Uint8Array,
  tableId: Uint8Array,
  ending: number | bigint,
  winner: number | bigint,
  seatCount: number | bigint,
  paid: bigint,
  rake: bigint,
  perSeat: bigint,
  verifiable: boolean,
): Uint8Array {
  return persistentHash(FINAL_EVENT_TYPE, {
    domain: pad(32, TAG_FINAL),
    prev,
    tableId,
    ending: BigInt(ending),
    winner: BigInt(winner),
    seatCount: BigInt(seatCount),
    paid,
    rake,
    perSeat,
    verifiable,
  });
}
