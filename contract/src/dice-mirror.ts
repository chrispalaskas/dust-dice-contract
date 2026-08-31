// Copyright (C) Shielded Technologies
// SPDX-License-Identifier: Apache-2.0

/**
 * TypeScript mirror of src/dice-core.compact.
 *
 * This is not test scaffolding -- it is the settlement verifier. When a table settles, the
 * operator reveals its seed and anyone re-derives every roll of the game from public data
 * using this module, with no proof server and no chain access. It is also what the fairness
 * test exercises, because 10 000 rolls through the circuit would take hours and through
 * this mirror takes a second.
 *
 * Because the mirror is load-bearing, it is written INDEPENDENTLY of the compiled circuit
 * rather than delegating to it: the ladder below is hand-written from the same design, and
 * src/test/dice.test.ts asserts the two agree on random inputs. Delegating would make the
 * cross-check vacuous.
 *
 * The one thing it does not reimplement is `persistentHash`. That is a Compact primitive
 * with a field-aligned binary encoding, so the mirror rebuilds the `RollContext` runtime
 * type from the runtime's own public type descriptors and calls the runtime's
 * `persistentHash`. Reimplementing the encoding would be reimplementing the platform, and
 * getting it subtly wrong is exactly the failure the cross-check is there to catch.
 *
 * Any edit to dice-core.compact must be made here too, and vice versa.
 */

import {
  CompactTypeBytes,
  CompactTypeUnsignedInteger,
  persistentHash,
  type CompactType,
} from '@midnight-ntwrk/compact-runtime';

// ---------------------------------------------------------------------------------------
// Design constants
// ---------------------------------------------------------------------------------------

/** Candidate bytes per die. 4 => exhaustion probability (4/256)^4 = 5.96e-8. */
export const CANDIDATES_PER_DIE = 4;

/** Dice per roll. */
export const DICE_PER_ROLL = 5;

/**
 * Bytes 0..251 are accepted; 252..255 reject. 252 = 6 * 42, so each face gets exactly 42
 * of the accepted values and the ladder is exactly fair conditional on acceptance.
 */
export const ACCEPT_LIMIT = 252;

/** Bucket width: floor(ACCEPT_LIMIT / 6). */
export const BUCKET = 42;

/** The die returned when every candidate rejects. Biases this face by ~5.96e-8. */
export const EXHAUSTION_FALLBACK = 1;

/** Domain tag; must equal `pad(32, "yahtzee:v1:roll")` in dice-core.compact. */
export const ROLL_DOMAIN_TAG = 'yahtzee:v1:roll';

// ---------------------------------------------------------------------------------------
// Roll context and its runtime type
// ---------------------------------------------------------------------------------------

/** Mirror of the Compact `RollContext` struct, in the runtime's TypeScript representation. */
export type RollContextTs = {
  domain: Uint8Array;
  tableId: Uint8Array;
  seed: Uint8Array;
  playerEntropy: Uint8Array;
  round: bigint;
  rollIndex: bigint;
  stream: bigint;
};

/**
 * `pad(n, s)` in Compact: the UTF-8 bytes of `s` at the START of an n-byte buffer, zero
 * bytes after. The direction is not documented anywhere we could find; it was established
 * by compiling `pad` into a circuit and comparing hashes against this function, and
 * src/test/dice.test.ts keeps that check alive.
 */
export function pad(length: number, s: string): Uint8Array {
  const bytes = new TextEncoder().encode(s);
  if (bytes.length > length) {
    throw new Error(`pad: "${s}" is ${bytes.length} bytes, does not fit in ${length}`);
  }
  const out = new Uint8Array(length);
  out.set(bytes, 0);
  return out;
}

export const ROLL_DOMAIN: Uint8Array = pad(32, ROLL_DOMAIN_TAG);

const BYTES32 = new CompactTypeBytes(32);
const UINT8 = new CompactTypeUnsignedInteger(255n, 1);

/**
 * Runtime type for `RollContext`, field order matching the struct declaration exactly.
 * Compact encodes a struct as the concatenation of its fields in declaration order, so a
 * reordered field here would silently produce different hashes -- caught by the
 * cross-check, not by the type system.
 */
