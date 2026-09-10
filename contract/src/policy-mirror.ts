// Copyright (C) Shielded Technologies
// SPDX-License-Identifier: Apache-2.0

/**
 * TypeScript mirror of src/policy-core.compact.
 *
 * Companion to src/dice-mirror.ts, and load-bearing for the same reason: when a table settles,
 * the operator reveals its seed and anyone re-derives every roll of the game from the public
 * log -- joins, entropies, round digests, holds, dice -- with no proof server and no chain
 * access. That replay needs the entropy scheme and the reroll merge, which live here, not just
 * the dice ladder, which lives in dice-mirror.ts. One file per include file, so a change on
 * either side has an obvious counterpart.
 *
 * Written INDEPENDENTLY of the compiled circuit rather than delegating to `pureCircuits`:
 * src/test/table.test.ts asserts the two agree over whole games, and delegating would make that
 * cross-check vacuous. The exceptions are the `persistentHash` primitive and its field-aligned
 * struct encoding, which come from the runtime -- reimplementing those would be reimplementing
 * the platform, and getting them subtly wrong is exactly the failure the cross-check exists to
 * catch.
 *
 * -------------------------------------------------------------------------------------------
 * WHAT THE INTERACTIVE-HOLD REDESIGN REMOVED
 * -------------------------------------------------------------------------------------------
 *
 * Everything to do with PRE-DECLARED HOLD POLICIES: `Policy`, `POLICY_NONE`, `isValidPolicy`,
 * `isCanonicalModal`, `holdMaskOf` and `resolveDiceTs`. The player used to choose one of six
 * deterministic rules before any dice existed and the circuit computed a mask from it; the
 * player now sees each roll and names the dice to keep, so the mask is five bits that arrive as
 * an argument and there is nothing to mirror.
 *
 * api/src/policies.ts is no longer contract-canonical for anything. It is left in the tree
 * because the site still imports its type.
 *
 * -------------------------------------------------------------------------------------------
 * AND ONE THING IT FIXED: the reroll is now a STREAM, and the mirror and the circuit agree
 * -------------------------------------------------------------------------------------------
 *
 * This file used to carry a documented divergence from api/src/policies.ts: the circuit merged
 * rerolls POSITIONALLY (die `i` of a reroll came from bytes `4i..4i+3` of that roll's hash,
 * whether or not earlier positions were rerolled) while the rules engine consumed a
 * left-to-right dice stream. Both were self-consistent; only one could be the verifier.
 *
 * `mergeStream` below is the stream model, and it is now what the circuit does too. If a player
 * holds positions 0 and 3, the two dice they get back are `fresh[0]` and `fresh[1]` -- the
 * rerolled positions consume the fresh roll from the left, in order.
 */

import {
  CompactTypeBytes,
  CompactTypeUnsignedInteger,
  CompactTypeVector,
  persistentHash,
  type CompactType,
} from '@midnight-ntwrk/compact-runtime';
import { deriveDiceTs, pad, rollContext } from './dice-mirror.ts';

/**
 * `faceCount` and `modalFace` come from dice-mirror.ts and are re-exported here for clients.
 *
 * NEITHER IS MIRRORED BY ANY CIRCUIT ANY MORE -- `isCanonicalModal` and the `modalFaceHint`
 * witness went with the pre-declared policies. They are kept exported because a UI that wants
 * to suggest a hold ("keep the threes") needs them, and because the fairness tests use
 * `faceCount` to measure the dice distribution. Nothing on chain depends on either.
 */
export { faceCount, modalFace } from './dice-mirror.ts';

// ---------------------------------------------------------------------------------------
// Hash contexts
// ---------------------------------------------------------------------------------------

const BYTES32 = new CompactTypeBytes(32);
const UINT8 = new CompactTypeUnsignedInteger(255n, 1);
const VEC3_BYTES32 = new CompactTypeVector(3, BYTES32);

/** Mirror of the Compact `EntropyContext` struct. Field order matches the declaration. */
export type EntropyContextTs = {
  domain: Uint8Array;
  sk: Uint8Array;
  tableId: Uint8Array;
  round: bigint;
};

