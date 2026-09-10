// Copyright (C) Shielded Technologies
// SPDX-License-Identifier: Apache-2.0

/**
 * Execution tests for the dice derivation.
 *
 * The load-bearing test here is `mirror agrees with circuit`. src/dice-mirror.ts is the
 * settlement verifier: if it disagrees with the circuit by one byte, every settled game is
 * unverifiable and the disagreement will not show up until a real table settles. So the
 * mirror is written independently of the circuit and checked against it on random inputs
 * rather than being derived from it.
 *
 * Run: node --test src/test/dice.test.ts   (or npm test -w @dust-dice/contract)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { pureCircuits as dicePure } from '../managed/dice/contract/index.js';
import { pureCircuits as turnPure } from '../managed/turn/contract/index.js';
import {
  CANDIDATES_PER_DIE,
  DICE_PER_ROLL,
  HoldPolicy,
  ROLL_DOMAIN,
  ROLL_DOMAIN_TAG,
  byteCandidate,
  deriveDiceBitLadderTs,
  deriveDiceTs,
  diceFromEntropy,
  modalFace,
  resolveTurnTs,
  rollBytes,
  rollContext,
  type HoldPolicyValue,
} from '../dice-mirror.ts';
import { createDicePrivateState } from '../witnesses.ts';
import { DiceSimulator, TurnSimulator, diceToArray } from './simulator.ts';

/** Deterministic 32-byte value; tests must not depend on the machine's RNG. */
function fixed(byte: number): Uint8Array {
  return new Uint8Array(32).fill(byte);
}

const TABLE = fixed(0x11);
const SEED = fixed(0x22);
const ENTROPY = fixed(0x33);

function ctx(round = 0, rollIndex = 0) {
  return rollContext(TABLE, SEED, ENTROPY, round, rollIndex);
}

describe('deriveDice (circuit, via pureCircuits)', () => {
  it('returns five dice, every one in 1..6', () => {
    const dice = dicePure.deriveDice(ctx()).map(Number);
    assert.equal(dice.length, DICE_PER_ROLL);
    for (const d of dice) {
      assert.ok(Number.isInteger(d) && d >= 1 && d <= 6, `die out of range: ${d}`);
    }
  });

  it('is deterministic: same context, same dice', () => {
    const a = dicePure.deriveDice(ctx()).map(Number);
    const b = dicePure.deriveDice(ctx()).map(Number);
    assert.deepEqual(a, b);
  });

  it('changes when any context field changes', () => {
    const base = dicePure.deriveDice(ctx()).map(Number).join(',');
    const variants = [
      rollContext(fixed(0x12), SEED, ENTROPY, 0, 0),
      rollContext(TABLE, fixed(0x23), ENTROPY, 0, 0),
      rollContext(TABLE, SEED, fixed(0x34), 0, 0),
      rollContext(TABLE, SEED, ENTROPY, 1, 0),
      rollContext(TABLE, SEED, ENTROPY, 0, 1),
    ];
    // Any single one could collide by chance (~1/7776); all five colliding will not happen.
    const differing = variants.filter(
      (v) => dicePure.deriveDice(v).map(Number).join(',') !== base,
    ).length;
    assert.ok(
      differing >= 4,
      `expected the roll to move when the context does, got ${differing}/5`,
    );
  });

  it('every die is in range across 200 random contexts', () => {
    for (let i = 0; i < 200; i++) {
      const dice = dicePure
        .deriveDice(rollContext(randomBytes(32), randomBytes(32), randomBytes(32), i % 256, 0))
        .map(Number);
      for (const d of dice) {
        assert.ok(d >= 1 && d <= 6, `die out of range: ${d}`);
      }
    }
  });
});