const ROLL_CONTEXT_TYPE: CompactType<RollContextTs> = {
  alignment: () =>
    BYTES32.alignment()
      .concat(BYTES32.alignment())
      .concat(BYTES32.alignment())
      .concat(BYTES32.alignment())
      .concat(UINT8.alignment())
      .concat(UINT8.alignment())
      .concat(UINT8.alignment()),
  toValue: (v: RollContextTs) =>
    BYTES32.toValue(v.domain)
      .concat(BYTES32.toValue(v.tableId))
      .concat(BYTES32.toValue(v.seed))
      .concat(BYTES32.toValue(v.playerEntropy))
      .concat(UINT8.toValue(v.round))
      .concat(UINT8.toValue(v.rollIndex))
      .concat(UINT8.toValue(v.stream)),
  fromValue: (value) => ({
    domain: BYTES32.fromValue(value),
    tableId: BYTES32.fromValue(value),
    seed: BYTES32.fromValue(value),
    playerEntropy: BYTES32.fromValue(value),
    round: UINT8.fromValue(value),
    rollIndex: UINT8.fromValue(value),
    stream: UINT8.fromValue(value),
  }),
};

/** Mirror of `rollContext`. */
export function rollContext(
  tableId: Uint8Array,
  seed: Uint8Array,
  playerEntropy: Uint8Array,
  round: number | bigint,
  rollIndex: number | bigint,
): RollContextTs {
  return {
    domain: ROLL_DOMAIN,
    tableId,
    seed,
    playerEntropy,
    round: BigInt(round),
    rollIndex: BigInt(rollIndex),
    stream: 0n,
  };
}

/** Mirror of `rollBytes`: the 32 entropy bytes for one roll. */
export function rollBytes(ctx: RollContextTs): Uint8Array {
  return persistentHash(ROLL_CONTEXT_TYPE, ctx);
}

// ---------------------------------------------------------------------------------------
// The ladder
// ---------------------------------------------------------------------------------------

/** Per-candidate outcome, so callers can measure the rejection rate. */
export type Candidate = { accepted: boolean; die: number };

/**
 * Mirror of `byteCandidate`. One byte in, one candidate out.
 *
 * `1 + count of thresholds passed` rather than a division, matching the circuit's threshold
 * ladder. For b < 252 this is exactly `1 + floor(b / 42)`.
 */
export function byteCandidate(b: number): Candidate {
  const die =
    1 +
    (b >= BUCKET ? 1 : 0) +
    (b >= 2 * BUCKET ? 1 : 0) +
    (b >= 3 * BUCKET ? 1 : 0) +
    (b >= 4 * BUCKET ? 1 : 0) +
    (b >= 5 * BUCKET ? 1 : 0);
  return { accepted: b < ACCEPT_LIMIT, die };
}

/** Counters the fairness test reads to check the ladder behaves as designed. */
export type LadderStats = {
  /** Candidates evaluated that rejected. Expected rate 4/256 = 1/64. */
  rejections: number;
  /** Dice where every candidate rejected and the fallback was used. Expected ~0. */
  exhaustions: number;
};

export function newLadderStats(): LadderStats {
  return { rejections: 0, exhaustions: 0 };
}

/**
 * Mirror of `dieFromBytes`. First accepted candidate wins; fallback if all reject.
 *
 * `stats` is optional and off the hot path of the verifier -- it exists so the fairness
 * test can confirm the observed rejection rate matches 1/64 rather than trusting that the
 * byte extraction lines up with the circuit's.
 */
export function dieFromBytes(cands: ArrayLike<number>, stats?: LadderStats): number {
  for (let i = 0; i < cands.length; i++) {
    const c = byteCandidate(cands[i]!);
    if (c.accepted) return c.die;
    if (stats) stats.rejections++;
  }
  if (stats) stats.exhaustions++;
  return EXHAUSTION_FALLBACK;
}

/**
 * Mirror of `deriveDice`. Die d consumes entropy bytes 4d..4d+3, so the byte ranges of the
 * five dice are disjoint and bytes 20..31 go unused.
 */
export function diceFromEntropy(entropy: Uint8Array, stats?: LadderStats): number[] {
  if (entropy.length < DICE_PER_ROLL * CANDIDATES_PER_DIE) {
    throw new Error(
      `diceFromEntropy: need ${DICE_PER_ROLL * CANDIDATES_PER_DIE} bytes, got ${entropy.length}`,
    );
  }
  const dice: number[] = [];
  for (let d = 0; d < DICE_PER_ROLL; d++) {
    const start = d * CANDIDATES_PER_DIE;
    dice.push(dieFromBytes(entropy.subarray(start, start + CANDIDATES_PER_DIE), stats));
  }
  return dice;
}

/** Mirror of `deriveDice`, from a roll context. */
export function deriveDiceTs(ctx: RollContextTs, stats?: LadderStats): number[] {
  return diceFromEntropy(rollBytes(ctx), stats);
}

// ---------------------------------------------------------------------------------------
// Bit ladder (mirrors the rejected design, kept so the comparison is reproducible)
// ---------------------------------------------------------------------------------------

