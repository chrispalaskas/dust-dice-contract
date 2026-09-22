// Copyright (C) Shielded Technologies
// SPDX-License-Identifier: Apache-2.0

/**
 * `revealFor` (reveal.ts) must agree with the CONTRACT on every roll of a turn: the dice it
 * shows a player before the move are the dice the move then proves and the chain records.
 * Pinned for all three indices, because the bug this guards against (the browser deriving a
 * reroll from index 0) was invisible on roll 1 and wrong on rolls 2 and 3.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TableSimulator, diceToArray, userAddress, ZERO_BYTES32 } from './simulator.ts';
import * as vrf from '../vrf.ts';
import { revealFor } from '../reveal.ts';
import { pureCircuits } from '../managed/table/contract/index.js';

const SECRET = 0x7ea1n * 1_000_003n + 3n;
const bytes32 = (fill: number): Uint8Array => new Uint8Array(32).fill(fill);
const config = () => ({
  tableId: bytes32(0x21),
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

describe('revealFor agrees with the contract on every roll', () => {
  it('shows, before each move, exactly the dice the move then puts on chain', async () => {
    const sim = await TableSimulator.create(config());
    const skA = bytes32(0xa7);
    sim.asPlayer(skA);
    await sim.join(userAddress(0x01), 1_000);
    sim.asPlayer(bytes32(0xb8));
    await sim.join(userAddress(0x02), 1_010);

    const seat = 0;
    const seen = (): number[] | null => {
      const led = sim.getLedger();
      const turn = led.seatTurn.lookup(BigInt(seat));
      const cell = led.vrfAnswer.lookup(vrf.answerKey(seat, vrf.askedIndex(turn.stage)));
      // The simulator blinds with its own counter, not the derived rho -- pass it.
      const r = revealFor({
        tableId: config().tableId,
        seatSecret: skA,
        turn,
        cell,
        rho: sim.blindings.get(seat),
      });
      return r === null ? null : r.dice;
    };

    sim.asPlayer(skA);
    const round = sim.getLedger().openRound;
    await sim.openTurn(seat, pureCircuits.forcedEntropy(skA, config().tableId, round));
    assert.equal(seen(), null, 'asked but unanswered: nothing to see yet');

    // Roll 1: shown before the hold, proven by the hold.
    sim.asOperator();
    await sim.resolveRoll(seat);
    const shown1 = seen();
    assert.ok(shown1, 'answered: the dice are visible to the seat');
    sim.asPlayer(skA);
    await sim.hold(seat, [true, false, true, false, false]);
    assert.deepEqual(diceToArray(sim.getLedger().seatTurn.lookup(BigInt(seat)).roll), shown1);

    // Roll 2: a REROLL -- the index the derivation must not get wrong.
    sim.asOperator();
    await sim.resolveRoll(seat);
    const shown2 = seen();
    assert.ok(shown2);
    sim.asPlayer(skA);
    await sim.hold(seat, [true, true, true, false, false]);
    assert.deepEqual(diceToArray(sim.getLedger().seatTurn.lookup(BigInt(seat)).roll), shown2);
    for (const d of [0, 2]) assert.equal(shown2[d], shown1![d], `held die ${d} moved`);

    // Roll 3: shown before the score, recorded by the score.
    sim.asOperator();
    await sim.resolveRoll(seat);
    const shown3 = seen();
    assert.ok(shown3);
    sim.asPlayer(skA);
    await sim.score(seat, 12);
    assert.deepEqual(diceToArray(sim.getLedger().seatProgress.lookup(BigInt(seat)).dice), shown3);
    for (const d of [0, 1, 2]) assert.equal(shown3[d], shown2![d], `held die ${d} moved`);
  });

  it('refuses to show dice for an answer to a different query or round', async () => {
    const sim = await TableSimulator.create(config());
    const skA = bytes32(0xa7);
    sim.asPlayer(skA);
    await sim.join(userAddress(0x01), 1_000);
    sim.asPlayer(bytes32(0xb8));
    await sim.join(userAddress(0x02), 1_010);
    sim.asPlayer(skA);
    const round = sim.getLedger().openRound;
    await sim.openTurn(0, pureCircuits.forcedEntropy(skA, config().tableId, round));
    const turn = sim.getLedger().seatTurn.lookup(0n);
    sim.asOperator();
    await sim.resolveRollRaw(0, 0, 9n, turn.blinded); // right query, wrong round
    const cell = sim.getLedger().vrfAnswer.lookup(vrf.answerKey(0, 0));
    assert.equal(
      revealFor({
        tableId: config().tableId,
        seatSecret: skA,
        turn,
        cell,
        rho: sim.blindings.get(0),
      }),
      null,
    );
  });
});
