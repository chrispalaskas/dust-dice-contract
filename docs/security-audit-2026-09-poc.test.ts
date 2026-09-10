// Security-audit proof-of-concept tests for table.compact.
// Run from the repo root (needs contract/src/managed compiled, e.g. npm run compact:fast -w contract):
//   node --experimental-transform-types --disable-warning=ExperimentalWarning --test docs/security-audit-2026-09-poc.test.ts
// Each PoC drives the compiled contract through the repo's own TableSimulator / GameDriver.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { TableSimulator, userAddress, diceToArray } from '../contract/src/test/simulator.ts';
import {
  GameDriver,
  alwaysStopEarly,
  bytes32,
  penaltySplit,
  perSeatRake,
  PHASE,
  STAGE,
  tableConfig,
  type GamePlan,
  type TableOptions,
} from '../contract/src/test/table-harness.ts';

async function seated(opts: TableOptions, plan: GamePlan = {}): Promise<GameDriver> {
  const g = await GameDriver.open(opts, plan);
  await g.joinAll();
  return g;
}

/** Block time one second past the operator-stall abort deadline of the open round. */
function pastAbortDeadline(g: GameDriver): number {
  const led = g.ledger();
  return Number(led.roundDeadline + g.config.tableTimeoutSecs) + 1;
}

// =========================================================================================
describe('FINDING A: a delinquent player manufactures an "operator stall" and aborts into a full refund', () => {
  // The docs call the waiting-on-the-operator condition of abortTable load-bearing: "Without it,
  // a player who is losing could simply stop playing, let the round deadline and the table
  // grace both pass, and abort the game into a full refund." But the PLAYER controls the
  // transition to an odd (operator-owed) stage, and playerMove has no deadline check, so once
  // the abort window is open the player flips their own seat odd and aborts in the same breath.
  // Precondition: nobody used the permissionless `eliminate` during the tableTimeoutSecs window.

  it('on-chain table, from stage 0: open a turn after the grace, then abortTable, both in one go', async () => {
    const g = await seated({ seats: 2 }, { holds: alwaysStopEarly });
    // Seat 1 plays honestly. Seat 0 (trailing / hostile) never opens its turn.
    await g.playTurn(1, 0);
    const tier = g.config.tier;
    const { q, rem } = perSeatRake(tier);
    const T = pastAbortDeadline(g);

    // With every seat idle the guard holds: the table cannot be aborted...
    await assert.rejects(() => g.sim.abortTable(q, rem, T), /neither stalled/);
    // ...and seat 0 has been eliminable since roundDeadline + 1 (the remedy nobody applied).
    assert.ok(T > Number(g.ledger().roundDeadline) + 1);

    // The attacker's first call: open the turn. No time check in playerMove -> accepted.
    g.sim.asPlayer(g.players[0]!.sk);
    assert.equal(await g.sim.openTurn(0, g.entropyFor(0, 0), T), BigInt(STAGE.awaitRoll1));
    // The attacker's second call, same block time (composable into the same transaction):
    const share = await g.sim.abortTable(q, rem, T);

    const led = g.ledger();
    assert.equal(led.phase, PHASE.aborted, 'the table is aborted');
    assert.equal(share, tier, 'every seat is refunded in full -- no penalty for seat 0');
    assert.equal(led.seatRedeemable.lookup(0n), tier);
    assert.equal(led.seatRedeemable.lookup(1n), tier);
    assert.equal(led.pot, 0n);
    // No rake, no penalty: the operator-stalled path pays nobody but the players.
    g.sim.asOperator();
    assert.equal(await g.sim.redeem(0, T), tier, 'the delinquent seat withdraws its whole stake');
    console.log(
      `    [A1] seat 0 skipped round 0, aborted at T=${T}, redeemed ${tier} (full stake)`,
    );
  });

  it('on-chain table, from stage 2: hold after the grace, then abortTable', async () => {
    const g = await seated({ seats: 2 }, { holds: alwaysStopEarly });
    await g.playTurn(1, 0);
    // Seat 0 opens and gets roll 1 while the round is live, then goes silent at stage 2.
    g.sim.asPlayer(g.players[0]!.sk);
    await g.sim.openTurn(0, g.entropyFor(0, 0), g.tick());
    g.sim.asOperator();
    await g.sim.resolveRoll1(0, g.tick());
    assert.equal(g.ledger().seatTurn.lookup(0n).stage, BigInt(STAGE.rolled1));

    const tier = g.config.tier;
    const { q, rem } = perSeatRake(tier);
    const T = pastAbortDeadline(g);
    await assert.rejects(() => g.sim.abortTable(q, rem, T), /neither stalled/);

    g.sim.asPlayer(g.players[0]!.sk);
    assert.equal(
      await g.sim.hold(0, [true, true, false, false, false], T),
      BigInt(STAGE.awaitRoll2),
    );
    const share = await g.sim.abortTable(q, rem, T);
    assert.equal(share, tier);
    assert.equal(g.ledger().phase, PHASE.aborted);
    console.log(`    [A2] seat 0 flipped stage 2 -> 3 at T and aborted; refund ${share}`);
  });

  it('FAST table, from stage 0: identical, and the operator cannot resolve on chain by policy', async () => {
    const g = await seated({ seats: 2, fastMode: true }, { holds: alwaysStopEarly });
    await g.playTurn(1, 0);
    const tier = g.config.tier;
    const { q, rem } = perSeatRake(tier);
    const T = pastAbortDeadline(g);
    await assert.rejects(() => g.sim.abortTable(q, rem, T), /neither stalled/);
    g.sim.asPlayer(g.players[0]!.sk);
    await g.sim.openTurn(0, g.entropyFor(0, 0), T);
    assert.equal(await g.sim.abortTable(q, rem, T), tier);
    assert.equal(g.ledger().phase, PHASE.aborted);
    console.log(`    [A3] fast table: same result, refund ${tier}`);
  });

  it('what the leader lost: compare against the elimination the contract intended', async () => {
    const g = await seated({ seats: 2 }, { holds: alwaysStopEarly });
    await g.playTurn(1, 0);
    const tier = g.config.tier;
    const led = g.ledger();
    // Honest path: seat 0 is eliminated at round 0 (penalty tier/13 stays in the pot), then seat 1
    // wins the walkover: pot = 2*tier - (tier - tier/13) = tier + tier/13, minus 1% rake.
    const p = penaltySplit(tier, 0);
    const honestPot = tier * 2n - (tier - p.q);
    const honestWinner = honestPot - honestPot / 100n;
    // Attack path: everyone gets exactly tier back, seat 1 wins nothing.
    console.log(
      `    [A4] leader's honest payout ${honestWinner} vs ${tier} after the manufactured abort ` +
        `(delta ${honestWinner - tier}); roundDeadline ${led.roundDeadline}`,
    );
    assert.ok(honestWinner > tier);
  });
});