/** Mirror of `top3`: floor(b / 32). */
export function top3(b: number): number {
  return (
    (b >= 32 ? 1 : 0) +
    (b >= 64 ? 1 : 0) +
    (b >= 96 ? 1 : 0) +
    (b >= 128 ? 1 : 0) +
    (b >= 160 ? 1 : 0) +
    (b >= 192 ? 1 : 0) +
    (b >= 224 ? 1 : 0)
  );
}

/** Mirror of `mid3`: floor((b mod 32) / 4). */
export function mid3(b: number): number {
  const r = b - 32 * top3(b);
  return (
    (r >= 4 ? 1 : 0) +
    (r >= 8 ? 1 : 0) +
    (r >= 12 ? 1 : 0) +
    (r >= 16 ? 1 : 0) +
    (r >= 20 ? 1 : 0) +
    (r >= 24 ? 1 : 0) +
    (r >= 28 ? 1 : 0)
  );
}

/** Mirror of `deriveDiceBitLadder`: 12 three-bit candidates per die, 6 bytes per die. */
export function deriveDiceBitLadderTs(ctx: RollContextTs): number[] {
  const v = rollBytes(ctx);
  const dice: number[] = [];
  for (let d = 0; d < DICE_PER_ROLL; d++) {
    let die = EXHAUSTION_FALLBACK;
    let found = false;
    for (let byteOffset = 0; byteOffset < 6 && !found; byteOffset++) {
      const b = v[d * 6 + byteOffset]!;
      for (const t of [top3(b), mid3(b)]) {
        if (!found && t < 6) {
          die = t + 1;
          found = true;
        }
      }
    }
    dice.push(die);
  }
  return dice;
}

// ---------------------------------------------------------------------------------------
// Turn resolution (mirrors turn.compact)
// ---------------------------------------------------------------------------------------

/**
 * Mirror of the Compact `HoldPolicy` enum. A plain const object rather than a TS enum:
 * `node --experimental-strip-types` rejects TS enums, and the generated contract bindings
 * represent enum values as plain numbers anyway.
 */
export const HoldPolicy = {
  keepNone: 0,
  keepModalFace: 1,
  keepGe4: 2,
} as const;

export type HoldPolicyValue = (typeof HoldPolicy)[keyof typeof HoldPolicy];

/** Mirror of `faceCount`. */
export function faceCount(dice: readonly number[], face: number): number {
  let n = 0;
  for (const d of dice) if (d === face) n++;
  return n;
}

/** Mirror of `modalFace`. Ties break to the HIGHER face -- note the `>=`. */
export function modalFace(dice: readonly number[]): number {
  let bestFace = 1;
  let bestCount = faceCount(dice, 1);
  for (let f = 2; f <= 6; f++) {
    const c = faceCount(dice, f);
    if (c >= bestCount) {
      bestCount = c;
      bestFace = f;
    }
  }
  return bestFace;
}

/** Mirror of `holdMask`. */
export function holdMask(policy: HoldPolicyValue, dice: readonly number[]): boolean[] {
  const modal = modalFace(dice);
  return dice.map((d) => {
    if (policy === HoldPolicy.keepNone) return false;
    if (policy === HoldPolicy.keepGe4) return d >= 4;
    return d === modal;
  });
}

export type TurnResultTs = {
  roll0: number[];
  roll1: number[];
  roll2: number[];
};

/**
 * Mirror of `resolveTurnPure`. Three rolls, fresh dice drawn from a hash with the matching
 * `rollIndex`.
 *
 * The hold mask is computed ONCE from roll 1 and reused for both re-rolls. That is not a
 * simplification for the mirror's benefit -- the circuit is forced into it by a compactc
 * 0.34.0 compile-time blowup on nested comparison chains (docs/bugs-found.md #1), and the
 * mirror has to match the circuit exactly or settlement verification disagrees with the
 * chain. Do not "fix" this to re-evaluate per roll without changing turn.compact first.
 */
export function resolveTurnTs(
  tableId: Uint8Array,
  seed: Uint8Array,
  playerEntropy: Uint8Array,
  round: number | bigint,
  policy: HoldPolicyValue,
): TurnResultTs {
  const roll0 = deriveDiceTs(rollContext(tableId, seed, playerEntropy, round, 0));
  const hold = holdMask(policy, roll0);
  const rolls: number[][] = [roll0];
  for (let i = 1; i < 3; i++) {
    const prev = rolls[i - 1]!;
    const fresh = deriveDiceTs(rollContext(tableId, seed, playerEntropy, round, i));
    rolls.push(prev.map((d, j) => (hold[j] ? d : fresh[j]!)));
  }
  return { roll0: rolls[0]!, roll1: rolls[1]!, roll2: rolls[2]! };
}