describe('mirror agrees with circuit', () => {
  it('pad() matches the circuit domain tag', () => {
    // If pad() padded from the wrong end, ROLL_DOMAIN would differ and every hash with it,
    // so this is really asserted by the cross-check below -- but a direct failure here is
    // far easier to read than 50 mismatched dice.
    assert.equal(ROLL_DOMAIN.length, 32);
    const tag = new TextEncoder().encode(ROLL_DOMAIN_TAG);
    assert.deepEqual(Array.from(ROLL_DOMAIN.subarray(0, tag.length)), Array.from(tag));
    assert.ok(ROLL_DOMAIN.subarray(tag.length).every((b) => b === 0));
  });

  it('deriveDice matches on 50 random inputs', () => {
    for (let i = 0; i < 50; i++) {
      const c = rollContext(randomBytes(32), randomBytes(32), randomBytes(32), i, i % 3);
      assert.deepEqual(
        deriveDiceTs(c),
        dicePure.deriveDice(c).map(Number),
        `mirror/circuit mismatch at iteration ${i}`,
      );
    }
  });

  it('deriveDiceBitLadder matches on 50 random inputs', () => {
    for (let i = 0; i < 50; i++) {
      const c = rollContext(randomBytes(32), randomBytes(32), randomBytes(32), i, i % 3);
      assert.deepEqual(
        deriveDiceBitLadderTs(c),
        dicePure.deriveDiceBitLadder(c).map(Number),
        `bit-ladder mirror/circuit mismatch at iteration ${i}`,
      );
    }
  });

  it('the two ladders disagree, so they are genuinely different designs', () => {
    // Not a correctness requirement -- a guard against the two mirrors accidentally being
    // the same function, which would make the previous test pass vacuously.
    let differing = 0;
    for (let i = 0; i < 20; i++) {
      const c = rollContext(randomBytes(32), randomBytes(32), randomBytes(32), i, 0);
      if (deriveDiceTs(c).join(',') !== deriveDiceBitLadderTs(c).join(',')) differing++;
    }
    assert.ok(differing >= 15, `expected the two designs to differ, only ${differing}/20 did`);
  });

  it('resolveTurnPure matches on 50 random inputs, for every policy', () => {
    const policies: HoldPolicyValue[] = [
      HoldPolicy.keepNone,
      HoldPolicy.keepModalFace,
      HoldPolicy.keepGe4,
    ];
    for (let i = 0; i < 50; i++) {
      const tableId = randomBytes(32);
      const seed = randomBytes(32);
      const entropy = randomBytes(32);
      const round = i % 13;
      const policy = policies[i % policies.length]!;
      const circuit = turnPure.resolveTurnPure(tableId, seed, entropy, BigInt(round), policy);
      const mirror = resolveTurnTs(tableId, seed, entropy, round, policy);
      assert.deepEqual(diceToArray(circuit.roll0), mirror.roll0, `roll0 differs at ${i}`);
      assert.deepEqual(diceToArray(circuit.roll1), mirror.roll1, `roll1 differs at ${i}`);
      assert.deepEqual(diceToArray(circuit.roll2), mirror.roll2, `roll2 differs at ${i}`);
    }
  });
});

describe('ladder properties', () => {
  it('accepts exactly 252 of 256 byte values', () => {
    let accepted = 0;
    for (let b = 0; b < 256; b++) if (byteCandidate(b).accepted) accepted++;
    assert.equal(accepted, 252);
  });

  it('maps the accepted bytes to six faces of exactly 42 values each', () => {
    const counts = new Map<number, number>();
    for (let b = 0; b < 256; b++) {
      const c = byteCandidate(b);
      if (c.accepted) counts.set(c.die, (counts.get(c.die) ?? 0) + 1);
    }
    assert.deepEqual(
      [...counts.keys()].sort((x, y) => x - y),
      [1, 2, 3, 4, 5, 6],
    );
    for (const [face, n] of counts) {
      assert.equal(n, 42, `face ${face} got ${n} of the 252 accepted bytes, expected 42`);
    }
  });

  it('falls back to 1 when every candidate rejects', () => {
    // All-0xFF entropy: 255 >= 252, so all four candidates for every die reject.
    const entropy = new Uint8Array(DICE_PER_ROLL * CANDIDATES_PER_DIE).fill(0xff);
    assert.deepEqual(diceFromEntropy(entropy), [1, 1, 1, 1, 1]);
  });

  it('takes the first accepting candidate, not a later one', () => {
    // die 0: bytes [0xFF, 0xFF, 0, 42] -> first two reject, third accepts as face 1.
    const entropy = new Uint8Array(DICE_PER_ROLL * CANDIDATES_PER_DIE);
    entropy[0] = 0xff;
    entropy[1] = 0xff;
    entropy[2] = 0;
    entropy[3] = 42;
    assert.equal(diceFromEntropy(entropy)[0], 1);
  });

  it('uses disjoint byte ranges per die: touching die 3 leaves die 0 alone', () => {
    const a = new Uint8Array(32);
    const b = new Uint8Array(32);
    b[12] = 200;
    assert.equal(diceFromEntropy(a)[0], diceFromEntropy(b)[0]);
    assert.notEqual(diceFromEntropy(a)[3], diceFromEntropy(b)[3]);
  });

  it('reads only the first 20 of the 32 entropy bytes', () => {
    const a = new Uint8Array(32).fill(7);
    const b = new Uint8Array(32).fill(7);
    b.fill(200, 20);
    assert.deepEqual(diceFromEntropy(a), diceFromEntropy(b));
  });
});

