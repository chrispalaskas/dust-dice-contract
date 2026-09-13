// Copyright (C) Shielded Technologies
// SPDX-License-Identifier: Apache-2.0

/**
 * What the table page offers a player whose money is stuck.
 *
 * Every state here is built by playing the real contract, so the advice is checked against what
 * the circuits actually accept: after each step the test SUBMITS the call `nextRescueStep`
 * proposed and asserts it goes through. Advice that reads well and is refused on chain is worse
 * than none — the player pays a fee to be told no.
 *
 * The case that prompted this: a two-seat fast table where one seat resigned and the other
 * simply stopped. Hours later it still held both stakes, because no seat had been eliminated,
 * so the table never reached a terminal phase, so nobody could redeem.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { nextRescueStep } from '../rescue.ts';
import { GameDriver, PHASE, alwaysStopEarly, penaltySplit } from './table-harness.ts';

/** Open a table and seat everyone, the way table.test.ts does. */
const seated = async (seats: number, fastMode = true): Promise<GameDriver> => {
  const g = await GameDriver.open({ seats, fastMode }, { holds: alwaysStopEarly });
  await g.joinAll();
  return g;
};

/** Chain time just past the open round's deadline. */
const pastDeadline = (g: GameDriver): bigint => g.ledger().roundDeadline + 1n;

describe('rescuing a stuck table: what to offer, and does the chain accept it', () => {
  it('offers nothing while the deadline still stands', async () => {
    const g = await seated(2);
    const step = nextRescueStep(g.ledger(), g.ledger().roundDeadline);
    assert.equal(step.kind, 'none', step.why);
  });

  it('a seat that stopped playing: eliminate it, and the contract agrees', async () => {
    const g = await seated(2);
    const led = g.ledger();
    assert.equal(Number(led.phase), PHASE.playing);

    const step = nextRescueStep(led, pastDeadline(g));
    assert.equal(step.kind, 'eliminate');
    assert.equal(step.kind === 'eliminate' && step.seat, 0, 'the first seat still owing a move');

    // Exactly what the panel would submit — including the penalty split it computes.
    const { q, rem } = penaltySplit(g.config.tier, Number(led.openRound));
    g.sim.asOperator();
    await g.sim.eliminate(0, q, rem, Number(pastDeadline(g)));
    assert.equal(g.ledger().seatProgress.lookup(0n).eliminated, true);
  });

  it('walks a two-seat table all the way to redeemable, one accepted call at a time', async () => {
    const g = await seated(2);
    const tier = g.config.tier;

    // Both seats stop. Each step is taken only because nextRescueStep proposed it.
    for (let seat = 0; seat < 2; seat++) {
      const step = nextRescueStep(g.ledger(), pastDeadline(g));
      assert.equal(step.kind, 'eliminate', `step ${seat}: ${step.why}`);
      assert.equal(step.kind === 'eliminate' && step.seat, seat);
      const { q, rem } = penaltySplit(tier, Number(g.ledger().openRound));
      g.sim.asOperator();
      await g.sim.eliminate(seat, q, rem, Number(pastDeadline(g)));
    }

    // Every seat out: a PENDING terminal state. The stakes are still in the contract.
    assert.equal(Number(g.ledger().phase), PHASE.abandoned);
    const abort = nextRescueStep(g.ledger(), pastDeadline(g));
    assert.equal(abort.kind, 'abort', abort.why);
    assert.match(abort.why, /waives every elimination penalty/);

    const rake = { q: tier / 100n, rem: tier % 100n };
    await g.sim.abortTable(rake.q, rake.rem, Number(pastDeadline(g)));
    assert.equal(Number(g.ledger().phase), PHASE.aborted);

    // And now the thing the player wanted all along: the penalties are waived, so each seat is
    // owed its stake less only the 1% rake.
    for (let seat = 0; seat < 2; seat++) {
      assert.equal(g.ledger().seatRedeemable.lookup(BigInt(seat)), tier - rake.q);
    }
    const done = nextRescueStep(g.ledger(), pastDeadline(g));
    assert.equal(done.kind, 'none');
    assert.match(done.why, /finished/);
  });

  it('a table that never filled: abort refunds in full', async () => {
    const g = await GameDriver.open({ seats: 2, fastMode: true }, { holds: alwaysStopEarly });
    await g.join(0);
    const led = g.ledger();
    assert.equal(Number(led.phase), PHASE.filling);

    assert.equal(nextRescueStep(led, led.roundDeadline).kind, 'none', 'not yet');
    const step = nextRescueStep(led, led.roundDeadline + 1n);
    assert.equal(step.kind, 'abort');
    assert.match(step.why, /never filled/);

    const tier = g.config.tier;
    await g.sim.abortTable(tier / 100n, tier % 100n, Number(led.roundDeadline) + 1);
    assert.equal(Number(g.ledger().phase), PHASE.aborted);
    assert.equal(g.ledger().seatRedeemable.lookup(0n), tier, 'no game, no rake, full refund');
  });
});
