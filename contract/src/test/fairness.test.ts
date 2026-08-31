// Copyright (C) Shielded Technologies
// SPDX-License-Identifier: Apache-2.0

/**
 * Statistical fairness of the dice derivation.
 *
 * The ladder is fair BY CONSTRUCTION -- 252 accepted byte values split into six buckets of
 * exactly 42 -- and src/test/dice.test.ts proves that exhaustively over all 256 byte
 * values. So this file is not really testing the bucket arithmetic; it is testing that the
 * bytes fed into the buckets are uniform, which is a property of `persistentHash` and of
 * how the derivation slices its output, and which no amount of staring at the code shows.
 *
 * Two independent runs:
 *
 *   1. THE HASH PATH. 20 000 roll contexts through the full mirror -- domain-separated
 *      `persistentHash`, byte slicing, ladder. This is the one that matters: it would catch
 *      a hash whose low bytes are skewed, an off-by-one in the byte ranges, or two dice
 *      accidentally sharing entropy.
 *   2. THE LADDER ALONE. 20 000 rolls of uniform random bytes straight into the ladder,
 *      bypassing the hash. If run 1 fails and run 2 passes, the fault is in the hashing or
 *      slicing rather than the buckets.
 *
 * Inputs for run 1 are DERIVED FROM A FIXED SEED, not from the system RNG, so the
 * chi-square statistic is the same on every machine and every run. A test that draws fresh
 * randomness fails 5% of the time at p=0.05 by definition, and a suite that cries wolf one
 * run in twenty gets ignored. Run 2 uses the system RNG deliberately -- it is a much weaker
 * claim (uniform bytes in, uniform faces out) and a wider bound covers it.
 *
 * The hard assertion is at p=0.001 (chi-square 20.515, df=5), not p=0.05. The reported
 * verdict is against the p=0.05 critical value of 11.07 as asked for.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import {
  DICE_PER_ROLL,
  diceFromEntropy,
  deriveDiceTs,
  newLadderStats,
  rollContext,
  type LadderStats,
} from '../dice-mirror.ts';

/** Rolls per run. 20 000 rolls = 100 000 faces, comfortably above the 50 000 asked for. */
const ROLLS = 20_000;

/** chi-square critical values, df = 5. */
const CHI2_P050 = 11.07;
const CHI2_P001 = 20.515;

/** Deterministic 32-byte stream: sha256("yahtzee-fairness" || i). */
function derivedBytes(label: string, i: number): Uint8Array {
  return new Uint8Array(createHash('sha256').update(`${label}:${i}`).digest());
}

type FaceCounts = number[]; // index 0 unused; 1..6 are the faces

function emptyCounts(): FaceCounts {
  return new Array(7).fill(0);
}

function chiSquare(counts: FaceCounts): { chi2: number; total: number; expected: number } {
  const total = counts.slice(1).reduce((a, b) => a + b, 0);
  const expected = total / 6;
  let chi2 = 0;
  for (let f = 1; f <= 6; f++) {
    const d = counts[f]! - expected;
    chi2 += (d * d) / expected;
  }
  return { chi2, total, expected };
}

/**
 * `deterministic` changes only the wording of the verdict, and it matters. With fresh
 * randomness the statistic exceeds the p=0.05 critical value in 1 run out of 20 BY
 * DEFINITION, so printing "BIASED" there would be wrong 5% of the time -- and it did print
 * exactly that on a passing run during development. A run over the line is evidence of bias
 * only when the inputs are fixed and the statistic is reproducible.
 */
function report(
  title: string,
  counts: FaceCounts,
  deterministic: boolean,
  stats?: LadderStats,
): number {
  const { chi2, total, expected } = chiSquare(counts);
  const lines = [
    '',
    `${title}`,
    `  rolls ${(total / DICE_PER_ROLL).toLocaleString('en-US')}   faces ${total.toLocaleString('en-US')}   expected per face ${expected.toLocaleString('en-US')}`,
  ];
  for (let f = 1; f <= 6; f++) {
    const n = counts[f]!;
    const dev = ((n - expected) / expected) * 100;
    lines.push(`  face ${f}: ${String(n).padStart(7)}  (${dev >= 0 ? '+' : ''}${dev.toFixed(3)}%)`);
  }
  lines.push(`  chi-square = ${chi2.toFixed(4)}   critical(df=5, p=0.05) = ${CHI2_P050}`);
  if (chi2 < CHI2_P050) {
    lines.push('  verdict: FAIR (cannot reject uniformity at p=0.05)');
  } else if (deterministic) {
    lines.push(`  verdict: OVER the p=0.05 critical value on FIXED inputs -- investigate`);
  } else {
    lines.push(
      '  verdict: over the p=0.05 critical value, on fresh randomness -- expected in ~1 run in 20, not evidence of bias',
    );
  }
  if (stats) {
    const candidates = total + stats.rejections;
    lines.push(
      `  candidate rejections: ${stats.rejections.toLocaleString('en-US')} of ${candidates.toLocaleString('en-US')} (${((stats.rejections / candidates) * 100).toFixed(4)}%, expected 1.5625%)`,
    );
    lines.push(`  ladder exhaustions (all 4 candidates rejected): ${stats.exhaustions}`);
  }
  console.log(lines.join('\n'));
  return chi2;
}