// =========================================================================================
describe('FINDING B: the resignation discount turns the last round into a free option for the loser', () => {
  // A resignation is charged `tier * openRound / 13`. In round 12 -- after every score is on
  // chain and the outcome is public -- the loser resigns for 12/13 and takes tier/13 back out
  // of the pot the winner would otherwise receive. Scoring and losing pays 0; resigning pays
  // tier/13. Every rational loser does it, in every game.

  it('loser resigns after all final scores are in and recovers ~7.7% of its stake from the winner', async () => {
    const g = await seated({ seats: 2 }, { holds: alwaysStopEarly });
    for (let r = 0; r <= 11; r++) await g.playRound(r);
    await g.playTurn(0, 12);
    await g.playTurn(1, 12);
    // The game is decided: both cards are complete and public. closeRound has not run.
    const totals = g.totals();
    const winner = g.expectedWinner();
    const loser = winner === 0 ? 1 : 0;
    const tier = g.config.tier;
    const potBefore = g.ledger().pot;
    assert.equal(potBefore, tier * 2n);
    const honestWinnerPayout = potBefore - potBefore / 100n;

    // The loser resigns at the 12/13 rate (openRound is still 12 until closeRound).
    const q = (tier * 12n) / 13n;
    const rem = tier * 12n - q * 13n;
    g.sim.asPlayer(g.players[loser]!.sk);
    const refund = await g.sim.resign(loser, q, rem, g.tick());
    assert.equal(refund, tier - q);
    assert.ok(refund > 0n, 'a completed, lost game still refunds tier/13 through resignation');

    // Walkover: settle now pays the winner a smaller pot.
    const [sq, sr] = g.rakeSplit();
    g.sim.asOperator();
    assert.equal(await g.sim.settle(g.config.seed, sq, sr, g.tick()), BigInt(winner));
    const pot = potBefore - refund;
    const winnerPayout = pot - sq;
    assert.ok(winnerPayout < honestWinnerPayout);
    assert.equal(await g.sim.redeem(loser, g.tick()), refund);
    console.log(
      `    [B1] totals ${totals.join('/')}, loser seat ${loser} scored a complete card and lost; ` +
        `resigned for penalty ${q}, got ${refund} back; winner paid ${winnerPayout} instead of ${honestWinnerPayout}`,
    );
  });

  it('the same free look exists in every round: play round 0, see the result, leave for nothing', async () => {
    const g = await seated({ seats: 2 }, { holds: alwaysStopEarly });
    await g.playTurn(0, 0); // seat 0 sees its whole round-0 outcome
    await g.playTurn(1, 0); // and seat 1's
    const tier = g.config.tier;
    g.sim.asPlayer(g.players[0]!.sk);
    const refund = await g.sim.resign(0, 0n, 0n, g.tick()); // charged tier * 0 / 13
    assert.equal(refund, tier, 'full refund after playing the whole round');
    const [sq, sr] = g.rakeSplit();
    g.sim.asOperator();
    await g.sim.settle(g.config.seed, sq, sr, g.tick());
    // The opponent "wins" its own stake minus the rake: it is 1% poorer for having shown up.
    const opponent = g.ledger().pot === 0n ? tier - sq : -1n;
    console.log(
      `    [B2] seat 0 left for free after round 0; seat 1 received ${opponent} of its ${tier}`,
    );
    assert.ok(opponent < tier);
  });
});

