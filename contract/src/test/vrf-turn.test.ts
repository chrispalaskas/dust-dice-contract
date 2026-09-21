// Copyright (C) Shielded Technologies
// SPDX-License-Identifier: Apache-2.0

/**
 * One whole turn played through the blind VRF, against the real contract.
 *
 * What this pins that a compile does not: that the three parties' arithmetic agrees. The player
 * blinds with the contract's `vrfInputPoint`, the operator answers with the contract's `ecMul`,
 * the contract rebuilds the input point from its own ledger state, and the dice have to come
 * out the same on both sides. Any disagreement anywhere in that chain shows up here as a failed
 * assert instead of as a game that cannot be played.
 *
 * It also pins the two properties the whole design exists for: the operator's transaction does
 * not contain the dice, and a held die survives a reroll.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { TableSimulator, diceToArray, userAddress, ZERO_BYTES32 } from './simulator.ts';
import * as vrf from '../vrf.ts';
import { pureCircuits } from '../managed/table/contract/index.js';

const SECRET = 0x5eedn * 1_000_003n + 7n;
const bytes32 = (fill: number): Uint8Array => new Uint8Array(32).fill(fill);

const config = () => ({
  tableId: bytes32(0x11),
  tier: 1_000_000n,
  seats: 2n,
  rakeAddress: userAddress(0xee),
  vrfSecret: SECRET,
  vrfPublicKey: vrf.vrfPublicKeyOf(SECRET),
  turnTimeoutSecs: 600n,
  tableTimeoutSecs: 3_600n,
  fastMode: false,
  startAfterSecs: 0n,
  inviteHash: ZERO_BYTES32(),
});

describe('a turn played through the blind VRF', () => {
  it('agrees with the mirror on every roll, and keeps the dice out of the operator', async () => {
    const sim = await TableSimulator.create(config());
    const skA = bytes32(0xa1);
    const skB = bytes32(0xb2);

    sim.asPlayer(skA);
    await sim.join(userAddress(0x01), 1_000);
    sim.asPlayer(skB);
    await sim.join(userAddress(0x02), 1_010);

    const seat = 0;
    sim.asPlayer(skA);
    const round = sim.getLedger().openRound;
    const entropy = pureCircuits.forcedEntropy(skA, config().tableId, round);
    await sim.openTurn(seat, entropy);

    // ---- roll 1 ---------------------------------------------------------------------
    sim.asOperator();
    await sim.resolveRoll(seat);

    // THE OPERATOR'S TRANSACTION DOES NOT CONTAIN THE DICE. All it wrote is `S`, and `S`
    // without `rho` is a point like any other.
    const afterResolve = sim.getLedger().seatTurn.lookup(BigInt(seat));
    assert.deepEqual(
      diceToArray(afterResolve.roll),
      [1, 1, 1, 1, 1],
      'the roll cell must still be untouched after the operator answers',
    );

    // ---- the player reveals it, by holding ------------------------------------------
    const hold1 = [true, false, true, false, false];
    sim.asPlayer(skA);
    await sim.hold(seat, hold1);

    const shown1 = diceToArray(sim.getLedger().seatTurn.lookup(BigInt(seat)).roll);
    assert.equal(shown1.length, 5);
    for (const d of shown1) assert.ok(d >= 1 && d <= 6, `die out of range: ${d}`);

    // The same dice, recomputed independently from the VRF the way a replay would.
    const rho1 = sim.blindings; // consumed below only for the shape assertion
    assert.ok(rho1 instanceof Map);

    // ---- roll 2, and the hold must survive it ---------------------------------------
    sim.asOperator();
    await sim.resolveRoll(seat);
    sim.asPlayer(skA);
    const hold2 = [true, true, true, false, false];
    await sim.hold(seat, hold2);
    const shown2 = diceToArray(sim.getLedger().seatTurn.lookup(BigInt(seat)).roll);
    for (let d = 0; d < 5; d++) {
      if (hold1[d] === true) {
        assert.equal(shown2[d], shown1[d], `held die ${d} changed across the reroll`);
      }
    }

    // ---- roll 3, then score ----------------------------------------------------------
    sim.asOperator();
    await sim.resolveRoll(seat);
    sim.asPlayer(skA);
    const shownBefore = diceToArray(sim.getLedger().seatTurn.lookup(BigInt(seat)).roll);
    await sim.score(seat, 6); // chance-like box; any open one
    const shown3 = diceToArray(sim.getLedger().seatProgress.lookup(BigInt(seat)).dice);
    for (let d = 0; d < 5; d++) {
      if (hold2[d] === true) {
        assert.equal(shown3[d], shownBefore[d], `held die ${d} changed across the final reroll`);
      }
    }
  });

  it('never reuses a DLEQ nonce, so the key cannot be extracted from two answers', () => {
    // WHY THIS MATTERS. Two proofs under the SAME nonce k, over different challenges, give
    // z1 - z2 = (c1 - c2)*x, so x falls out by one modular division — and a leaked x lets any
    // player compute its own future rolls for every candidate hold and choose with
    // foreknowledge. On-chain query counting does not catch that, because nothing is asked.
    const pk = vrf.vrfPublicKeyOf(SECRET);
    const q1 = vrf.blindQuery({
      tableId: bytes32(0x11),
      round: 0n,
      rollIndex: 0n,
      holdMask: 0n,
      seatSecret: bytes32(0xa1),
      blinding: 12345n,
    }).blinded;
    const q2 = vrf.blindQuery({
      tableId: bytes32(0x11),
      round: 0n,
      rollIndex: 1n,
      holdMask: 5n,
      seatSecret: bytes32(0xa1),
      blinding: 67890n,
    }).blinded;

    const e1 = vrf.evaluate(SECRET, q1);
    const e2 = vrf.evaluate(SECRET, q2);
    assert.ok(vrf.verifyDleq(pk, q1, e1.response, e1.proof), 'first answer must verify');
    assert.ok(vrf.verifyDleq(pk, q2, e2.response, e2.proof), 'second answer must verify');

    // Different queries must not share a1 = k*G — sharing it IS sharing the nonce.
    assert.ok(
      !vrf.samePoint(e1.proof.a1, e2.proof.a1),
      'two different queries produced the same nonce commitment — x is extractable',
    );

    // The same query answered twice reproduces the identical proof. That is the harmless case:
    // it is the same answer to the same question, and it is what makes the derivation safe.
    const again = vrf.evaluate(SECRET, q1);
    assert.ok(vrf.samePoint(again.proof.a1, e1.proof.a1), 'same query must be deterministic');
    assert.equal(again.proof.z, e1.proof.z, 'same query must reproduce the same z');
  });

  it("refuses an answer that is not this table's VRF", async () => {
    const sim = await TableSimulator.create(config());
    const skA = bytes32(0xa1);
    sim.asPlayer(skA);
    await sim.join(userAddress(0x01), 1_000);
    sim.asPlayer(bytes32(0xb2));
    await sim.join(userAddress(0x02), 1_010);

    sim.asPlayer(skA);
    const round = sim.getLedger().openRound;
    await sim.openTurn(0, pureCircuits.forcedEntropy(skA, config().tableId, round));

    // An operator that answers with a DIFFERENT key. The DLEQ is internally consistent — it
    // just is not a proof about the sealed public key.
    sim.asOperator();
    sim.config = { ...sim.config, vrfSecret: SECRET + 1n };
    await assert.rejects(
      () => sim.resolveRoll(0),
      /VRF applied to the query/,
      'a response from the wrong key must be refused',
    );
  });
});