/**
 * Runtime type for `EntropyContext`.
 *
 * Compact encodes a struct as the concatenation of its fields in declaration order, so a
 * reordered field here silently produces different hashes -- caught by the cross-check, never
 * by the type system. Same hazard, same mitigation as `ROLL_CONTEXT_TYPE` in dice-mirror.ts.
 */
const ENTROPY_CONTEXT_TYPE: CompactType<EntropyContextTs> = {
  alignment: () =>
    BYTES32.alignment()
      .concat(BYTES32.alignment())
      .concat(BYTES32.alignment())
      .concat(UINT8.alignment()),
  toValue: (v: EntropyContextTs) =>
    BYTES32.toValue(v.domain)
      .concat(BYTES32.toValue(v.sk))
      .concat(BYTES32.toValue(v.tableId))
      .concat(UINT8.toValue(v.round)),
  fromValue: (value) => ({
    domain: BYTES32.fromValue(value),
    sk: BYTES32.fromValue(value),
    tableId: BYTES32.fromValue(value),
    round: UINT8.fromValue(value),
  }),
};

/** Domain tags. Must equal the `pad(32, ...)` literals in policy-core.compact / table.compact. */
export const TAG_ENTROPY = 'dust-dice:v1:entropy';
export const TAG_ENTROPY_KEY = 'dust-dice:v1:entkey';
export const TAG_SEED = 'dust-dice:v1:seed';
export const TAG_MIX = 'dust-dice:v1:mix';

/** Mirror of `forcedEntropy`: `entropy_s(r) = H("entropy", sk, tableId, r)`. */
export function forcedEntropyTs(
  sk: Uint8Array,
  tableId: Uint8Array,
  round: number | bigint,
): Uint8Array {
  return persistentHash(ENTROPY_CONTEXT_TYPE, {
    domain: pad(32, TAG_ENTROPY),
    sk,
    tableId,
    round: BigInt(round),
  });
}

/**
 * Mirror of `entropyKeyCommitment`: the seat's join-time `C_s = H("entkey", tableId, sk)`.
 *
 * `tableId` is inside the hash so one reused `sk` cannot be recognised across two tables. See
 * the circuit's doc comment; the client rule (one fresh secret per table) is in
 * docs/client-rules.md.
 */
export function entropyKeyCommitmentTs(tableId: Uint8Array, sk: Uint8Array): Uint8Array {
  return persistentHash(VEC3_BYTES32, [pad(32, TAG_ENTROPY_KEY), tableId, sk]);
}

/**
 * Mirror of `seedCommitmentOf`: the operator's `H("seed", tableId, seed)`.
 *
 * `tableId` is inside the hash so that a seed reused at two tables does not give both the same
 * commitment -- the first table's settlement would otherwise publish the second's future
 * randomness. See the circuit's doc comment.
 */
export function seedCommitmentTs(tableId: Uint8Array, seed: Uint8Array): Uint8Array {
  return persistentHash(VEC3_BYTES32, [pad(32, TAG_SEED), tableId, seed]);
}

export const TAG_INVITE = 'dust-dice:v1:invite';
const VEC2_BYTES32 = new CompactTypeVector(2, BYTES32);

/** Mirror of `inviteCommitment`: a private table's sealed `H("invite", code)`. */
export function inviteCommitmentTs(code: Uint8Array): Uint8Array {
  return persistentHash(VEC2_BYTES32, [pad(32, TAG_INVITE), code]);
}

/**
 * Mirror of `mixEntropy`: folds the FROZEN round digest into the forced entropy.
 *
 * The second argument is `roundDigest` as it stood when the round opened, and under
 * simultaneous rounds that freeze is a security requirement rather than a convenience -- see
 * section 2 of table.compact's header.
 */
export function mixEntropyTs(entropy: Uint8Array, roundDigest: Uint8Array): Uint8Array {
  return persistentHash(VEC3_BYTES32, [pad(32, TAG_MIX), entropy, roundDigest]);
}

// ---------------------------------------------------------------------------------------
// The reroll merge -- left to right over the rerolled positions
// ---------------------------------------------------------------------------------------