// =========================================================================================
describe('FINDING C: six free join/leave cycles permanently burn every slot of a filling table', () => {
  // Slots are positional and a pre-start leaver keeps its slot. Leaving a filling table is free
  // (charged tier*0/13) and paid at once. So an attacker with six fresh secrets consumes all six
  // slots of ANY filling table for the price of twelve transactions, and the table can never
  // start: `join` refuses with "no free slot" although activeSeats is 0.

  it('kills a public 2-seat table for fee cost only', async () => {
    const config = tableConfig({ seats: 2 });
    const sim = await TableSimulator.create(config);
    let clock = 1_700_000_000;
    for (let i = 0; i < 6; i++) {
      const sk = bytes32(0xa0 + i);
      sim.asPlayer(sk);
      clock += 10;
      const seat = await sim.join(userAddress(0x90 + i), clock);
      assert.equal(seat, BigInt(i));
      clock += 10;
      assert.equal(await sim.resign(i, 0n, 0n, clock), config.tier, 'free exit');
      // The stake is back in the attacker's hands immediately, in the filling phase.
      assert.equal(await sim.redeem(i, clock), config.tier);
    }
    const led = sim.getLedger();
    assert.equal(led.seatCount, 6n);
    assert.equal(led.activeSeats, 0n);
    assert.equal(led.phase, PHASE.filling);
    assert.equal(led.pot, 0n);

    // An honest player can never sit down again.
    sim.asPlayer(bytes32(0x01));
    await assert.rejects(() => sim.join(userAddress(0x02), clock + 10), /no free slot/);
    console.log('    [C1] 6 join+leave cycles: seatCount 6, activeSeats 0, honest join refused');
  });
});

// =========================================================================================
describe('CHECKS THAT HELD (negative results worth recording)', () => {
  it("a hold/score/resign for a seat needs that seat's secret; the payout address is fixed at join", async () => {
    const g = await seated({ seats: 2 }, { holds: alwaysStopEarly });
    g.sim.asPlayer(g.players[1]!.sk);
    await assert.rejects(
      () => g.sim.openTurn(0, g.entropyFor(0, 0), g.tick()),
      /wrong entropy secret/,
    );
    await assert.rejects(() => g.sim.resign(0, 0n, 0n, g.tick()), /own entropy secret/);
    // redeem is permissionless but pays only the recorded address; the caller's identity is
    // irrelevant to where the money goes.
    const who = g.ledger().seatIdentity.lookup(0n).addr.bytes;
    assert.deepEqual(who, g.players[0]!.addr.bytes);
  });

  it('resolveReroll cannot be reached with a stale round (stage 3/5 always carries the open round)', async () => {
    const g = await seated({ seats: 2 }, { holds: alwaysStopEarly });
    g.sim.asPlayer(g.players[0]!.sk);
    await g.sim.openTurn(0, g.entropyFor(0, 0), g.tick());
    g.sim.asOperator();
    await g.sim.resolveRoll1(0, g.tick());
    g.sim.asPlayer(g.players[0]!.sk);
    await g.sim.hold(0, [false, false, false, false, false], g.tick());
    // closeRound refuses while seat 0 is mid-turn, so the round cannot move under a pending
    // reroll.
    await g.playTurn(1, 0);
    await assert.rejects(() => g.sim.closeRound(g.tick()), /not every seat has finished/);
  });

  it('eliminate cannot fire after the final closeRound, so a finished game cannot be pillaged', async () => {
    const g = await seated({ seats: 2 }, { holds: alwaysStopEarly });
    await g.playToEnd();
    assert.equal(g.ledger().openRound, 13n);
    const p = penaltySplit(g.config.tier, 12);
    const late = Number(g.ledger().roundDeadline) + 1;
    await assert.rejects(() => g.sim.eliminate(0, p.q, p.rem, late), /the game is over/);
    g.sim.asPlayer(g.players[0]!.sk);
    await assert.rejects(() => g.sim.resign(0, p.q, p.rem, late), /the game is over/);
  });

  it('the dice a seat scores are the ledger roll, never an argument', async () => {
    const g = await seated({ seats: 2 }, { holds: alwaysStopEarly });
    g.sim.asPlayer(g.players[0]!.sk);
    await g.sim.openTurn(0, g.entropyFor(0, 0), g.tick());
    g.sim.asOperator();
    const rolled = diceToArray(await g.sim.resolveRoll1(0, g.tick()));
    g.sim.asPlayer(g.players[0]!.sk);
    await g.sim.score(0, 12, g.tick()); // Chance
    const card = g.ledger().seatCard.lookup(0n);
    assert.equal(card.scores[12], BigInt(rolled.reduce((a, b) => a + b, 0)));
  });
});