describe('fairness', () => {
  it('the hash path produces a uniform face distribution', () => {
    const counts = emptyCounts();
    const stats = newLadderStats();
    for (let i = 0; i < ROLLS; i++) {
      const ctx = rollContext(
        derivedBytes('table', i),
        derivedBytes('seed', i),
        derivedBytes('entropy', i),
        i % 256,
        (i >> 8) % 3,
      );
      for (const d of deriveDiceTs(ctx, stats)) counts[d]!++;
    }
    const chi2 = report('hash path (deterministic inputs)', counts, true, stats);

    // Exhaustion probability is 5.96e-8 per die; over 100 000 dice the expected count is
    // 0.006, so a single occurrence here would mean the entropy is not what we think.
    assert.equal(stats.exhaustions, 0, 'ladder exhausted -- entropy is not uniform');

    // Observed rejection rate must sit near 1/64. A rate far from it means the byte
    // extraction is not reading the bytes we think it is.
    const candidates = counts.slice(1).reduce((a, b) => a + b, 0) + stats.rejections;
    const rate = stats.rejections / candidates;
    assert.ok(
      rate > 0.012 && rate < 0.02,
      `candidate rejection rate ${rate} is not near the expected 0.015625`,
    );

    assert.ok(chi2 < CHI2_P001, `chi-square ${chi2} exceeds the p=0.001 bound ${CHI2_P001}`);
  });

  it('the ladder alone produces a uniform face distribution', () => {
    const counts = emptyCounts();
    const stats = newLadderStats();
    for (let i = 0; i < ROLLS; i++) {
      for (const d of diceFromEntropy(new Uint8Array(randomBytes(32)), stats)) counts[d]!++;
    }
    const chi2 = report('ladder alone (system RNG)', counts, false, stats);
    assert.ok(chi2 < CHI2_P001, `chi-square ${chi2} exceeds the p=0.001 bound ${CHI2_P001}`);
  });

  it('each of the five die positions is individually uniform', () => {
    // A per-position bias would hide inside the pooled distribution: if die 0 skewed high
    // and die 1 skewed low by the same amount, the pooled counts would look perfect.
    //
    // MULTIPLE COMPARISONS. This runs five chi-square tests, so at p=0.05 the chance that
    // at least one exceeds 11.07 with perfectly fair dice is 1 - 0.95^5 = 23%. Reading a
    // single position over 11.07 as "biased" is a mistake, and it is why the bound asserted
    // here is the p=0.001 value.
    //
    // This is not hypothetical: on the first run of this suite, position 2 came out at
    // chi2 = 16.73. It was noise. Scaling the SAME deterministic inputs 10x to 200 000
    // rolls dropped it to 5.23 (a real bias would have grown roughly 10x, to ~167); across
    // four different input families the outlier moved to a different position every time;
    // and entropy byte 8 -- position 2's first candidate -- is uniform on its own
    // (chi2 = 4.71 over 200 000 samples, with 3 123 rejections against 3 125 expected).
    const perPosition = Array.from({ length: DICE_PER_ROLL }, () => emptyCounts());
    for (let i = 0; i < ROLLS; i++) {
      const dice = deriveDiceTs(
        rollContext(
          derivedBytes('pos-table', i),
          derivedBytes('pos-seed', i),
          derivedBytes('pos-entropy', i),
          i % 256,
          (i >> 8) % 3,
        ),
      );
      dice.forEach((d, j) => perPosition[j]![d]!++);
    }
    for (let j = 0; j < DICE_PER_ROLL; j++) {
      const { chi2 } = chiSquare(perPosition[j]!);
      console.log(`  die position ${j}: chi-square = ${chi2.toFixed(4)}`);
      assert.ok(chi2 < CHI2_P001, `die position ${j} chi-square ${chi2} exceeds ${CHI2_P001}`);
    }
  });
});