describe('modal face', () => {
  it('picks the most common face', () => {
    assert.equal(modalFace([3, 3, 3, 1, 2]), 3);
  });

  it('breaks ties toward the higher face', () => {
    assert.equal(modalFace([2, 2, 5, 5, 1]), 5);
  });

  it('picks the highest die when all five differ', () => {
    assert.equal(modalFace([1, 2, 3, 4, 5]), 5);
  });
});

describe('circuits execute against a ledger', () => {
  it('rollDice writes dice in range and returns them', async () => {
    const sim = await DiceSimulator.create(createDicePrivateState(SEED));
    const dice = diceToArray(await sim.rollDice(TABLE, SEED, ENTROPY, 0n, 0n));
    for (const d of dice) assert.ok(d >= 1 && d <= 6, `die out of range: ${d}`);
    assert.deepEqual(diceToArray(sim.getLedger().lastDice), dice);
    assert.deepEqual(dice, deriveDiceTs(ctx()));
  });

  it('rollDiceSecretSeed reads the seed from the witness and agrees with the public form', async () => {
    const sim = await DiceSimulator.create(createDicePrivateState(SEED));
    const viaWitness = diceToArray(await sim.rollDiceSecretSeed(TABLE, ENTROPY, 0n, 0n));
    const viaArgument = diceToArray(await sim.rollDice(TABLE, SEED, ENTROPY, 0n, 0n));
    assert.deepEqual(viaWitness, viaArgument);
  });

  it('probeHashOnly returns the same 32 bytes the mirror hashes', async () => {
    const sim = await DiceSimulator.create(createDicePrivateState(SEED));
    const h = await sim.probeHashOnly(TABLE, SEED, ENTROPY, 0n, 0n);
    assert.deepEqual(Array.from(h), Array.from(rollBytes(ctx())));
  });

  it('resolveTurn matches the mirror and holds what the policy says', async () => {
    const sim = await TurnSimulator.create(createDicePrivateState(SEED));
    const res = await sim.resolveTurn(TABLE, ENTROPY, 0n, HoldPolicy.keepGe4);
    const mirror = resolveTurnTs(TABLE, SEED, ENTROPY, 0, HoldPolicy.keepGe4);
    assert.deepEqual(diceToArray(res.roll0), mirror.roll0);
    assert.deepEqual(diceToArray(res.roll2), mirror.roll2);
    // keepGe4 latches on roll 1: every die that was >= 4 then must survive both re-rolls.
    const r0 = diceToArray(res.roll0);
    const r2 = diceToArray(res.roll2);
    r0.forEach((d, i) => {
      if (d >= 4) assert.equal(r2[i], d, `held die ${i} (${d}) was re-rolled to ${r2[i]}`);
    });
  });

  it('keepNone holds nothing, so roll 3 is a fresh derivation', async () => {
    const sim = await TurnSimulator.create(createDicePrivateState(SEED));
    const res = await sim.resolveTurn(TABLE, ENTROPY, 0n, HoldPolicy.keepNone);
    assert.deepEqual(diceToArray(res.roll2), deriveDiceTs(ctx(0, 2)));
  });

  it('the same turn twice gives the same dice', async () => {
    const sim = await TurnSimulator.create(createDicePrivateState(SEED));
    const a = await sim.resolveTurn(TABLE, ENTROPY, 3n, HoldPolicy.keepModalFace);
    const b = await sim.resolveTurn(TABLE, ENTROPY, 3n, HoldPolicy.keepModalFace);
    assert.deepEqual(diceToArray(a.roll2), diceToArray(b.roll2));
  });
});