/**
 * Mirror of `mergeStream`: keep the held dice, fill the rerolled positions from the fresh roll
 * LEFT TO RIGHT.
 *
 * Position `i` draws `fresh[rank(i)]`, where `rank(i)` counts the rerolled positions before it.
 * The circuit writes this as five explicit muxes of widths 1..5, because position `i` can only
 * ever draw from `fresh[0..i]`; here it is the obvious cursor. They are the same function, and
 * `src/test/table.test.ts` checks that over every one of the 32 masks.
 *
 * THE VERIFIER DEPENDS ON THIS BEING EXACT. A settlement replay that merged positionally would
 * reproduce roll 1 correctly and then diverge on every reroll where the held positions were not
 * a prefix.
 */
export function mergeStreamTs(
  hold: readonly boolean[],
  kept: readonly number[],
  fresh: readonly number[],
): number[] {
  let cursor = 0;
  return kept.map((die, i) => (hold[i] === true ? die : fresh[cursor++]!));
}

/** Mirror of `firstRoll`: five fresh dice, nothing held. */
export function firstRollTs(
  tableId: Uint8Array,
  seed: Uint8Array,
  mixed: Uint8Array,
  round: number | bigint,
): number[] {
  return deriveDiceTs(rollContext(tableId, seed, mixed, round, 0));
}

/**
 * Mirror of `rerollUnderMask`: one reroll of the positions `hold` does not keep.
 *
 * `rollIndex` is 1 for the second roll and 2 for the third, matching the circuit and separating
 * the two rerolls' hashes.
 */
export function rerollUnderMaskTs(
  tableId: Uint8Array,
  seed: Uint8Array,
  mixed: Uint8Array,
  round: number | bigint,
  rollIndex: number,
  hold: readonly boolean[],
  kept: readonly number[],
): number[] {
  return mergeStreamTs(
    hold,
    kept,
    deriveDiceTs(rollContext(tableId, seed, mixed, round, rollIndex)),
  );
}

/** One seat's turn, as the replay reconstructs it. */
export type ReplayedTurn = {
  /** Roll 1 in full. */
  roll0: number[];
  /** After the first reroll. Absent from `rolls` if the player scored after roll 1. */
  roll1: number[];
  /** After the second reroll. */
  roll2: number[];
  /** The dice the turn actually ended on, given how many rolls the player took. */
  final: number[];
  /** The two masks the player sent, in order. Unused entries are all-false. */
  holds: boolean[][];
};

/** A mask that keeps nothing -- the canonical "reroll everything". */
export function keepNothing(): boolean[] {
  return [false, false, false, false, false];
}

/**
 * Replay one seat's whole turn from the public log.
 *
 * NOT `resolveTurnTs`, which is dice-mirror.ts's mirror of the measurement contract
 * `turn.compact` and a different function entirely. This one takes the masks a player actually
 * sent and reports where the turn stopped.
 *
 * `holds` carries the masks the player actually sent, so its length says how many rolls the
 * turn took: zero masks means the player scored straight after roll 1, one mask means they
 * scored after roll 2, two masks means they went the distance. That is the ONLY thing that
 * varies between turns now -- a pre-declared policy fixed it at three rolls for everyone.
 *
 * `mixed` is `mixEntropyTs(forcedEntropyTs(sk, tableId, r), roundDigest_r)`, where the round
 * digest is the one FROZEN when round `r` opened -- not a running accumulator. See section 2 of
 * table.compact's header for why that matters.
 */
export function replayTurnTs(
  tableId: Uint8Array,
  seed: Uint8Array,
  mixed: Uint8Array,
  round: number | bigint,
  holds: readonly (readonly boolean[])[],
): ReplayedTurn {
  if (holds.length > 2) throw new Error(`a turn has at most two holds, got ${holds.length}`);
  const roll0 = firstRollTs(tableId, seed, mixed, round);
  const hold1 = holds[0] ?? keepNothing();
  const hold2 = holds[1] ?? keepNothing();
  const roll1 = rerollUnderMaskTs(tableId, seed, mixed, round, 1, hold1, roll0);
  const roll2 = rerollUnderMaskTs(tableId, seed, mixed, round, 2, hold2, roll1);
  const final = holds.length === 0 ? roll0 : holds.length === 1 ? roll1 : roll2;
  return { roll0, roll1, roll2, final, holds: [[...hold1], [...hold2]] };
}
