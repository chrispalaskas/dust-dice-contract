// Copyright (C) Shielded Technologies
// SPDX-License-Identifier: Apache-2.0

/**
 * TypeScript mirror of src/policy-core.compact.
 *
 * Companion to src/dice-mirror.ts, and load-bearing for the same reason: when a table settles,
 * the operator reveals its seed and anyone re-derives every roll of the game from the public
 * log -- joins, entropies, digests, dice -- with no proof server and no chain access. That
 * replay needs the hold policies and the entropy/digest hashing, which live here, not just the
 * dice ladder, which lives in dice-mirror.ts. One file per include file, so a change on either
 * side has an obvious counterpart.
 *
 * Written INDEPENDENTLY of the compiled circuit rather than delegating to `pureCircuits`:
 * src/test/table.test.ts asserts the two agree over a whole 6-seat game, and delegating would
 * make that cross-check vacuous. The exceptions are the same as dice-mirror.ts's -- the
 * `persistentHash` primitive and its field-aligned struct encoding come from the runtime,
 * because reimplementing those would be reimplementing the platform and getting them subtly
 * wrong is exactly the failure the cross-check exists to catch.
 *
 * The policy semantics themselves are api/src/policies.ts's. That module is contract-canonical
 * for the ENCODING (which number means which policy) and for the MASK RULES; this file is the
 * bridge between it and the circuit's hash-derived dice stream, because api/src/policies.ts
 * models rerolls as a left-to-right dice stream while the circuit derives die `i` of roll `k`
 * from fixed bytes of the roll-`k` hash. `resolveTurnDice` in api and `resolveDiceTs` here
 * therefore produce the same masks but consume entropy differently, and only this file matches
 * the chain. See `resolveDiceTs`.
 *
 * Any edit to policy-core.compact must be made here too, and vice versa.
 */

import {
  CompactTypeBytes,
  CompactTypeUnsignedInteger,
  CompactTypeVector,
  persistentHash,
  type CompactType,
} from '@midnight-ntwrk/compact-runtime';
import { deriveDiceTs, faceCount, modalFace, pad, rollContext } from './dice-mirror.ts';

// ---------------------------------------------------------------------------------------
// Policy encoding -- mirrors api/src/policies.ts exactly
// ---------------------------------------------------------------------------------------

/**
 * The shipped hold policies. A plain const object rather than a TS enum, matching
 * dice-mirror.ts: Node's strip-only type removal rejects TS enums, and the generated contract
 * bindings represent these as plain numbers anyway (the circuit uses `Uint<8>`, not a Compact
 * enum, so the joker-style arithmetic dispatch stays available).
 *
 * These are api/src/policies.ts's numbers. They appear on-chain in `pendingPolicy` and in the
 * resolve digest. Never reorder.
 */
export const Policy = {
  Stand: 0,
  RerollAll: 1,
  KeepModal: 2,
  KeepFace: 3,
  ChaseStraight: 4,
  KeepPairsPlus: 5,
} as const;

export type PolicyValue = (typeof Policy)[keyof typeof Policy];

/** `policyNone()` in table.compact: the score-only round 13's mandatory encoding. */
export const POLICY_NONE = 6;

/** Mirror of `isValidPolicy`. KeepFace carries a face 1..6; everything else carries 0. */
export function isValidPolicy(policy: number, param: number): boolean {
  if (!Number.isInteger(policy) || !Number.isInteger(param)) return false;
  if (policy < 0 || policy >= POLICY_NONE) return false;
  return policy === Policy.KeepFace ? param >= 1 && param <= 6 : param === 0;
}

// ---------------------------------------------------------------------------------------
// Counts, modal face
// ---------------------------------------------------------------------------------------

/**
 * `faceCount` and `modalFace` come from dice-mirror.ts and are re-exported here rather than
 * reimplemented.
 *
 * They mirror `pFaceCount` in policy-core.compact and api/src/policies.ts's `KeepModal` scan
 * (`counts[f] >= counts[modal]` walking upward, so ties go to the HIGHER face) -- and
 * dice-mirror.ts already carries exactly those two functions, because turn.compact had a
 * modal-face policy before the production set existed. Two byte-identical copies in one package
 * is not independence, it is a second thing to keep in step; the independence that earns its
 * keep is `isCanonicalModal` below, which is written as six comparisons against this scan and
 * cross-checked against it exhaustively.
 *
 * `modalFace` is what the operator witnesses into `resolveTurn` as `modalFaceHint`.
 */
export { faceCount, modalFace } from './dice-mirror.ts';

/**
 * Mirror of `isCanonicalModal` -- the CHECK, written independently of `modalFace` above.
 *
 * Two implementations of the same predicate on purpose: `modalFace` is a scan and this is six
 * comparisons, which is the same rewrite the circuit makes. src/test/table.test.ts asserts
 * they agree, which is the only way to catch a tie-break that drifted.
 */
