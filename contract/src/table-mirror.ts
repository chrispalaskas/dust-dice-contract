// Copyright (C) Shielded Technologies
// SPDX-License-Identifier: Apache-2.0

/**
 * TypeScript mirror of table.compact's event hash chain.
 *
 * Third and last of the mirrors (dice-mirror.ts, policy-mirror.ts, this). Together they are
 * the settlement verifier: given the public log of a table -- its constructor arguments, its
 * joins, its per-turn entropies and policies, its resolved dice, and the seed revealed at
 * `settle` -- they re-derive `gameDigest` at every step and every die of every roll, offline,
 * with no proof server and no chain access.
 *
 * The digest is what makes that replay worth doing. Each roll hashes the digest as it stood
 * BEFORE that turn's resolution, so a verifier cannot check any single roll without having
 * replayed every join and every earlier resolution in order. Reproducing the chain end to end
 * is therefore the same act as checking that no event was inserted, dropped or reordered.
 *
 * Any edit to the `JoinEvent` / `ResolveEvent` structs in table.compact must be made here too:
 * Compact encodes a struct as its fields concatenated in declaration order, so a field added
 * or moved on one side silently changes every hash and nothing but the cross-check notices.
 */

import {
  CompactTypeBytes,
  CompactTypeUnsignedInteger,
  CompactTypeVector,
  persistentHash,
  type CompactType,
} from '@midnight-ntwrk/compact-runtime';
import { pad } from './dice-mirror.ts';

const BYTES32 = new CompactTypeBytes(32);
const UINT8 = new CompactTypeUnsignedInteger(255n, 1);
const UINT16 = new CompactTypeUnsignedInteger(65535n, 2);
const VEC2_BYTES32 = new CompactTypeVector(2, BYTES32);

/** Domain tags. Must equal the `pad(32, ...)` literals in table.compact. */
export const TAG_GENESIS = 'yahtzee:v1:genesis';
export const TAG_JOIN = 'yahtzee:v1:join';
export const TAG_RESOLVE = 'yahtzee:v1:resolve';

/** Mirror of `genesisDigest`: the digest a fresh table starts from. */
export function genesisDigestTs(tableId: Uint8Array): Uint8Array {
  return persistentHash(VEC2_BYTES32, [pad(32, TAG_GENESIS), tableId]);
}

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

export type ResolveEventTs = {
  domain: Uint8Array;
  prev: Uint8Array;
  turnIndex: bigint;
  seat: bigint;
  round: bigint;
  policy: bigint;
  param: bigint;
  entropy: Uint8Array;
  /** A `Dice` is a five-field struct of `Uint<8>`, so it encodes as five bytes in order. */
  dice: readonly number[];
};

const RESOLVE_EVENT_TYPE: CompactType<ResolveEventTs> = {
  alignment: () =>
    BYTES32.alignment()
      .concat(BYTES32.alignment())
      .concat(UINT16.alignment())
      .concat(UINT8.alignment())
      .concat(UINT8.alignment())
      .concat(UINT8.alignment())
      .concat(UINT8.alignment())
      .concat(BYTES32.alignment())
      .concat(UINT8.alignment())
      .concat(UINT8.alignment())
      .concat(UINT8.alignment())
      .concat(UINT8.alignment())
      .concat(UINT8.alignment()),
  toValue: (v) =>
    BYTES32.toValue(v.domain)
      .concat(BYTES32.toValue(v.prev))
      .concat(UINT16.toValue(v.turnIndex))
      .concat(UINT8.toValue(v.seat))
      .concat(UINT8.toValue(v.round))
      .concat(UINT8.toValue(v.policy))
      .concat(UINT8.toValue(v.param))
      .concat(BYTES32.toValue(v.entropy))
      .concat(UINT8.toValue(BigInt(v.dice[0]!)))
      .concat(UINT8.toValue(BigInt(v.dice[1]!)))
      .concat(UINT8.toValue(BigInt(v.dice[2]!)))
      .concat(UINT8.toValue(BigInt(v.dice[3]!)))
      .concat(UINT8.toValue(BigInt(v.dice[4]!))),
  fromValue: (value) => ({
    domain: BYTES32.fromValue(value),
    prev: BYTES32.fromValue(value),
    turnIndex: UINT16.fromValue(value),
    seat: UINT8.fromValue(value),
    round: UINT8.fromValue(value),
    policy: UINT8.fromValue(value),
    param: UINT8.fromValue(value),
    entropy: BYTES32.fromValue(value),
    dice: [
      Number(UINT8.fromValue(value)),
      Number(UINT8.fromValue(value)),
      Number(UINT8.fromValue(value)),
      Number(UINT8.fromValue(value)),
      Number(UINT8.fromValue(value)),
    ],
  }),
};

/** Mirror of `resolveDigest`. */
export function resolveDigestTs(
  prev: Uint8Array,
  turnIndex: number | bigint,
  seat: number | bigint,
  round: number | bigint,
  policy: number | bigint,
  param: number | bigint,
  entropy: Uint8Array,
  dice: readonly number[],
): Uint8Array {
  return persistentHash(RESOLVE_EVENT_TYPE, {
    domain: pad(32, TAG_RESOLVE),
    prev,
    turnIndex: BigInt(turnIndex),
    seat: BigInt(seat),
    round: BigInt(round),
    policy: BigInt(policy),
    param: BigInt(param),
    entropy,
    dice,
  });
}