export function isCanonicalModal(dice: readonly number[], m: number): boolean {
  if (m < 1 || m > 6) return false;
  const cm = faceCount(dice, m);
  for (let f = 1; f <= 6; f++) {
    const cf = faceCount(dice, f);
    if (f < m && cm < cf) return false;
    if (f > m && cm <= cf) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------------------
// The hold mask
// ---------------------------------------------------------------------------------------

/**
 * Mirror of `holdMaskOf`. True = keep this die, false = reroll it.
 *
 * Semantics are api/src/policies.ts's `holdMask`, position for position:
 *   Stand          keep everything (rolls 2 and 3 change nothing)
 *   RerollAll      keep nothing
 *   KeepModal      keep every die showing the modal face
 *   KeepFace       keep every die showing `param`
 *   ChaseStraight  keep the LOWEST-indexed die of each distinct face, reroll duplicates
 *   KeepPairsPlus  keep every die whose face appears at least twice
 *
 * `modal` is passed in rather than computed so that a test can feed a deliberately wrong modal
 * face and see the same mask the circuit would build from a wrong witness.
 */
export function holdMaskOf(
  policy: number,
  param: number,
  modal: number,
  dice: readonly number[],
): boolean[] {
  return dice.map((die, i) => {
    switch (policy) {
      case Policy.Stand:
        return true;
      case Policy.RerollAll:
        return false;
      case Policy.KeepModal:
        return die === modal;
      case Policy.KeepFace:
        return die === param;
      case Policy.ChaseStraight:
        return dice.slice(0, i).every((earlier) => earlier !== die);
      case Policy.KeepPairsPlus:
        return faceCount(dice, die) >= 2;
      default:
        // Matches the circuit: an out-of-range code selects no term, so nothing is held.
        // `isValidPolicy` is what rejects it; the mask is not the guard.
        return false;
    }
  });
}

// ---------------------------------------------------------------------------------------
// Hash contexts
// ---------------------------------------------------------------------------------------

const BYTES32 = new CompactTypeBytes(32);
const UINT8 = new CompactTypeUnsignedInteger(255n, 1);
const VEC2_BYTES32 = new CompactTypeVector(2, BYTES32);
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
export const TAG_ENTROPY = 'yahtzee:v1:entropy';
export const TAG_ENTROPY_KEY = 'yahtzee:v1:entkey';
export const TAG_SEED = 'yahtzee:v1:seed';
export const TAG_MIX = 'yahtzee:v1:mix';

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

/** Mirror of `entropyKeyCommitment`: the seat's join-time `C_s = H("entkey", sk)`. */
export function entropyKeyCommitmentTs(sk: Uint8Array): Uint8Array {
  return persistentHash(VEC2_BYTES32, [pad(32, TAG_ENTROPY_KEY), sk]);
}

/** Mirror of `seedCommitmentOf`: the operator's `H("seed", seed)`. */
export function seedCommitmentTs(seed: Uint8Array): Uint8Array {
  return persistentHash(VEC2_BYTES32, [pad(32, TAG_SEED), seed]);
}

/** Mirror of `mixEntropy`: folds the running game digest into the forced entropy. */
export function mixEntropyTs(entropy: Uint8Array, gameDigest: Uint8Array): Uint8Array {
  return persistentHash(VEC3_BYTES32, [pad(32, TAG_MIX), entropy, gameDigest]);
}

// ---------------------------------------------------------------------------------------
// Turn resolution
// ---------------------------------------------------------------------------------------

export type ResolvedTurn = {
  /** Roll 1 in full. */
  roll0: number[];
  /** Roll 2: held dice from roll 1, fresh dice elsewhere. */
  roll1: number[];
  /** Roll 3, and the turn's final dice. */
  roll2: number[];
  /** The mask latched from roll 1 and reused for both rerolls. */
  hold: boolean[];
  /** The modal face of roll 1 -- what the operator must witness. */
  modal: number;
};

/**
 * Mirror of `resolveDiceChecked`: three rolls under one latched hold mask.
 *
 * `mixed` is `mixEntropyTs`'s output, not the raw forced entropy, matching the circuit: the
 * running game digest is folded into the entropy before the roll hash sees it.
 *
 * TWO THINGS DIFFER FROM api/src/policies.ts's `resolveTurnDice`, and both are the circuit's
 * doing rather than a simplification here:
 *
 *  1. ENTROPY IS POSITIONAL, NOT A STREAM. `resolveTurnDice` pulls fresh dice from a
 *     left-to-right `nextDie()` stream, so the number of dice consumed depends on how many
 *     were rerolled. The circuit cannot: die `i` of roll `k` comes from bytes `4i..4i+3` of
 *     the roll-`k` hash, always, whether or not position `i` was rerolled. Fixed, disjoint
 *     byte ranges are what make the five dice independent, and a stream would need a
 *     run-time-indexed read, which language 0.26 does not have. So THIS file, not
 *     api/src/policies.ts, is what a settlement verifier must run; api's version is the
 *     rules-engine model of a turn.
 *  2. STAND STILL "ROLLS" THREE TIMES. `resolveTurnDice` returns early for `Stand` with one
 *     roll; here the mask is all-true so both merges are identities and the final dice are
 *     roll 1 regardless. Same answer, and the circuit has no early return to make.
 *
 * The mask is latched from roll 1 and NOT re-evaluated on roll 2 -- a compiler-imposed
 * constraint promoted to a game rule; see `holdMaskOf` in policy-core.compact.
 */
export function resolveDiceTs(
  tableId: Uint8Array,
  seed: Uint8Array,
  mixed: Uint8Array,
  round: number | bigint,
  policy: number,
  param: number,
  modalOverride?: number,
): ResolvedTurn {
  const roll0 = deriveDiceTs(rollContext(tableId, seed, mixed, round, 0));
  const modal = modalOverride ?? modalFace(roll0);
  const hold = holdMaskOf(policy, param, modal, roll0);

  const merge = (prev: number[], rollIndex: number): number[] => {
    const fresh = deriveDiceTs(rollContext(tableId, seed, mixed, round, rollIndex));
    return prev.map((die, i) => (hold[i] ? die : fresh[i]!));
  };

  const roll1 = merge(roll0, 1);
  const roll2 = merge(roll1, 2);
  return { roll0, roll1, roll2, hold, modal };
}
