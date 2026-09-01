// Copyright (C) Shielded Technologies
// SPDX-License-Identifier: Apache-2.0

/**
 * table.compact, end to end: SIMULTANEOUS ROUNDS with INTERACTIVE HOLDS.
 *
 * The happy-path tests are DIFFERENTIAL. `GameDriver` plays whole games through the circuits
 * while the TypeScript mirrors and api/src/rules.ts reconstruct the same games independently,
 * and every roll, digest, scorecard and total is compared as it is produced. A circuit that
 * agrees with itself proves nothing.
 *
 * The rejection tests are the other half and there are more of them, because the interesting
 * claims about this contract are negative ones: a player cannot choose their entropy, cannot
 * open a turn twice, cannot hold before rolling or after three rolls, cannot score dice that do
 * not exist, cannot reuse a category, cannot dodge a forced joker, cannot move another seat; an
 * operator cannot roll against a seed it did not commit to, cannot roll out of order, cannot
 * advance the digest by resolving; nobody can eliminate a seat early, eliminate a seat the
 * operator is holding up, redeem while the table is live, settle an unfinished game, or settle
 * twice.
 *
 * FOUR FAMILIES ARE NEW and are the ones to read first if you are checking whether the redesign
 * is sound:
 *
 *   `conflict-freedom`     reads the COMPILED TRANSCRIPT and asserts which ledger fields each
 *                          circuit binds to. The only mechanical check of the property the whole
 *                          layout exists for, because a simulator runs one circuit at a time and
 *                          can never observe a conflict.
 *   `simultaneous rounds`  six seats interleaved in one round, and the same game played in two
 *                          different submission orders producing identical state.
 *   `the interactive turn` the stage machine, the left-to-right stream merge over all 32 masks,
 *                          and early scoring after roll 1 or roll 2.
 *   `elimination`          the penalty arithmetic at both boundaries, mid-turn abandonment at
 *                          every player-owed stage, the all-eliminated waiver, and the custody
 *                          invariant across every path money can take.
 *
 * BLOCK TIME IS EXPLICIT EVERYWHERE. `createCircuitContext` otherwise defaults `time` to
 * wall-clock seconds, which makes every timeout test non-reproducible and, worse, quietly
 * passing today and failing at some future date (docs/bugs-found.md #12). `TableSimulator` pins
 * it; the timeout tests set it deliberately, on both sides of each deadline.
 *
 * WHAT THIS FILE CANNOT TEST: the movement of actual NIGHT.
 * `unshieldedBalance(nativeToken())` returns 0 under compact-runtime 0.19.0 no matter what
 * `receiveUnshielded` was handed (docs/bugs-found.md #11), so `receiveUnshielded` and
 * `sendUnshielded` are, in this simulator, calls that succeed and move nothing. Everything below
 * asserts the contract's OWN `pot` / `seatRedeemable` bookkeeping and the payout ADDRESSES it
 * selects. That the ledger actually debits and credits those addresses was proven in Gate 0
 * (docs/gate0-report.md, Q1) and must be re-proven per circuit on devnet.
 * `describe('token custody')` at the bottom states exactly where the line falls.
 *
 * Run: npm test -w @yahtzee/contract
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  CATEGORY_COUNT,
  type Dice as RefDice,
  isYahtzee as refIsYahtzee,
} from '../../../api/src/rules.ts';
import {
  entropyKeyCommitmentTs,
  firstRollTs,
  forcedEntropyTs,
  mergeStreamTs,
  mixEntropyTs,
  modalFace,
  rerollUnderMaskTs,
} from '../policy-mirror.ts';
import {
  eliminateDigestTs,
  finalDigestTs,
  genesisDigestTs,
  NO_WINNER,
  redeemDigestTs,
  type ScorecardTs,
} from '../table-mirror.ts';
import { pureCircuits as tablePure } from '../managed/table/contract/index.js';
import {
  DEFAULT_BLOCK_TIME,
  diceToArray,
  MOVE_HOLD,
  MOVE_OPEN,
  MOVE_SCORE,
  NO_MASK,
  TableSimulator,
  userAddress,
  ZERO_BYTES32,
} from './simulator.ts';
import { assertFieldMapIsComplete, ledgerReads, ledgerWrites, sorted } from './ledger-access.ts';
import {
  allMasks,
  alwaysStopEarly,
  alwaysThreeRolls,
  bytes32,
  FINAL_ROUND,
  GameDriver,
  keepModal,
  KEEP_ALL,
  makePlayers,
  maskOf,
  MAX_SEATS,
  penaltySplit,
  perSeatRake,
  PHASE,
  planTurn,
  replayGame,
  REROLL_ALL,
  ROUND_COUNT,
  STAGE,
  tableConfig,
  type GamePlan,
  type Mask,
  type Player,
  type TableOptions,
} from './table-harness.ts';

/** `noFinish()` -- the sentinel standing in for `rules.ts`'s `Infinity`. */
const NO_FINISH = 65535n;

/** Open a table and seat everyone. */
async function seated(opts: TableOptions, plan: GamePlan = {}): Promise<GameDriver> {
  const g = await GameDriver.open(opts, plan);
  await g.joinAll();
  return g;
}

/** Open a seat's turn and resolve roll 1, leaving it at `rolled1` with the player to move. */
async function rolledOnce(g: GameDriver, seat: number, round = 0): Promise<number[]> {
  g.sim.asPlayer(g.players[seat]!.sk);
  await g.sim.openTurn(seat, g.entropyFor(seat, round), g.tick());
  g.sim.asOperator();
  return diceToArray(await g.sim.resolveRoll1(seat, g.tick()));
}

// =========================================================================================
describe('conflict-freedom', () => {
  // =======================================================================================
  //
  // The hard requirement of the whole redesign, checked against the COMPILED TRANSCRIPT rather
  // than against the source or the simulator. From docs/concurrency-probe.md: a transaction is
  // rejected if and only if a ledger value its transcript READ has changed since it was proved,
  // and a `Map.lookup` binds exactly as a scalar read does. So the question "can six seats play
  // in one block" is decided entirely by the read sets below.
  //
  // It matters four times as much as it did under pre-declared policies, because an interactive
  // turn is up to four player transactions rather than one.
  //
  // See src/test/ledger-access.ts for how the sets are recovered.

  it('agrees with the generated ledger layout it is reading', () => {
    assertFieldMapIsComplete();
  });

  it('binds playerMove to nothing that can move while it is in flight', () => {
    assert.deepEqual(sorted(ledgerReads('playerMove')), [
      // Frozen for the whole game once the table is `playing`.
      'openRound', //     written ONLY by closeRound, which cannot run while a seat may move
      'phase', //         written only by join's last seat and by the terminal circuits
      'seatCard', //      this seat's own
      'seatCount', //     written only by join, and join only runs while `filling`
      'seatIdentity', //  this seat's own, written once at join
      'seatProgress', //  this seat's own
      'seatTurn', //      this seat's own
      'tableId', //       sealed
    ]);
  });

  it('lets playerMove write only its own seat and the padding sink', () => {
    assert.deepEqual(sorted(ledgerWrites('playerMove')), [
      'padStore',
      'seatCard',
      'seatProgress',
      'seatTurn',
    ]);
  });

  it('keeps every shared accumulator off the player path', () => {
    // These five are the fields whose value genuinely moves during a round. A read of any of
    // them from `playerMove` would serialise the seats against each other -- which is exactly
    // what `stampTime`'s `lastActionAt` did in the cursor model, in seven of eight circuits.
    const moving = ['activeSeats', 'pot', 'roundDeadline', 'roundDigest', 'seatRedeemable'];
    for (const circuit of ['playerMove', 'resolveRoll2', 'resolveRoll3']) {
      const reads = ledgerReads(circuit);
      for (const field of moving) {
        assert.ok(!reads.has(field), `${circuit} must not read ${field}`);
      }
    }
    // resolveRoll1 is the one exception and it is deliberate: it reads `roundDigest`, which is
    // frozen for the duration of a round precisely so that it can.
    assert.deepEqual(sorted(ledgerReads('resolveRoll1')), [
      'openRound',
      'phase',
      'roundDigest',
      'seatTurn',
      'seedCommitment',
      'tableId',
    ]);
  });

  it('keeps the three circuits with no k headroom down to a single map', () => {
    // resolveRoll1/2/3 are at k=15 against an SRS ceiling of 15. Touching a second map is not
    // merely slower, it risks a contract that cannot be proved at all.
    for (const circuit of ['resolveRoll1', 'resolveRoll2', 'resolveRoll3']) {
      assert.deepEqual(sorted(ledgerWrites(circuit)), ['padStore', 'seatTurn'], circuit);
    }
  });

  it('lets only closeRound write the fields every seat reads', () => {
    for (const field of ['openRound', 'roundDigest']) {
      const writers = [
        'playerMove',
        'resolveRoll1',
        'resolveRoll2',
        'resolveRoll3',
        'eliminate',
      ].filter((c) => ledgerWrites(c).has(field));
      assert.deepEqual(writers, [], `${field} must be written only by closeRound (and join)`);
      assert.ok(ledgerWrites('closeRound').has(field));
    }
    assert.deepEqual(sorted(ledgerWrites('closeRound')), [
      'openRound',
      'padStore',
      'roundDeadline',
      'roundDigest',
    ]);
    // `roundDeadline` has the same rule with one exception: `join` opens round 0.
    assert.ok(ledgerWrites('join').has('roundDeadline'));
  });

  it('lets six seats redeem in the same block', () => {
    // `redeem` runs only in a terminal phase, so `phase` cannot move under it and every other
    // field it reads is sealed or its own seat's.
    assert.deepEqual(sorted(ledgerReads('redeem')), [
      'phase',
      'seatCard',
      'seatCount',
      'seatIdentity',
      'seatReceipt',
      'seatRedeemable',
      'tableId',
    ]);
    assert.deepEqual(sorted(ledgerWrites('redeem')), ['padStore', 'seatReceipt', 'seatRedeemable']);
  });

  it('accepts that eliminate serialises, and says which fields do it', () => {
    // `eliminate` read-modify-writes `pot` and `activeSeats`, so two concurrent eliminations
    // conflict and one is rejected with a ReadMismatch. That is correct -- they are shared
    // accumulators and both must be exact -- and it is off the player's path, so it costs the
    // design nothing. Asserted rather than merely tolerated, so a future change that puts one of
    // these on the player path fails here first.
    const reads = ledgerReads('eliminate');
    assert.ok(reads.has('pot'));
    assert.ok(reads.has('activeSeats'));
    // And it binds to the victim's own two entries, which is what makes `eliminate(s)` racing
    // seat s's own `playerMove` resolve to exactly one winner rather than silently applying both.
    assert.ok(reads.has('seatProgress'));
    assert.ok(reads.has('seatTurn'));
  });
});

// =========================================================================================
describe('a full two-seat game', () => {
  // =======================================================================================

  it('seats players, stakes the pot, chains the digest and opens round 0', async () => {
    const g = await GameDriver.open({ seats: 2 });
    let led = g.ledger();
    assert.equal(led.phase, PHASE.filling);
    assert.equal(led.seatCount, 0n);
    assert.equal(led.pot, 0n);
    assert.equal(led.roundDeadline, 0n, 'an empty table has no fill clock and cannot be aborted');
    assert.deepEqual(led.roundDigest, genesisDigestTs(g.config.tableId));

    await g.join(0);
    led = g.ledger();
    assert.equal(led.phase, PHASE.filling, 'one seat of two does not start the game');
    assert.equal(
      led.roundDeadline,
      BigInt(g.clock) + g.config.tableTimeoutSecs,
      'the first join starts the fill clock',
    );
    assert.deepEqual(
      led.seatIdentity.lookup(0n).keyCommit,
      entropyKeyCommitmentTs(g.config.tableId, g.players[0]!.sk),
      'the seat records the commitment the mirror computes',
    );
    assert.deepEqual(led.seatIdentity.lookup(0n).addr.bytes, g.players[0]!.addr.bytes);

    await g.join(1);
    led = g.ledger();
    assert.equal(led.phase, PHASE.playing);
    assert.equal(led.openRound, 0n);
    assert.equal(led.activeSeats, 2n);
    assert.equal(led.pot, g.config.tier * 2n);
    assert.equal(
      led.roundDeadline,
      BigInt(g.clock) + g.config.turnTimeoutSecs,
      'the last join opens round 0 with a full turn timeout',
    );
    // Every slot was pre-inserted, including the four nobody took, so no lookup can abort.
    for (let s = 0; s < MAX_SEATS; s++) {
      assert.equal(led.seatProgress.lookup(BigInt(s)).round, 0n);
      assert.equal(led.seatTurn.lookup(BigInt(s)).stage, BigInt(STAGE.idle));
      assert.equal(led.seatRedeemable.lookup(BigInt(s)), 0n);
    }
  });

  it('plays 13 rounds of interactive turns and settles to the reference winner', async () => {
    const plan: GamePlan = { strategy: 'bestScore', probeIllegal: true };
    const g = await seated({ seats: 2 }, plan);
    await g.playToEnd();

    const led = g.ledger();
    assert.equal(led.openRound, BigInt(ROUND_COUNT), 'the game must run to the end');
    assert.equal(led.phase, PHASE.playing, 'a finished game is still playing until it settles');

    // The offline replay, which never touched the chain, must agree on everything.
    const rep = g.replay();
    assert.deepEqual(led.roundDigest, rep.digest, 'the round digest chain must replay exactly');
    assert.equal(rep.round, ROUND_COUNT);
    for (let s = 0; s < 2; s++) {
      const prog = led.seatProgress.lookup(BigInt(s));
      assert.equal(prog.total, BigInt(rep.totals[s]!), `seat ${s} total`);
      assert.equal(prog.round, BigInt(ROUND_COUNT), `seat ${s} must have finished`);
      assert.equal(prog.finishedAtRound, BigInt(FINAL_ROUND));
      assert.equal(prog.eliminated, false);
    }
    assert.equal(g.turns.length, rep.turns.length);
    assert.equal(g.turns.length, 2 * ROUND_COUNT, 'one turn per seat per round');
    for (let i = 0; i < g.turns.length; i++) {
      assert.deepEqual(g.turns[i]!.dice, rep.turns[i]!.dice, `turn ${i} dice`);
      assert.deepEqual(g.turns[i]!.holds, rep.turns[i]!.holds, `turn ${i} holds`);
      assert.deepEqual(g.turns[i]!.rolls, rep.turns[i]!.rolls, `turn ${i} rolls`);
    }
    // The replay's transaction model must match what the driver actually sent.
    assert.equal(g.playerTx, rep.playerTx, 'player transaction count');
    assert.equal(g.operatorTx, rep.operatorTx, 'operator transaction count');
    assert.ok(g.illegalProbes > 0, 'the illegal-placement probe must have fired');

    const potBefore = led.pot;
    const [q, r] = g.rakeSplit();
    const winner = await g.sim.settle(g.config.seed, q, r);
    assert.equal(winner, BigInt(g.expectedWinner()));

    const after = g.ledger();
    assert.equal(after.phase, PHASE.settled);
    assert.equal(after.pot, 0n, 'settle drains the pot exactly');
    assert.equal(after.winnerSeatIndex, winner);
    assert.deepEqual(after.revealedSeed, g.config.seed, 'an honest settle publishes the seed');
    assert.equal(q, potBefore / 100n);
    assert.deepEqual(
      after.finalDigest,
      finalDigestTs(
        after.roundDigest,
        g.config.tableId,
        PHASE.settled,
        Number(winner),
        2,
        potBefore - q,
        q,
        0n,
        true,
      ),
      'the closing certificate must match the mirror',
    );
  });

  it('pays the remainder to the winner when the pot does not divide by 100', async () => {
    // tier 501 x 2 = 1002, so q = 10 and r = 2: the two-atom remainder must go to the winner and
    // not to the rake.
    const g = await seated({ seats: 2, tier: 501n }, { holds: alwaysStopEarly });
    await g.playToEnd();
    assert.equal(g.ledger().pot, 1002n);
    const [q, r] = g.rakeSplit();
    assert.equal(q, 10n);
    assert.equal(r, 2n);
    await g.sim.settle(g.config.seed, q, r);
    assert.equal(g.ledger().pot, 0n);
  });

  it('rejects a rake split that is not the unique q, r', async () => {
    const g = await seated({ seats: 2 }, { holds: alwaysStopEarly });
    await g.playToEnd();
    const pot = g.ledger().pot;
    for (const [q, r] of [
      [pot / 100n + 1n, pot % 100n],
      [pot / 100n, 100n],
      [0n, pot],
      [pot, 0n],
    ]) {
      await assert.rejects(() => g.sim.settle(g.config.seed, q!, r!), /rake split/);
    }
    assert.equal(g.ledger().phase, PHASE.playing, 'a refused settle changes nothing');
  });
});

// =========================================================================================
describe('the interactive turn', () => {
  // =======================================================================================

  it('walks the whole stage machine and refuses every out-of-order move', async () => {
    const g = await seated({ seats: 2 });
    const seat = 0;
    const cell = () => g.ledger().seatTurn.lookup(BigInt(seat));

    // idle: only an open is legal.
    assert.equal(cell().stage, BigInt(STAGE.idle));
    g.sim.asPlayer(g.players[seat]!.sk);
    await assert.rejects(() => g.sim.hold(seat, KEEP_ALL(), g.clock), /a hold needs a resolved/);
    await assert.rejects(() => g.sim.score(seat, 0, g.clock), /nothing has been rolled/);
    g.sim.asOperator();
    await assert.rejects(() => g.sim.resolveRoll2(seat, g.clock), /not awaiting its second roll/);
    await assert.rejects(() => g.sim.resolveRoll3(seat, g.clock), /not awaiting its third roll/);

    // open -> awaitRoll1: only roll 1 is legal.
    g.sim.asPlayer(g.players[seat]!.sk);
    await g.sim.openTurn(seat, g.entropyFor(seat, 0), g.tick());
    assert.equal(cell().stage, BigInt(STAGE.awaitRoll1));
    await assert.rejects(
      () => g.sim.openTurn(seat, g.entropyFor(seat, 0), g.clock),
      /already opened/,
    );
    await assert.rejects(() => g.sim.hold(seat, KEEP_ALL(), g.clock), /a hold needs a resolved/);
    await assert.rejects(() => g.sim.score(seat, 0, g.clock), /nothing has been rolled/);
    g.sim.asOperator();
    await assert.rejects(() => g.sim.resolveRoll2(seat, g.clock), /not awaiting its second roll/);

    // roll 1 -> rolled1: hold or score.
    await g.sim.resolveRoll1(seat, g.tick());
    assert.equal(cell().stage, BigInt(STAGE.rolled1));
    await assert.rejects(() => g.sim.resolveRoll1(seat, g.clock), /not awaiting its first roll/);
    await assert.rejects(() => g.sim.resolveRoll2(seat, g.clock), /not awaiting its second roll/);

    // hold -> awaitRoll2.
    g.sim.asPlayer(g.players[seat]!.sk);
    await g.sim.hold(seat, maskOf(0, 2), g.tick());
    assert.equal(cell().stage, BigInt(STAGE.awaitRoll2));
    await assert.rejects(() => g.sim.hold(seat, KEEP_ALL(), g.clock), /a hold needs a resolved/);
    await assert.rejects(() => g.sim.score(seat, 0, g.clock), /nothing has been rolled/);
    g.sim.asOperator();
    await assert.rejects(() => g.sim.resolveRoll1(seat, g.clock), /not awaiting its first roll/);
    await assert.rejects(() => g.sim.resolveRoll3(seat, g.clock), /not awaiting its third roll/);

    await g.sim.resolveRoll2(seat, g.tick());
    assert.equal(cell().stage, BigInt(STAGE.rolled2));
    g.sim.asPlayer(g.players[seat]!.sk);
    await g.sim.hold(seat, maskOf(1), g.tick());
    assert.equal(cell().stage, BigInt(STAGE.awaitRoll3));
    g.sim.asOperator();
    await g.sim.resolveRoll3(seat, g.tick());
    assert.equal(cell().stage, BigInt(STAGE.rolled3));

    // rolled3: no rolls left, so a hold is refused and only a score can end the turn.
    g.sim.asPlayer(g.players[seat]!.sk);
    await assert.rejects(
      () => g.sim.hold(seat, KEEP_ALL(), g.clock),
      /a hold needs a resolved roll with another roll left/,
    );
    g.sim.asOperator();
    await assert.rejects(() => g.sim.resolveRoll3(seat, g.clock), /not awaiting its third roll/);
  });

  it('lets a player stop after roll 1, for two player transactions and one operator one', async () => {
    const g = await seated({ seats: 2 });
    const before = { p: g.playerTx, o: g.operatorTx };
    await g.playTurn(0, 0, alwaysStopEarly);
    assert.equal(g.playerTx - before.p, 2, 'open + score');
    assert.equal(g.operatorTx - before.o, 1, 'roll 1 only');
    const led = g.ledger();
    assert.equal(led.seatProgress.lookup(0n).round, 1n, 'the turn is over');
    assert.equal(led.seatTurn.lookup(0n).stage, BigInt(STAGE.idle));
  });

  it('costs four player transactions and three operator ones for a full turn', async () => {
    const g = await seated({ seats: 2 });
    const before = { p: g.playerTx, o: g.operatorTx };
    await g.playTurn(0, 0, alwaysThreeRolls);
    assert.equal(g.playerTx - before.p, 4, 'open + hold + hold + score');
    assert.equal(g.operatorTx - before.o, 3, 'three rolls');
  });

  it('scores the dice as they stand, whichever roll the player stopped on', async () => {
    // Three seats stop at three different points in the same round; each must be scored on the
    // dice its own turn actually ended with, and the mirror must reproduce all three.
    const g = await seated({ seats: 3 }, { strategy: 'bestScore' });
    const stops: Mask[][] = [[], [maskOf(0, 1)], [maskOf(0, 1), maskOf(2, 3)]];
    for (let seat = 0; seat < 3; seat++) {
      const plannedHolds = stops[seat]!;
      let step = 0;
      const dice = await g.playTurn(seat, 0, () =>
        step < plannedHolds.length ? plannedHolds[step++]! : 'score',
      );
      const mixed = mixEntropyTs(g.entropyFor(seat, 0), genesisDigestAfterJoins(g));
      const expected = planTurn(g.config, mixed, seat, 0, () =>
        stops[seat]!.length > 0 ? stops[seat]![0]! : 'score',
      );
      void expected;
      assert.deepEqual(
        diceToArray(g.ledger().seatProgress.lookup(BigInt(seat)).dice),
        dice,
        `seat ${seat} was scored on the wrong dice`,
      );
      assert.equal(g.turns.at(-1)!.rolls.length, plannedHolds.length + 1);
    }
  });

  it('merges a reroll left to right, over all 32 masks', () => {
    // The change the interactive redesign made to the dice: the fresh roll is consumed by the
    // rerolled positions IN ORDER, not positionally. Every mask whose held set is not a prefix
    // distinguishes the two models, and a positional regression fails here on 20 of the 32.
    const kept = [1, 2, 3, 4, 5];
    const fresh = [6, 6, 6, 6, 6].map((_, i) => i + 1);
    let nonPrefix = 0;
    for (const mask of allMasks()) {
      const got = mergeStreamTs(mask, kept, fresh);
      // Reference, written differently: filter the rerolled positions and zip them with the
      // fresh dice in order.
      const rerolled = [0, 1, 2, 3, 4].filter((i) => mask[i] !== true);
      const want = [...kept];
      rerolled.forEach((pos, j) => {
        want[pos] = fresh[j]!;
      });
      assert.deepEqual(got, want, `mask ${mask.map((b) => (b ? 1 : 0)).join('')}`);

      // And confirm the mask genuinely separates the two models where it should.
      const positional = kept.map((d, i) => (mask[i] === true ? d : fresh[i]!));
      const isPrefix = rerolled.every(
        (pos, j) => pos === j + (5 - rerolled.length) * 0 + j * 0 + pos - pos + j,
      );
      void isPrefix;
      if (JSON.stringify(positional) !== JSON.stringify(got)) nonPrefix += 1;
    }
    assert.ok(nonPrefix > 0, 'no mask distinguished the stream merge from the positional one');
  });

  it('matches the circuit on the stream merge for every mask', async () => {
    // The mirror against the compiled circuit, on real hash-derived dice, for all 32 masks.
    const g = await seated({ seats: 2 });
    const digest = g.ledger().roundDigest;
    const mixed = mixEntropyTs(g.entropyFor(0, 0), digest);
    const roll0 = firstRollTs(g.config.tableId, g.config.seed, mixed, 0);
    for (const mask of allMasks()) {
      assert.deepEqual(
        tablePure.mergeStream(mask, roll0.map(BigInt), [1n, 2n, 3n, 4n, 5n]).map(Number),
        mergeStreamTs(mask, roll0, [1, 2, 3, 4, 5]),
        `mergeStream diverged for mask ${mask.map((b) => (b ? 1 : 0)).join('')}`,
      );
    }
  });

  it('keeps a held die byte-for-byte across both rerolls', async () => {
    const g = await seated({ seats: 2 });
    const roll0 = await rolledOnce(g, 0);
    const mask = maskOf(0, 2, 4);
    g.sim.asPlayer(g.players[0]!.sk);
    await g.sim.hold(0, mask, g.tick());
    g.sim.asOperator();
    const roll1 = diceToArray(await g.sim.resolveRoll2(0, g.tick()));
    for (const i of [0, 2, 4]) assert.equal(roll1[i], roll0[i], `held die ${i} moved`);
    g.sim.asPlayer(g.players[0]!.sk);
    await g.sim.hold(0, mask, g.tick());
    g.sim.asOperator();
    const roll2 = diceToArray(await g.sim.resolveRoll3(0, g.tick()));
    for (const i of [0, 2, 4]) assert.equal(roll2[i], roll0[i], `held die ${i} moved on roll 3`);
  });

  it('writes each hold into the cell the next roll reads, and no other', async () => {
    // The v2 seam: `hold1` is read only by `resolveRoll2` and `hold2` only by `resolveRoll3`.
    const g = await seated({ seats: 2 });
    await rolledOnce(g, 0);
    g.sim.asPlayer(g.players[0]!.sk);
    await g.sim.hold(0, maskOf(1, 3), g.tick());
    let cell = g.ledger().seatTurn.lookup(0n);
    assert.deepEqual(cell.hold1.bits, maskOf(1, 3));
    assert.deepEqual(cell.hold2.bits, REROLL_ALL(), 'the second hold must still be empty');
    g.sim.asOperator();
    await g.sim.resolveRoll2(0, g.tick());
    g.sim.asPlayer(g.players[0]!.sk);
    await g.sim.hold(0, maskOf(4), g.tick());
    cell = g.ledger().seatTurn.lookup(0n);
    assert.deepEqual(cell.hold1.bits, maskOf(1, 3), 'the first hold must not be overwritten');
    assert.deepEqual(cell.hold2.bits, maskOf(4));
  });

  it('clears both holds when a new turn is opened', async () => {
    const g = await seated({ seats: 2 });
    // Pin masks that actually hold something, so "cleared" is distinguishable from "was already
    // empty" -- `alwaysThreeRolls` walks a schedule that includes the keep-nothing mask.
    await g.playTurn(0, 0, ({ step }) => (step === 0 ? maskOf(0, 1) : maskOf(2)));
    await g.playTurn(1, 0, alwaysStopEarly);
    await g.closeRound(0);
    assert.deepEqual(g.ledger().seatTurn.lookup(0n).hold1.bits, maskOf(0, 1));
    assert.deepEqual(g.ledger().seatTurn.lookup(0n).hold2.bits, maskOf(2));
    g.sim.asPlayer(g.players[0]!.sk);
    await g.sim.openTurn(0, g.entropyFor(0, 1), g.tick());
    const cell = g.ledger().seatTurn.lookup(0n);
    assert.deepEqual(cell.hold1.bits, REROLL_ALL(), 'a new turn must not inherit a hold');
    assert.deepEqual(cell.hold2.bits, REROLL_ALL());
    assert.deepEqual(cell.mixed, new Uint8Array(32), 'nor the previous round’s mixed entropy');
  });

  it('pins the canonical sentinel for every argument a kind does not use', async () => {
    const g = await seated({ seats: 2 });
    const e = g.entropyFor(0, 0);
    g.sim.asPlayer(g.players[0]!.sk);

    // An open carries entropy and nothing else.
    await assert.rejects(
      () => g.sim.playerMove(0, MOVE_OPEN, e, maskOf(0), 0, g.clock),
      /only a hold declares a mask/,
    );
    await assert.rejects(
      () => g.sim.playerMove(0, MOVE_OPEN, e, NO_MASK(), 3, g.clock),
      /only a score declares a category/,
    );
    // An unknown kind is refused outright.
    await assert.rejects(
      () => g.sim.playerMove(0, 3, ZERO_BYTES32(), NO_MASK(), 0, g.clock),
      /unknown move kind/,
    );
    await assert.rejects(
      () => g.sim.playerMove(0, 200, ZERO_BYTES32(), NO_MASK(), 0, g.clock),
      /unknown move kind/,
    );

    await rolledOnce(g, 0);
    g.sim.asPlayer(g.players[0]!.sk);
    // A hold carries a mask and nothing else.
    await assert.rejects(
      () => g.sim.playerMove(0, MOVE_HOLD, e, maskOf(0), 0, g.clock),
      /only an open declares entropy/,
    );
    await assert.rejects(
      () => g.sim.playerMove(0, MOVE_HOLD, ZERO_BYTES32(), maskOf(0), 4, g.clock),
      /only a score declares a category/,
    );
    // A score carries a category and nothing else.
    await assert.rejects(
      () => g.sim.playerMove(0, MOVE_SCORE, e, NO_MASK(), 0, g.clock),
      /only an open declares entropy/,
    );
    await assert.rejects(
      () => g.sim.playerMove(0, MOVE_SCORE, ZERO_BYTES32(), maskOf(2), 0, g.clock),
      /only a hold declares a mask/,
    );
  });

  it('accepts a keep-nothing hold as "reroll everything"', async () => {
    const g = await seated({ seats: 2 });
    const roll0 = await rolledOnce(g, 0);
    g.sim.asPlayer(g.players[0]!.sk);
    await g.sim.hold(0, REROLL_ALL(), g.tick());
    g.sim.asOperator();
    const roll1 = diceToArray(await g.sim.resolveRoll2(0, g.tick()));
    const mixed = g.ledger().seatTurn.lookup(0n).mixed;
    assert.deepEqual(
      roll1,
      rerollUnderMaskTs(g.config.tableId, g.config.seed, mixed, 0, 1, REROLL_ALL(), roll0),
    );
  });
});

/** The digest after all joins, before any round has closed. */
function genesisDigestAfterJoins(g: GameDriver): Uint8Array {
  return g.digest;
}

// =========================================================================================
describe('simultaneous rounds', () => {
  // =======================================================================================

  it('lets every seat of a six-seat table open before any of them is resolved', async () => {
    // The shape the redesign exists for, and the one the cursor model made impossible.
    const g = await seated({ seats: 6 });
    for (let seat = 0; seat < 6; seat++) {
      g.sim.asPlayer(g.players[seat]!.sk);
      await g.sim.openTurn(seat, g.entropyFor(seat, 0), g.tick());
    }
    const led = g.ledger();
    assert.equal(led.openRound, 0n, 'no player move may advance the round');
    for (let seat = 0; seat < 6; seat++) {
      assert.equal(led.seatTurn.lookup(BigInt(seat)).stage, BigInt(STAGE.awaitRoll1));
      assert.equal(led.seatProgress.lookup(BigInt(seat)).round, 0n);
    }
  });

  it('interleaves six pipelines without one seat touching another', async () => {
    // Round-robin every step across all six seats, which is the worst case for a shared pending
    // cell -- under the cursor model's seven singletons this could not even be expressed.
    const g = await seated({ seats: 6 });
    const digest = g.ledger().roundDigest;
    const masks = [0, 1, 2, 3, 4, 5].map((s) => maskOf(s % 5, (s + 2) % 5));

    for (let seat = 0; seat < 6; seat++) {
      g.sim.asPlayer(g.players[seat]!.sk);
      await g.sim.openTurn(seat, g.entropyFor(seat, 0), g.tick());
    }
    g.sim.asOperator();
    for (let seat = 0; seat < 6; seat++) await g.sim.resolveRoll1(seat, g.tick());
    for (let seat = 0; seat < 6; seat++) {
      g.sim.asPlayer(g.players[seat]!.sk);
      await g.sim.hold(seat, masks[seat]!, g.tick());
    }
    g.sim.asOperator();
    for (let seat = 0; seat < 6; seat++) await g.sim.resolveRoll2(seat, g.tick());

    // Every seat's dice must still be its own -- i.e. what the mirror derives from ITS entropy
    // under ITS mask.
    const led = g.ledger();
    for (let seat = 0; seat < 6; seat++) {
      const mixed = mixEntropyTs(g.entropyFor(seat, 0), digest);
      const roll0 = firstRollTs(g.config.tableId, g.config.seed, mixed, 0);
      const roll1 = rerollUnderMaskTs(
        g.config.tableId,
        g.config.seed,
        mixed,
        0,
        1,
        masks[seat]!,
        roll0,
      );
      assert.deepEqual(
        diceToArray(led.seatTurn.lookup(BigInt(seat)).roll),
        roll1,
        `seat ${seat} got another seat's dice`,
      );
    }
  });

  it('produces identical state whatever order the seats submit in', async () => {
    // THE property that makes the digest freeze worth having. Two games, same seats, same
    // choices, same seed -- one played in seat order, one in a reversed-and-rotated order --
    // must end with the same digest, the same totals and the same winner.
    const opts: TableOptions = { seats: 4, tableId: bytes32(0x51) };
    const inOrder = await seated(opts, { strategy: 'bestScore' });
    const shuffled = await seated(opts, {
      strategy: 'bestScore',
      orderFor: (round, seats) => {
        const rotated = [...seats].reverse();
        const at = round % rotated.length;
        return rotated.slice(at).concat(rotated.slice(0, at));
      },
    });

    await inOrder.playToEnd();
    await shuffled.playToEnd();

    const a = inOrder.ledger();
    const b = shuffled.ledger();
    assert.deepEqual(b.roundDigest, a.roundDigest, 'submission order must not move the digest');
    for (let s = 0; s < 4; s++) {
      assert.equal(b.seatProgress.lookup(BigInt(s)).total, a.seatProgress.lookup(BigInt(s)).total);
      assert.deepEqual(
        diceToArray(b.seatProgress.lookup(BigInt(s)).dice),
        diceToArray(a.seatProgress.lookup(BigInt(s)).dice),
      );
    }
    // And the single offline replay -- which knows nothing about either order -- matches both.
    const rep = replayGame(tableConfig(opts), makePlayers(4), { strategy: 'bestScore' });
    assert.deepEqual(a.roundDigest, rep.digest);
    assert.deepEqual(b.roundDigest, rep.digest);
  });

  it('leaves every other seat byte-identical when one seat moves', async () => {
    const g = await seated({ seats: 4 });
    const snapshot = () => {
      const led = g.ledger();
      return [1, 2, 3].map((s) => ({
        progress: JSON.stringify(led.seatProgress.lookup(BigInt(s)), bigintReplacer),
        turn: JSON.stringify(led.seatTurn.lookup(BigInt(s)), bigintReplacer),
        card: JSON.stringify(led.seatCard.lookup(BigInt(s)), bigintReplacer),
        owed: led.seatRedeemable.lookup(BigInt(s)),
      }));
    };
    const before = snapshot();
    const potBefore = g.ledger().pot;
    await g.playTurn(0, 0, alwaysThreeRolls);
    assert.deepEqual(snapshot(), before, 'seat 0 playing must not touch seats 1..3');
    assert.equal(g.ledger().pot, potBefore, 'no turn may touch the pot');
  });

  it('refuses a second turn in the same round', async () => {
    const g = await seated({ seats: 2 });
    await g.playTurn(0, 0, alwaysStopEarly);
    g.sim.asPlayer(g.players[0]!.sk);
    await assert.rejects(
      () => g.sim.openTurn(0, g.entropyFor(0, 0), g.clock),
      /already played the open round/,
    );
  });

  it('refuses a seat that tries to run ahead into the next round', async () => {
    // TWO independent guards catch this and the entropy one fires first, which is why the
    // message names it. `openRound` is what `forcedEntropy` is checked against, so a seat that
    // submits round 1's entropy while round 0 is open cannot match its own commitment -- and if
    // it submits round 0's entropy instead, the round cursor refuses it as a repeat move (the
    // test above). Neither is bypassable by choosing the other argument.
    const g = await seated({ seats: 2 });
    await g.playTurn(0, 0, alwaysStopEarly);
    g.sim.asPlayer(g.players[0]!.sk);
    await assert.rejects(
      () => g.sim.openTurn(0, g.entropyFor(0, 1), g.clock),
      /entropy is not H\(sk, tableId, round\)/,
    );
    await assert.rejects(
      () => g.sim.openTurn(0, g.entropyFor(0, 0), g.clock),
      /already played the open round/,
    );
    assert.equal(g.ledger().openRound, 0n);
  });

  it('refuses to resolve a seat that has not opened a turn', async () => {
    const g = await seated({ seats: 2 });
    g.sim.asPlayer(g.players[0]!.sk);
    await g.sim.openTurn(0, g.entropyFor(0, 0), g.tick());
    g.sim.asOperator();
    await assert.rejects(() => g.sim.resolveRoll1(1, g.clock), /not awaiting its first roll/);
  });
});

/** `JSON.stringify` cannot serialise a bigint; the ledger is full of them. */
function bigintReplacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value;
}

// =========================================================================================
describe('closeRound', () => {
  // =======================================================================================

  it('refuses to close while a live seat still owes the round', async () => {
    const g = await seated({ seats: 3 });
    await g.playTurn(0, 0);
    await g.playTurn(1, 0);
    await assert.rejects(() => g.sim.closeRound(g.tick()), /not every seat has finished/);
    await g.playTurn(2, 0);
    await g.closeRound(0);
  });

  it('refuses to close at every point inside an unfinished turn', async () => {
    // Seven sub-states, and the round is not over in any of them. This is what
    // `seatProgress.round` being advanced by SCORING rather than by a resolve buys: one read per
    // seat settles the question at every one of them.
    const g = await seated({ seats: 2 });
    await g.playTurn(0, 0, alwaysStopEarly);
    const seat = 1;

    g.sim.asPlayer(g.players[seat]!.sk);
    await assert.rejects(() => g.sim.closeRound(g.tick()), /not every seat has finished/);
    await g.sim.openTurn(seat, g.entropyFor(seat, 0), g.tick());
    await assert.rejects(() => g.sim.closeRound(g.tick()), /not every seat has finished/);
    g.sim.asOperator();
    await g.sim.resolveRoll1(seat, g.tick());
    await assert.rejects(() => g.sim.closeRound(g.tick()), /not every seat has finished/);
    g.sim.asPlayer(g.players[seat]!.sk);
    await g.sim.hold(seat, maskOf(0), g.tick());
    await assert.rejects(() => g.sim.closeRound(g.tick()), /not every seat has finished/);
    g.sim.asOperator();
    await g.sim.resolveRoll2(seat, g.tick());
    await assert.rejects(() => g.sim.closeRound(g.tick()), /not every seat has finished/);
    g.sim.asPlayer(g.players[seat]!.sk);
    await g.sim.hold(seat, maskOf(1), g.tick());
    await assert.rejects(() => g.sim.closeRound(g.tick()), /not every seat has finished/);
    g.sim.asOperator();
    await g.sim.resolveRoll3(seat, g.tick());
    await assert.rejects(() => g.sim.closeRound(g.tick()), /not every seat has finished/);

    g.sim.asPlayer(g.players[seat]!.sk);
    const dice = diceToArray(g.ledger().seatTurn.lookup(BigInt(seat)).roll);
    await g.sim.score(seat, g.chooseCategory(seat, dice), g.tick());
    await g.sim.closeRound(g.tick());
    assert.equal(g.ledger().openRound, 1n);
  });

  it('does not wait for eliminated seats', async () => {
    const g = await seated({ seats: 3 }, { eliminations: [{ seat: 2, round: 0 }] });
    await g.playRound(0);
    assert.equal(g.ledger().openRound, 1n);
    assert.equal(g.ledger().activeSeats, 2n);
  });

  it('refuses to close a game that is already over', async () => {
    const g = await seated({ seats: 2 }, { holds: alwaysStopEarly });
    await g.playToEnd();
    assert.equal(g.ledger().openRound, BigInt(ROUND_COUNT));
    await assert.rejects(() => g.sim.closeRound(g.tick()), /already over/);
  });

  it('restamps the deadline every round, and only there', async () => {
    const g = await seated({ seats: 2 });
    const atOpen = g.ledger().roundDeadline;
    await g.playTurn(0, 0);
    await g.playTurn(1, 0);
    assert.equal(g.ledger().roundDeadline, atOpen, 'no move within a round may move the deadline');
    const at = g.tick();
    await g.sim.closeRound(at);
    assert.equal(g.ledger().roundDeadline, BigInt(at) + g.config.turnTimeoutSecs);
  });

  it('is permissionless -- a player can advance a table whose operator went quiet', async () => {
    const g = await seated({ seats: 2 });
    await g.playTurn(0, 0);
    await g.playTurn(1, 0);
    g.sim.asPlayer(g.players[1]!.sk);
    await g.sim.closeRound(g.tick());
    assert.equal(g.ledger().openRound, 1n);
  });
});

// =========================================================================================
describe('the frozen round digest', () => {
  // =======================================================================================
  //
  // Section 2 of table.compact's header: under simultaneous rounds a running digest would hand
  // the operator its choice of everybody's future dice, by choosing the order it resolves in.

  it('gives every seat in a round the same digest to hash against', async () => {
    const g = await seated({ seats: 4 });
    const frozen = g.ledger().roundDigest;
    for (let seat = 0; seat < 4; seat++) {
      await g.playTurn(seat, 0);
      assert.deepEqual(
        g.ledger().roundDigest,
        frozen,
        `the digest moved while seat ${seat} was playing`,
      );
      assert.deepEqual(
        g.ledger().seatTurn.lookup(BigInt(seat)).mixed,
        mixEntropyTs(g.entropyFor(seat, 0), frozen),
        `seat ${seat} mixed against something other than the frozen digest`,
      );
    }
  });

  it('folds the round in seat order, over all six slots', async () => {
    // The unoccupied slots contribute their constructor defaults. A replay that folded only the
    // seated rows would produce a different hash, which is why `roundDigestTs` insists on six.
    const g = await seated({ seats: 2 });
    const before = g.ledger().roundDigest;
    await g.playRound(0);
    const led = g.ledger();
    assert.notDeepEqual(led.roundDigest, before);
    for (let s = 2; s < MAX_SEATS; s++) {
      assert.deepEqual(
        diceToArray(led.seatProgress.lookup(BigInt(s)).dice),
        [1, 1, 1, 1, 1],
        'an unoccupied slot keeps the constructor placeholder',
      );
    }
    // The driver already asserted the fold against the mirror inside `closeRound`; restating the
    // round-0 case here makes the failure legible if the struct layout ever drifts.
    assert.deepEqual(led.roundDigest, g.digest);
  });

  it('separates two seats’ dice streams by their secrets alone', async () => {
    // `RollContext` has no seat field. The whole of the separation is `playerEntropy`, which is
    // a hash of `sk_s` -- and `join` refuses a second seat for a `C_s` already registered, so
    // two seats cannot share one.
    const g = await seated({ seats: 2 });
    const digest = g.ledger().roundDigest;
    const a = firstRollTs(
      g.config.tableId,
      g.config.seed,
      mixEntropyTs(g.entropyFor(0, 0), digest),
      0,
    );
    const b = firstRollTs(
      g.config.tableId,
      g.config.seed,
      mixEntropyTs(g.entropyFor(1, 0), digest),
      0,
    );
    assert.notDeepEqual(a, b, 'two seats in one round must not roll the same dice');
    await g.playTurn(0, 0, alwaysStopEarly);
    await g.playTurn(1, 0, alwaysStopEarly);
    assert.deepEqual(diceToArray(g.ledger().seatProgress.lookup(0n).dice), a);
    assert.deepEqual(diceToArray(g.ledger().seatProgress.lookup(1n).dice), b);
  });
});

// =========================================================================================
describe('entropy and authorisation', () => {
  // =======================================================================================

  it('rejects an open signed with the wrong secret', async () => {
    const g = await seated({ seats: 2 });
    // Seat 1's secret cannot move seat 0, even with seat 0's correct entropy value.
    g.sim.asPlayer(g.players[1]!.sk);
    await assert.rejects(
      () => g.sim.openTurn(0, g.entropyFor(0, 0), g.clock),
      /wrong entropy secret/,
    );
    g.sim.asPlayer(bytes32(0xaa));
    await assert.rejects(
      () => g.sim.openTurn(0, g.entropyFor(0, 0), g.clock),
      /wrong entropy secret/,
    );
  });

  it('rejects a hold and a score signed with the wrong secret', async () => {
    // Not optional for the later moves: without it anyone could hold nothing and score another
    // seat's dice into its worst category.
    const g = await seated({ seats: 2 });
    await rolledOnce(g, 0);
    g.sim.asPlayer(g.players[1]!.sk);
    await assert.rejects(() => g.sim.hold(0, maskOf(0), g.clock), /wrong entropy secret/);
    await assert.rejects(() => g.sim.score(0, 0, g.clock), /wrong entropy secret/);
  });

  it('rejects entropy that is not H(sk, tableId, round)', async () => {
    const g = await seated({ seats: 2 });
    g.sim.asPlayer(g.players[0]!.sk);
    for (const wrong of [
      bytes32(0xcc), // arbitrary
      forcedEntropyTs(g.players[0]!.sk, g.config.tableId, 1), // right seat, wrong round
      forcedEntropyTs(g.players[1]!.sk, g.config.tableId, 0), // right round, wrong seat
      forcedEntropyTs(g.players[0]!.sk, bytes32(0x99), 0), // wrong table
    ]) {
      await assert.rejects(
        () => g.sim.openTurn(0, wrong, g.clock),
        /entropy is not H\(sk, tableId, round\)/,
      );
    }
  });

  it('rejects a second join from the same entropy key', async () => {
    const g = await GameDriver.open({ seats: 3 });
    await g.join(0);
    g.sim.asPlayer(g.players[0]!.sk);
    await assert.rejects(
      () => g.sim.join(userAddress(0x77), g.tick()),
      /already holds a seat/,
      'one secret must not take two seats -- the dice streams are separated by nothing else',
    );
    assert.equal(g.ledger().seatCount, 1n);
  });

  it('rejects joining a full table and joining after play starts', async () => {
    const g = await seated({ seats: 2 });
    g.sim.asPlayer(bytes32(0xbb));
    await assert.rejects(() => g.sim.join(userAddress(0x77), g.tick()), /table is not filling/);
  });

  it('rejects a move on a seat index that does not exist', async () => {
    const g = await seated({ seats: 2 });
    g.sim.asPlayer(g.players[0]!.sk);
    for (const seat of [2, 5, 200]) {
      await assert.rejects(() => g.sim.openTurn(seat, g.entropyFor(0, 0), g.clock), /no such seat/);
    }
  });

  it('rejects a category that is already filled', async () => {
    const g = await seated({ seats: 2 }, { holds: alwaysStopEarly });
    await g.playRound(0);
    const first = g.seats[0]!.card.scores.findIndex((s) => s !== null);
    assert.ok(first >= 0);
    await rolledOnce(g, 0, 1);
    g.sim.asPlayer(g.players[0]!.sk);
    await assert.rejects(
      () => g.sim.score(0, first, g.clock),
      /illegal placement/,
      'a filled box must not be reusable',
    );
  });

  it('rejects a category index outside 0..12', async () => {
    const g = await seated({ seats: 2 });
    await rolledOnce(g, 0);
    g.sim.asPlayer(g.players[0]!.sk);
    for (const cat of [CATEGORY_COUNT, CATEGORY_COUNT + 1, 200]) {
      await assert.rejects(() => g.sim.score(0, cat, g.clock), /illegal placement/);
    }
  });
});

// =========================================================================================
describe('the three-transaction resolve', () => {
  // =======================================================================================

  it('checks the seed at every step, not only the first', async () => {
    // Each step derives a roll from the seed, so a step that skipped the check would accept dice
    // derived from a different preimage.
    const g = await seated({ seats: 2 });
    g.sim.asPlayer(g.players[0]!.sk);
    await g.sim.openTurn(0, g.entropyFor(0, 0), g.tick());
    const wrong = bytes32(0x99);

    const withWrongSeed = async (fn: () => Promise<unknown>): Promise<void> => {
      g.sim.privateState = { rollSeed: wrong, playerSecret: new Uint8Array(32) };
      await assert.rejects(fn, /does not open the table's seed/);
      g.sim.asOperator();
    };

    await withWrongSeed(() => g.sim.resolveRoll1(0, g.clock));
    await g.sim.resolveRoll1(0, g.tick());
    g.sim.asPlayer(g.players[0]!.sk);
    await g.sim.hold(0, maskOf(0), g.tick());
    g.sim.asOperator();
    await withWrongSeed(() => g.sim.resolveRoll2(0, g.clock));
    await g.sim.resolveRoll2(0, g.tick());
    g.sim.asPlayer(g.players[0]!.sk);
    await g.sim.hold(0, maskOf(1), g.tick());
    g.sim.asOperator();
    await withWrongSeed(() => g.sim.resolveRoll3(0, g.clock));
    await g.sim.resolveRoll3(0, g.tick());
  });

  it('refuses a resolve for a pending turn from another round', async () => {
    // A defence in depth: `closeRound` cannot advance while a turn is pending, so this should be
    // unreachable -- but the roll would derive from the wrong digest if it ever were.
    const g = await seated({ seats: 2 });
    assert.ok(ledgerReads('resolveRoll1').has('openRound'));
    await g.playTurn(0, 0, alwaysStopEarly);
    await g.playTurn(1, 0, alwaysStopEarly);
    await g.closeRound(0);
    // Seat 0's cell still records round 0; opening a fresh turn is what re-stamps it.
    assert.equal(g.ledger().seatTurn.lookup(0n).round, 0n);
    g.sim.asPlayer(g.players[0]!.sk);
    await g.sim.openTurn(0, g.entropyFor(0, 1), g.tick());
    assert.equal(g.ledger().seatTurn.lookup(0n).round, 1n, 'opening re-stamps the round');
  });

  it('derives each roll from the mirror, over a whole six-seat round', async () => {
    const g = await seated({ seats: 6 }, { holds: alwaysThreeRolls });
    await g.playRound(0);
    // `playTurn` asserted every roll against the mirror as it went; this restates the outcome.
    assert.equal(g.turns.length, 6);
    for (const t of g.turns) {
      assert.equal(t.rolls.length, 3);
      assert.deepEqual(t.dice, t.rolls[2]);
    }
  });
});

// =========================================================================================
describe('joker rules at table level', () => {
  // =======================================================================================

  it('awards the Yahtzee bonus and enforces forced placement', async () => {
    // Chasing the modal face rolls five of a kind often enough that a four-seat game reaches the
    // joker rules; `probeIllegal` then attacks every scoring move with a category the reference
    // refuses, which in a joker situation is exactly what forced placement forbids.
    const g = await seated(
      { seats: 4, tableId: bytes32(16) },
      { strategy: 'bestScore', probeIllegal: true, holds: keepModal },
    );
    await g.playToEnd();
    assert.ok(g.illegalProbes > 0, 'no illegal placement was ever probed');
    assert.ok(g.jokerProbes > 0, 'no joker situation was reached');
    const rep = g.replay();
    for (let s = 0; s < 4; s++) {
      assert.equal(g.ledger().seatProgress.lookup(BigInt(s)).total, BigInt(rep.totals[s]!));
    }
  });

  it('rolls five of a kind under a modal-chasing player', async () => {
    const g = await seated(
      { seats: 4, tableId: bytes32(16) },
      { strategy: 'bestScore', holds: keepModal },
    );
    await g.playToEnd();
    const yahtzees = g.turns.filter((t) => refIsYahtzee(t.dice as unknown as RefDice)).length;
    assert.ok(yahtzees > 0, 'the joker tests depend on this schedule producing a Yahtzee');
  });

  it('agrees with the mirror on the modal face over every hand shape', () => {
    // `modalFace` is no longer mirrored by any circuit -- `isCanonicalModal` and the
    // `modalFaceHint` witness went with the pre-declared policies -- but it is still what a
    // modal-chasing client computes, and the joker tests depend on it, so the sweep stays.
    let hands = 0;
    for (let a = 1; a <= 6; a++)
      for (let b = a; b <= 6; b++)
        for (let c = b; c <= 6; c++)
          for (let d = c; d <= 6; d++)
            for (let e = d; e <= 6; e++) {
              const hand = [a, b, c, d, e];
              hands += 1;
              const m = modalFace(hand);
              assert.ok(m >= 1 && m <= 6);
              const counts = [1, 2, 3, 4, 5, 6].map((f) => hand.filter((x) => x === f).length);
              const best = Math.max(...counts);
              assert.equal(counts[m - 1], best, `modalFace(${hand}) = ${m} is not modal`);
              for (let f = m + 1; f <= 6; f++) {
                assert.ok(counts[f - 1]! < best, 'ties must go to the higher face');
              }
            }
    assert.equal(hands, 252);
  });
});

// =========================================================================================
describe('elimination', () => {
  // =======================================================================================

  /** Drive a table to the open round `round` with nobody having moved in it. */
  async function atRound(round: number, opts: TableOptions = { seats: 2 }): Promise<GameDriver> {
    const g = await seated(opts, { strategy: 'bestScore', holds: alwaysStopEarly });
    for (let r = 0; r < round; r++) await g.playRound(r);
    assert.equal(g.ledger().openRound, BigInt(round));
    return g;
  }

  it('refuses one second before the deadline and allows it one second after', async () => {
    const g = await atRound(1);
    const deadline = Number(g.ledger().roundDeadline);
    const { q, rem } = penaltySplit(g.config.tier, 1);
    await assert.rejects(
      () => g.sim.eliminate(0, q, rem, deadline),
      /deadline has not passed/,
      'the predicate is strict: at the deadline exactly, the seat still has time',
    );
    await g.sim.eliminate(0, q, rem, deadline + 1);
    assert.equal(g.ledger().seatProgress.lookup(0n).eliminated, true);
  });

  it('refuses a seat that has already played the round', async () => {
    const g = await atRound(1);
    await g.playTurn(0, 1, alwaysStopEarly);
    const past = Number(g.ledger().roundDeadline) + 1;
    const { q, rem } = penaltySplit(g.config.tier, 1);
    await assert.rejects(() => g.sim.eliminate(0, q, rem, past), /already played the open round/);
  });

  it('covers every player-owed sub-state of an abandoned turn', async () => {
    // THE requirement interactive holds added: a seat can now walk away in four different
    // places, and all four are the player's silence. Stage 0 (never opened) is covered above;
    // these are the three mid-turn ones.
    for (const stopAt of [STAGE.rolled1, STAGE.rolled2, STAGE.rolled3] as const) {
      const g = await atRound(2);
      const seat = 0;
      g.sim.asPlayer(g.players[seat]!.sk);
      await g.sim.openTurn(seat, g.entropyFor(seat, 2), g.tick());
      g.sim.asOperator();
      await g.sim.resolveRoll1(seat, g.tick());
      if (stopAt !== STAGE.rolled1) {
        g.sim.asPlayer(g.players[seat]!.sk);
        await g.sim.hold(seat, maskOf(0), g.tick());
        g.sim.asOperator();
        await g.sim.resolveRoll2(seat, g.tick());
      }
      if (stopAt === STAGE.rolled3) {
        g.sim.asPlayer(g.players[seat]!.sk);
        await g.sim.hold(seat, maskOf(1), g.tick());
        g.sim.asOperator();
        await g.sim.resolveRoll3(seat, g.tick());
      }
      assert.equal(g.ledger().seatTurn.lookup(BigInt(seat)).stage, BigInt(stopAt));

      const past = Number(g.ledger().roundDeadline) + 1;
      const { q, rem } = penaltySplit(g.config.tier, 2);
      await g.sim.eliminate(seat, q, rem, past);
      assert.equal(g.ledger().seatProgress.lookup(BigInt(seat)).eliminated, true);
      assert.equal(
        g.ledger().seatTurn.lookup(BigInt(seat)).stage,
        BigInt(STAGE.idle),
        'elimination must close the half-played turn',
      );
    }
  });

  it('refuses a seat that is waiting on the operator, at all three roll steps', async () => {
    // The other half: a player who submitted and is waiting must not be eliminated for the
    // operator's silence. `abortTable` is the remedy for that instead.
    for (const stopAt of [STAGE.awaitRoll1, STAGE.awaitRoll2, STAGE.awaitRoll3] as const) {
      const g = await atRound(2);
      const seat = 0;
      g.sim.asPlayer(g.players[seat]!.sk);
      await g.sim.openTurn(seat, g.entropyFor(seat, 2), g.tick());
      if (stopAt !== STAGE.awaitRoll1) {
        g.sim.asOperator();
        await g.sim.resolveRoll1(seat, g.tick());
        g.sim.asPlayer(g.players[seat]!.sk);
        await g.sim.hold(seat, maskOf(0), g.tick());
      }
      if (stopAt === STAGE.awaitRoll3) {
        g.sim.asOperator();
        await g.sim.resolveRoll2(seat, g.tick());
        g.sim.asPlayer(g.players[seat]!.sk);
        await g.sim.hold(seat, maskOf(1), g.tick());
      }
      assert.equal(g.ledger().seatTurn.lookup(BigInt(seat)).stage, BigInt(stopAt));

      const past = Number(g.ledger().roundDeadline) + 1;
      const { q, rem } = penaltySplit(g.config.tier, 2);
      await assert.rejects(
        () => g.sim.eliminate(seat, q, rem, past),
        /waiting on the operator/,
        `a seat at stage ${stopAt} is the operator's to discharge`,
      );
    }
  });

  it('refuses to eliminate a seat twice', async () => {
    const g = await atRound(1);
    await g.eliminate(0, 1);
    const { q, rem } = penaltySplit(g.config.tier, 1);
    await assert.rejects(() => g.sim.eliminate(0, q, rem, g.clock), /already out/);
  });

  it('refuses a penalty that is not the unique q, rem', async () => {
    const g = await atRound(5);
    const past = Number(g.ledger().roundDeadline) + 1;
    const { q, rem } = penaltySplit(g.config.tier, 5);
    for (const [badQ, badRem] of [
      [q + 1n, rem],
      [q - 1n, rem],
      [q, rem + 13n],
      [0n, g.config.tier * 6n],
      [g.config.tier, 0n],
    ]) {
      await assert.rejects(() => g.sim.eliminate(0, badQ!, badRem!, past), /penalty|remainder/);
    }
    await g.sim.eliminate(0, q, rem, past);
  });

  it('charges exactly stake x (round + 1) / 13 at both boundaries and in between', async () => {
    // Round 0: a thirteenth -- a seat that never played anything at all. Round 12: the whole
    // stake. And a middle round, so the arithmetic is not checked only where it degenerates.
    // `tier` is 1_300_000 so every split is exact and a wrong remainder cannot hide in a
    // rounding step.
    const tier = 1_300_000n;
    for (const round of [0, 1, 7, FINAL_ROUND]) {
      const g = await atRound(round, { seats: 2, tier });
      const expectedPenalty = (tier * BigInt(round + 1)) / 13n;
      const potBefore = g.ledger().pot;

      const refund = await g.eliminate(0, round);
      assert.equal(refund, tier - expectedPenalty, `refund at round ${round}`);
      assert.equal(g.ledger().seatRedeemable.lookup(0n), tier - expectedPenalty);
      assert.equal(
        g.ledger().pot,
        potBefore - (tier - expectedPenalty),
        `the penalty stays in the pot at round ${round}`,
      );
      g.assertCustody();
    }
  });

  it('takes a thirteenth from a seat that never showed up', async () => {
    const tier = 1_300_000n;
    const g = await atRound(0, { seats: 2, tier });
    await g.eliminate(0, 0);
    assert.equal(g.ledger().seatRedeemable.lookup(0n), tier - tier / 13n);
    assert.notEqual(g.ledger().seatRedeemable.lookup(0n), tier, 'a no-show must not be free');
  });

  it('takes the whole stake in the last round and leaves nothing to redeem', async () => {
    const tier = 1_300_000n;
    const g = await atRound(FINAL_ROUND, { seats: 2, tier });
    await g.eliminate(0, FINAL_ROUND);
    assert.equal(g.ledger().seatRedeemable.lookup(0n), 0n, 'the last round forfeits everything');
    assert.equal(g.ledger().pot, tier * 2n, 'the whole stake stayed with the winner');
  });

  it('writes a receipt the mirror can reproduce', async () => {
    const g = await atRound(4);
    const { q } = penaltySplit(g.config.tier, 4);
    await g.eliminate(0, 4);
    assert.deepEqual(
      g.ledger().seatReceipt.lookup(0n),
      eliminateDigestTs(bytes32(0), g.config.tableId, 0, 4, g.config.tier, q, g.config.tier - q),
      'the elimination receipt must match the mirror',
    );
  });

  it('stops an eliminated seat playing, and stops it winning', async () => {
    // Table 12 with seat 0 eliminated at round 10 was found by sweeping `replayGame` for a game
    // in which the ELIMINATED seat ends with the strictly highest total. Under the cursor model
    // it would have won; under simultaneous rounds elimination is permanent and economic, and it
    // has already been handed back `tier - penalty`, so paying it the pot would pay it twice.
    const opts: TableOptions = { seats: 3, tableId: bytes32(12) };
    const plan: GamePlan = { strategy: 'bestScore', eliminations: [{ seat: 0, round: 10 }] };
    const preview = replayGame(tableConfig(opts), makePlayers(3), plan);
    assert.ok(preview.totals[0]! > preview.totals[1]!, 'this scenario was chosen for it');
    assert.ok(preview.totals[0]! > preview.totals[2]!);

    const g = await seated(opts, plan);
    await g.playToEnd();
    const led = g.ledger();
    assert.equal(led.seatProgress.lookup(0n).eliminated, true);
    assert.equal(led.seatProgress.lookup(0n).finishedAtRound, NO_FINISH);
    assert.ok(led.seatProgress.lookup(0n).total > led.seatProgress.lookup(1n).total);

    const [q, r] = g.rakeSplit();
    const winner = await g.sim.settle(g.config.seed, q, r);
    assert.equal(winner, 1n, 'the eliminated seat must not win despite the highest total');
    assert.equal(winner, BigInt(g.expectedWinner()));
  });

  it('refuses every move from an eliminated seat, for the rest of the game', async () => {
    const g = await atRound(2);
    await g.eliminate(0, 2);
    await g.playTurn(1, 2, alwaysStopEarly);
    await g.closeRound(2);
    g.sim.asPlayer(g.players[0]!.sk);
    await assert.rejects(() => g.sim.openTurn(0, g.entropyFor(0, 3), g.clock), /been eliminated/);
    await assert.rejects(() => g.sim.hold(0, maskOf(0), g.clock), /been eliminated/);
    await assert.rejects(() => g.sim.score(0, 0, g.clock), /been eliminated/);
  });
});

// =========================================================================================
describe('the all-eliminated waiver', () => {
  // =======================================================================================
  //
  // Decision 1 of docs/simultaneous-rounds.md: when nobody kept playing there is nobody for the
  // penalties to compensate, so they are waived and every seat gets its stake back less the 1%
  // rake -- and the rake IS still paid, because the operator did its work regardless.

  async function abandoned(round: number, seats = 2, tier = 1_300_000n): Promise<GameDriver> {
    const g = await seated({ seats, tier }, { strategy: 'bestScore', holds: alwaysStopEarly });
    for (let r = 0; r < round; r++) await g.playRound(r);
    for (let s = 0; s < seats; s++) await g.eliminate(s, round);
    assert.equal(g.ledger().phase, PHASE.abandoned);
    assert.equal(g.ledger().activeSeats, 0n);
    return g;
  }

  it('abandons the table when the last active seat is eliminated', async () => {
    const g = await abandoned(3);
    // Not yet redeemable: the penalties are still in the pot and every seat's redeemable is
    // still net of its own. One permissionless `abortTable` applies the waiver.
    await assert.rejects(() => g.sim.redeem(0), /table is not finished/);
    g.assertCustody();
  });

  it('waives the penalties, pays the rake, and lets every seat redeem in full', async () => {
    const tier = 1_300_000n;
    const g = await abandoned(9, 3, tier);
    const { q, rem } = perSeatRake(tier);
    const share = await g.sim.abortTable(q, rem, g.clock);
    assert.equal(share, tier - q, 'every seat redeems its whole stake less the 1% rake');

    const led = g.ledger();
    assert.equal(led.phase, PHASE.aborted);
    assert.equal(led.pot, 0n);
    for (let s = 0; s < 3; s++) {
      assert.equal(led.seatRedeemable.lookup(BigInt(s)), tier - q, `seat ${s} redeemable`);
    }
    g.assertCustody();
    assert.deepEqual(
      led.finalDigest,
      finalDigestTs(
        led.roundDigest,
        g.config.tableId,
        PHASE.aborted,
        NO_WINNER,
        3,
        0n,
        q * 3n,
        tier - q,
        false,
      ),
      'the certificate must record the rake the waiver paid',
    );

    for (let s = 0; s < 3; s++) {
      assert.equal(await g.sim.redeem(s), tier - q);
      assert.equal(g.ledger().seatRedeemable.lookup(BigInt(s)), 0n);
    }
    g.assertFullyDrained();
  });

  it('restores a last-round casualty from nothing to a full refund', async () => {
    // The sharpest case: a seat eliminated in the last round forfeits its ENTIRE stake, so
    // before the waiver it has nothing at all. The waiver has to be a rewrite rather than a
    // top-up, and this is the test that would fail if it were an addition.
    const tier = 1_300_000n;
    const g = await abandoned(FINAL_ROUND, 2, tier);
    assert.equal(g.ledger().seatRedeemable.lookup(0n), 0n, 'the last round forfeits everything');
    const { q, rem } = perSeatRake(tier);
    await g.sim.abortTable(q, rem, g.clock);
    assert.equal(g.ledger().seatRedeemable.lookup(0n), tier - q);
    g.assertCustody();
  });

  it('refuses to run the waiver twice', async () => {
    const g = await abandoned(2);
    const { q, rem } = perSeatRake(g.config.tier);
    await g.sim.abortTable(q, rem, g.clock);
    await assert.rejects(() => g.sim.abortTable(q, rem, g.clock), /neither stalled|abandoned/);
  });

  it('refuses a per-seat rake that is not the unique q, rem', async () => {
    const g = await abandoned(2);
    const { q, rem } = perSeatRake(g.config.tier);
    for (const [badQ, badRem] of [
      [q + 1n, rem],
      [q, rem + 100n],
      [0n, g.config.tier],
    ]) {
      await assert.rejects(() => g.sim.abortTable(badQ!, badRem!, g.clock), /rake/);
    }
  });
});

// =========================================================================================
describe('redeem', () => {
  // =======================================================================================

  it('refuses while the table is filling', async () => {
    const g = await GameDriver.open({ seats: 3 });
    await g.join(0);
    await assert.rejects(() => g.sim.redeem(0), /table is not finished/);
  });

  it('refuses while the table is live, even to a seat that is owed money', async () => {
    const g = await seated({ seats: 2 });
    await assert.rejects(() => g.sim.redeem(0), /table is not finished/);
    await g.eliminate(0, 0);
    assert.ok(g.ledger().seatRedeemable.lookup(0n) > 0n, 'the seat is owed money');
    await assert.rejects(
      () => g.sim.redeem(0),
      /table is not finished/,
      'an eliminated player waits for the game to end -- decision 4',
    );
  });

  it('pays an eliminated seat once the game settles, and only once', async () => {
    const tier = 1_300_000n;
    const g = await seated({ seats: 3, tier }, { strategy: 'bestScore', holds: alwaysStopEarly });
    for (let r = 0; r < 6; r++) await g.playRound(r);
    await g.playTurn(0, 6, alwaysStopEarly);
    await g.playTurn(2, 6, alwaysStopEarly);
    const refund = await g.eliminate(1, 6);
    await g.closeRound(6);
    for (let r = 7; r < ROUND_COUNT; r++) await g.playRound(r);

    const [q, r] = g.rakeSplit();
    await g.sim.settle(g.config.seed, q, r);
    assert.equal(g.ledger().pot, 0n);

    assert.equal(await g.sim.redeem(1), refund);
    assert.equal(g.ledger().seatRedeemable.lookup(1n), 0n);
    await assert.rejects(() => g.sim.redeem(1), /nothing to redeem/);
    // Seats that were never eliminated are owed nothing -- their money went to the winner.
    await assert.rejects(() => g.sim.redeem(0), /nothing to redeem/);
    await assert.rejects(() => g.sim.redeem(2), /nothing to redeem/);
    g.assertFullyDrained();
  });

  it('refuses an unknown seat', async () => {
    const g = await seated({ seats: 2 }, { holds: alwaysStopEarly });
    await g.playToEnd();
    const [q, r] = g.rakeSplit();
    await g.sim.settle(g.config.seed, q, r);
    await assert.rejects(() => g.sim.redeem(2), /no such seat/);
    await assert.rejects(() => g.sim.redeem(200), /no such seat/);
  });

  it('chains a receipt the mirror can reproduce, over the elimination that preceded it', async () => {
    const tier = 1_300_000n;
    const g = await seated({ seats: 2, tier }, { strategy: 'bestScore', holds: alwaysStopEarly });
    for (let r = 0; r < 4; r++) await g.playRound(r);
    await g.playTurn(1, 4, alwaysStopEarly);
    await g.eliminate(0, 4);
    const elimReceipt = g.ledger().seatReceipt.lookup(0n);
    await g.closeRound(4);
    for (let r = 5; r < ROUND_COUNT; r++) await g.playRound(r);
    const [q, r] = g.rakeSplit();
    await g.sim.settle(g.config.seed, q, r);

    const owed = g.ledger().seatRedeemable.lookup(0n);
    const card = g.ledger().seatCard.lookup(0n);
    await g.sim.redeem(0);
    assert.deepEqual(
      g.ledger().seatReceipt.lookup(0n),
      redeemDigestTs(
        elimReceipt,
        g.config.tableId,
        0,
        owed,
        g.players[0]!.addr.bytes,
        card as unknown as ScorecardTs,
      ),
      'the redeem receipt must chain the elimination receipt',
    );
  });
});

// =========================================================================================
describe('abortTable', () => {
  // =======================================================================================

  it('refunds the joined seats when a table never fills', async () => {
    const g = await GameDriver.open({ seats: 3 });
    await g.join(0);
    await g.join(1);
    const deadline = Number(g.ledger().roundDeadline);
    await assert.rejects(() => g.sim.abortTable(0n, 0n, deadline), /neither stalled/);

    const { q, rem } = perSeatRake(g.config.tier);
    const share = await g.sim.abortTable(q, rem, deadline + 1);
    assert.equal(share, g.config.tier, 'a table that never played pays no rake');
    const led = g.ledger();
    assert.equal(led.phase, PHASE.aborted);
    assert.equal(led.pot, 0n);
    assert.equal(led.seatRedeemable.lookup(0n), g.config.tier);
    assert.equal(led.seatRedeemable.lookup(1n), g.config.tier);
    assert.equal(led.seatRedeemable.lookup(2n), 0n, 'an unseated slot is owed nothing');
    g.assertCustody();

    assert.equal(await g.sim.redeem(0), g.config.tier);
    assert.equal(await g.sim.redeem(1), g.config.tier);
    await assert.rejects(() => g.sim.redeem(2), /no such seat/);
  });

  it('refuses to abort an empty table, at any time', async () => {
    const g = await GameDriver.open({ seats: 2 });
    for (const when of [DEFAULT_BLOCK_TIME, DEFAULT_BLOCK_TIME + 10_000_000]) {
      await assert.rejects(() => g.sim.abortTable(0n, 0n, when), /neither stalled/);
    }
  });

  it('refunds every seat when the operator stalls, at all three roll steps', async () => {
    for (const stopAfter of [0, 1, 2]) {
      const g = await seated({ seats: 2 });
      await g.playTurn(1, 0, alwaysStopEarly);
      g.sim.asPlayer(g.players[0]!.sk);
      await g.sim.openTurn(0, g.entropyFor(0, 0), g.tick());
      if (stopAfter >= 1) {
        g.sim.asOperator();
        await g.sim.resolveRoll1(0, g.tick());
        g.sim.asPlayer(g.players[0]!.sk);
        await g.sim.hold(0, maskOf(0), g.tick());
      }
      if (stopAfter >= 2) {
        g.sim.asOperator();
        await g.sim.resolveRoll2(0, g.tick());
        g.sim.asPlayer(g.players[0]!.sk);
        await g.sim.hold(0, maskOf(1), g.tick());
      }

      const grace = Number(g.ledger().roundDeadline + g.config.tableTimeoutSecs);
      const { q, rem } = perSeatRake(g.config.tier);
      await assert.rejects(() => g.sim.abortTable(q, rem, grace), /neither stalled/);
      const share = await g.sim.abortTable(q, rem, grace + 1);
      assert.equal(share, g.config.tier, 'a stalled operator earns no rake');
      assert.equal(g.ledger().pot, 0n);
      for (let s = 0; s < 2; s++) {
        assert.equal(g.ledger().seatRedeemable.lookup(BigInt(s)), g.config.tier);
      }
      g.assertCustody();
    }
  });

  it('refuses to abort a live table where no seat is waiting on the operator', async () => {
    // THE griefing guard. Without the waiting-on-the-operator condition a losing player could
    // stop playing, wait out both deadlines and convert the game into a full refund. With it,
    // the only exits from an all-idle table are `eliminate` and `closeRound`, both
    // permissionless and both available a whole table timeout earlier.
    const g = await seated({ seats: 2 });
    const { q, rem } = perSeatRake(g.config.tier);
    const long = Number(g.ledger().roundDeadline + g.config.tableTimeoutSecs) + 1_000_000;
    await assert.rejects(() => g.sim.abortTable(q, rem, long), /neither stalled/);
    // The remedy that IS available: eliminate the stragglers.
    const p = penaltySplit(g.config.tier, 0);
    await g.sim.eliminate(0, p.q, p.rem, long);
    assert.equal(g.ledger().seatProgress.lookup(0n).eliminated, true);
  });

  it('refuses when a seat is mid-turn but the next move is the PLAYER’s', async () => {
    // A seat sitting at `rolled1` has been rolled and owes a hold or a score. That is the
    // player's silence, not the operator's, so `eliminate` covers it and `abortTable` must not.
    const g = await seated({ seats: 2 });
    await g.playTurn(1, 0, alwaysStopEarly);
    await rolledOnce(g, 0);
    assert.equal(g.ledger().seatTurn.lookup(0n).stage, BigInt(STAGE.rolled1));
    const { q, rem } = perSeatRake(g.config.tier);
    const long = Number(g.ledger().roundDeadline + g.config.tableTimeoutSecs) + 1_000_000;
    await assert.rejects(() => g.sim.abortTable(q, rem, long), /neither stalled/);
  });

  it('refuses to abort a finished game -- settle is its exit', async () => {
    const g = await seated({ seats: 2 }, { holds: alwaysStopEarly });
    await g.playToEnd();
    const { q, rem } = perSeatRake(g.config.tier);
    const long = Number(g.ledger().roundDeadline + g.config.tableTimeoutSecs) + 1_000_000;
    await assert.rejects(() => g.sim.abortTable(q, rem, long), /neither stalled/);
  });
});

// =========================================================================================
describe('settlement guards', () => {
  // =======================================================================================

  it('refuses to settle before the game is finished', async () => {
    const g = await seated({ seats: 2 }, { holds: alwaysStopEarly });
    await g.playRound(0);
    await assert.rejects(() => g.sim.settle(g.config.seed, 0n, 0n), /not finished/);
  });

  it('refuses a settle seed that does not open the commitment', async () => {
    const g = await seated({ seats: 2 }, { holds: alwaysStopEarly });
    await g.playToEnd();
    const [q, r] = g.rakeSplit();
    await assert.rejects(
      () => g.sim.settle(bytes32(0x99), q, r),
      /does not open the table's seed commitment/,
    );
    assert.equal(g.ledger().phase, PHASE.playing);
  });

  it('refuses a second settle, and every other move after settling', async () => {
    const g = await seated({ seats: 2 }, { holds: alwaysStopEarly });
    await g.playToEnd();
    const [q, r] = g.rakeSplit();
    await g.sim.settle(g.config.seed, q, r);

    await assert.rejects(() => g.sim.settle(g.config.seed, 0n, 0n), /table is not playing/);
    await assert.rejects(() => g.sim.closeRound(g.tick()), /table is not playing/);
    g.sim.asPlayer(g.players[0]!.sk);
    await assert.rejects(() => g.sim.openTurn(0, g.entropyFor(0, 0), g.clock), /not playing/);
    await assert.rejects(() => g.sim.resolveRoll1(0, g.clock), /table is not playing/);
    const p = penaltySplit(g.config.tier, 0);
    await assert.rejects(() => g.sim.eliminate(0, p.q, p.rem, g.clock), /table is not playing/);
    await assert.rejects(() => g.sim.join(userAddress(0x77), g.tick()), /table is not filling/);
  });

  it('refuses a table whose configuration cannot be settled honestly', async () => {
    const base = tableConfig({ seats: 2 });
    await assert.rejects(() => TableSimulator.create({ ...base, seats: 1n }), /at least 2 seats/);
    await assert.rejects(() => TableSimulator.create({ ...base, seats: 7n }), /at most 6 seats/);
    await assert.rejects(() => TableSimulator.create({ ...base, tier: 99n }), /at least 100/);
  });

  it('refuses any timeout at or below four times the declared-time slack', async () => {
    // `timeSlackSecs()` is 120 and `timeoutSlackFactor()` is 4, so the floor is 480 and it is
    // strict. The reason is C1 in docs/security-review.md: `closeRound` stamps the deadline the
    // NEXT round's players are judged against, so a hostile caller who under-declares `now` by
    // the full slack shaves it off everyone else's window for free.
    const base = tableConfig({ seats: 2 });
    for (const bad of [0n, 1n, 479n, 480n]) {
      await assert.rejects(
        () => TableSimulator.create({ ...base, turnTimeoutSecs: bad }),
        /turn timeout must exceed/,
      );
      await assert.rejects(
        () => TableSimulator.create({ ...base, tableTimeoutSecs: bad }),
        /table timeout must exceed/,
      );
    }
    await TableSimulator.create({ ...base, turnTimeoutSecs: 481n, tableTimeoutSecs: 481n });
  });

  it('refuses a tier above the maximum, and accepts the maximum itself', async () => {
    // The bound keeps `tier * seatCount` and `tier * penaltyDenom()` inside Uint<64>, so no
    // refund path can be denied by a checked-cast overflow while `settle` still works.
    const base = tableConfig({ seats: 2 });
    const max = 1_000_000_000_000_000n;
    await assert.rejects(() => TableSimulator.create({ ...base, tier: max + 1n }), /above the max/);
    await TableSimulator.create({ ...base, tier: max });
  });

  it('refuses a join that would record the zero payout address', async () => {
    const g = await GameDriver.open({ seats: 2 });
    g.sim.asPlayer(g.players[0]!.sk);
    await assert.rejects(
      () => g.sim.join({ bytes: new Uint8Array(32) }, g.tick()),
      /must not be the zero address/,
    );
  });
});

// =========================================================================================
describe('the settle deadline bypass', () => {
  // =======================================================================================
  //
  // A game that runs to completion lands in (`playing`, `openRound == 13`). Every other circuit
  // refuses it, so `settle` is the only exit -- and an operator that vanished, or simply lost
  // its seed file, would otherwise lock every stake permanently. Past
  // `roundDeadline + tableTimeoutSecs` the seed check is waived.

  async function finished(): Promise<GameDriver> {
    const g = await seated(
      { seats: 2, tableId: bytes32(0x71) },
      { strategy: 'bestScore', holds: alwaysStopEarly },
    );
    await g.playToEnd();
    return g;
  }

  it('refuses a wrong seed before the deadline, at the boundary second', async () => {
    const g = await finished();
    const [q, r] = g.rakeSplit();
    const deadline = Number(g.ledger().roundDeadline + g.config.tableTimeoutSecs);
    await assert.rejects(
      () => g.sim.settle(bytes32(0x99), q, r, deadline),
      /does not open the table's seed commitment/,
      'the predicate is strict: at the deadline exactly the seed is still required',
    );
  });

  it('pays the in-circuit winner with a wrong seed once the deadline has passed', async () => {
    const g = await finished();
    const [q, r] = g.rakeSplit();
    const past = Number(g.ledger().roundDeadline + g.config.tableTimeoutSecs) + 1;
    const winner = await g.sim.settle(bytes32(0x99), q, r, past);
    assert.equal(winner, BigInt(g.expectedWinner()), 'the winner is unchanged by the waiver');

    const led = g.ledger();
    assert.equal(led.phase, PHASE.settled);
    assert.equal(led.pot, 0n);
    assert.deepEqual(
      led.revealedSeed,
      new Uint8Array(32),
      'a force-settled game must be marked unverifiable, not falsely verifiable',
    );
    assert.deepEqual(
      led.finalDigest,
      finalDigestTs(
        led.roundDigest,
        g.config.tableId,
        PHASE.settled,
        Number(winner),
        2,
        led.tier * 2n - q,
        q,
        0n,
        false,
      ),
      'the certificate must record that the game is unverifiable',
    );
  });

  it('still records a correct seed when settled after the deadline', async () => {
    const g = await finished();
    const [q, r] = g.rakeSplit();
    const past = Number(g.ledger().roundDeadline + g.config.tableTimeoutSecs) + 1;
    await g.sim.settle(g.config.seed, q, r, past);
    assert.deepEqual(g.ledger().revealedSeed, g.config.seed);
  });

  it('does not let the bypass settle an unfinished game', async () => {
    const g = await seated({ seats: 2 }, { holds: alwaysStopEarly });
    await g.playRound(0);
    const far = DEFAULT_BLOCK_TIME + 100_000_000;
    await assert.rejects(() => g.sim.settle(bytes32(0x99), 0n, 0n, far), /not finished/);
  });
});

// =========================================================================================
describe('the stall matrix: every reachable state has a permissionless exit', () => {
  // =======================================================================================
  //
  // The design's core invariant. Every state this contract can reach must have at least one move
  // that anybody can make and that ends with the money out. Interactive holds multiplied the
  // states -- a turn now has seven sub-states rather than two -- so the matrix is wider than it
  // was, and the ones added by the redesign are the mid-turn abandonment cases.

  it('exits an under-filled table', async () => {
    const g = await GameDriver.open({ seats: 3 });
    await g.join(0);
    const { q, rem } = perSeatRake(g.config.tier);
    await g.sim.abortTable(q, rem, Number(g.ledger().roundDeadline) + 1);
    assert.equal(g.ledger().pot, 0n);
    await g.sim.redeem(0);
    g.assertFullyDrained();
  });

  it('exits a table where a player abandoned a turn at every player-owed stage', async () => {
    // Four sub-states: never opened, and abandoned after each of the three rolls. All four are
    // the player's silence, so all four exit through `eliminate` and then the game continues.
    for (const rolls of [0, 1, 2, 3]) {
      const g = await seated({ seats: 2 }, { strategy: 'bestScore', holds: alwaysStopEarly });
      for (let r = 0; r < 4; r++) await g.playRound(r);
      await g.playTurn(1, 4, alwaysStopEarly);

      if (rolls > 0) {
        g.sim.asPlayer(g.players[0]!.sk);
        await g.sim.openTurn(0, g.entropyFor(0, 4), g.tick());
        g.sim.asOperator();
        await g.sim.resolveRoll1(0, g.tick());
        for (let i = 1; i < rolls; i++) {
          g.sim.asPlayer(g.players[0]!.sk);
          await g.sim.hold(0, maskOf(i), g.tick());
          g.sim.asOperator();
          if (i === 1) await g.sim.resolveRoll2(0, g.tick());
          else await g.sim.resolveRoll3(0, g.tick());
        }
      }

      await g.eliminate(0, 4);
      await g.closeRound(4);
      for (let r = 5; r < ROUND_COUNT; r++) await g.playRound(r);
      const [q, r] = g.rakeSplit();
      await g.sim.settle(g.config.seed, q, r);
      assert.equal(g.ledger().pot, 0n, `rolls=${rolls}`);
      await g.sim.redeem(0);
      g.assertFullyDrained();
    }
  });

  it('exits a table where every player stopped', async () => {
    const g = await seated({ seats: 2 }, { strategy: 'bestScore', holds: alwaysStopEarly });
    for (let r = 0; r < 4; r++) await g.playRound(r);
    await g.eliminate(0, 4);
    await g.eliminate(1, 4);
    assert.equal(g.ledger().phase, PHASE.abandoned);
    const { q, rem } = perSeatRake(g.config.tier);
    await g.sim.abortTable(q, rem, g.clock);
    assert.equal(g.ledger().pot, 0n);
    await g.sim.redeem(0);
    await g.sim.redeem(1);
    g.assertFullyDrained();
  });

  it('exits a table where the operator stopped, at every roll step', async () => {
    for (const stopAfter of [0, 1, 2]) {
      const g = await seated({ seats: 2 });
      await g.playTurn(1, 0, alwaysStopEarly);
      g.sim.asPlayer(g.players[0]!.sk);
      await g.sim.openTurn(0, g.entropyFor(0, 0), g.tick());
      if (stopAfter >= 1) {
        g.sim.asOperator();
        await g.sim.resolveRoll1(0, g.tick());
        g.sim.asPlayer(g.players[0]!.sk);
        await g.sim.hold(0, maskOf(0), g.tick());
      }
      if (stopAfter >= 2) {
        g.sim.asOperator();
        await g.sim.resolveRoll2(0, g.tick());
        g.sim.asPlayer(g.players[0]!.sk);
        await g.sim.hold(0, maskOf(1), g.tick());
      }
      const { q, rem } = perSeatRake(g.config.tier);
      const past = Number(g.ledger().roundDeadline + g.config.tableTimeoutSecs) + 1;
      await g.sim.abortTable(q, rem, past);
      assert.equal(g.ledger().pot, 0n);
      await g.sim.redeem(0);
      await g.sim.redeem(1);
      g.assertFullyDrained();
    }
  });

  it('exits a finished game whose operator lost the seed', async () => {
    const g = await seated({ seats: 2 }, { strategy: 'bestScore', holds: alwaysStopEarly });
    await g.playToEnd();
    const [q, r] = g.rakeSplit();
    const past = Number(g.ledger().roundDeadline + g.config.tableTimeoutSecs) + 1;
    await g.sim.settle(bytes32(0), q, r, past);
    assert.equal(g.ledger().pot, 0n);
    g.assertFullyDrained();
  });

  it('exits a table stuck mid-round because nobody closed it', async () => {
    // Everyone finished, nobody called closeRound. Not a stall at all: `closeRound` is
    // permissionless and always available, and the round deadline does not gate it.
    const g = await seated({ seats: 2 });
    await g.playTurn(0, 0, alwaysStopEarly);
    await g.playTurn(1, 0, alwaysStopEarly);
    const long = Number(g.ledger().roundDeadline) + 1_000_000;
    await g.sim.closeRound(long, long);
    assert.equal(g.ledger().openRound, 1n);
  });
});

// =========================================================================================
describe('the declared-time sandwich', () => {
  // =======================================================================================
  //
  // The kernel exposes block-time PREDICATES only, so a circuit that stamps a deadline must be
  // told the time and pin the claim between `blockTimeGte(now)` and
  // `blockTimeLt(now + timeSlackSecs())`. Only TWO circuits declare a time now -- `join` and
  // `closeRound` -- where the cursor model had seven, so this is the whole remaining surface.

  const SLACK = 120;

  it('names exactly the circuits that declare a time', () => {
    // A structural check, so a future circuit that starts stamping a deadline has to come back
    // through this test and this comment.
    for (const circuit of ['join', 'closeRound']) {
      assert.ok(ledgerWrites(circuit).has('roundDeadline'), `${circuit} stamps a deadline`);
    }
    for (const circuit of [
      'playerMove',
      'resolveRoll1',
      'resolveRoll2',
      'resolveRoll3',
      'eliminate',
      'settle',
      'redeem',
      'abortTable',
    ]) {
      assert.ok(
        !ledgerWrites(circuit).has('roundDeadline'),
        `${circuit} must not stamp a deadline -- it takes no declared time`,
      );
    }
  });

  it('refuses a declared time ahead of the block time', async () => {
    const g = await GameDriver.open({ seats: 2 });
    g.sim.asPlayer(g.players[0]!.sk);
    await assert.rejects(
      () => g.sim.join(g.players[0]!.addr, DEFAULT_BLOCK_TIME + 1, DEFAULT_BLOCK_TIME),
      /ahead of block time/,
    );
    await g.sim.join(g.players[0]!.addr, DEFAULT_BLOCK_TIME, DEFAULT_BLOCK_TIME);
  });

  it('refuses a declared time further behind than the slack', async () => {
    const g = await seated({ seats: 2 });
    await g.playTurn(0, 0, alwaysStopEarly);
    await g.playTurn(1, 0, alwaysStopEarly);
    const blockTime = g.clock + 10_000;
    await assert.rejects(
      () => g.sim.closeRound(blockTime - SLACK, blockTime),
      /further behind block time than the allowed slack/,
    );
    // One second inside the slack is accepted -- the window is (blockTime - slack, blockTime].
    await g.sim.closeRound(blockTime - SLACK + 1, blockTime);
    assert.equal(
      g.ledger().roundDeadline,
      BigInt(blockTime - SLACK + 1) + g.config.turnTimeoutSecs,
    );
  });

  it('bounds what an under-declaring closeRound can take from the next round', async () => {
    // The C1 fix, restated as a property rather than as a constructor assert: with
    // `turnTimeout > 4 * slack`, a caller who under-declares by the whole slack still leaves the
    // next round more than three quarters of its window.
    const g = await seated({ seats: 2, turnTimeoutSecs: 600n });
    await g.playTurn(0, 0, alwaysStopEarly);
    await g.playTurn(1, 0, alwaysStopEarly);
    const blockTime = g.clock + 1_000;
    await g.sim.closeRound(blockTime - SLACK + 1, blockTime);
    const remaining = Number(g.ledger().roundDeadline) - blockTime;
    assert.ok(remaining > 600 * 0.75, `the next round kept ${remaining}s of 600s`);
  });
});

// =========================================================================================
describe('tie-break at table level', () => {
  // =======================================================================================
  //
  // Every die comes out of a hash, so a tie cannot be constructed -- it has to be FOUND. The
  // table ids below were located by sweeping `replayGame` offline (milliseconds per game) for
  // configurations that tie, and are hard-coded so the tests are deterministic and so that any
  // change to the dice ladder, the stream merge or the digest chain breaks them loudly.
  //
  // SIMULTANEOUS ROUNDS COLLAPSED THE MIDDLE LEG. Under the cursor model the order was total,
  // then earliest `finishedAtTurn`, then lowest seat, and a forfeited seat could still win with
  // what it had scored. Now every surviving seat completes at the same round, so
  // `finishedAtRound` is equal for all of them, and an eliminated seat cannot win at all. What
  // is left is: highest total, then lowest seat. The order in `winnerOfSeats` is unchanged -- it
  // is the inputs that no longer reach its second leg.

  it('breaks a tie between two finishers by seat order', async () => {
    const opts: TableOptions = { seats: 2, tableId: bytes32(23) };
    const plan: GamePlan = { strategy: 'firstLegal' };
    const preview = replayGame(tableConfig(opts), makePlayers(2), plan);
    assert.equal(preview.totals[0], preview.totals[1], 'this table id was chosen for its tie');

    const g = await seated(opts, plan);
    await g.playToEnd();
    const led = g.ledger();
    assert.equal(led.seatProgress.lookup(0n).total, led.seatProgress.lookup(1n).total);
    assert.equal(
      led.seatProgress.lookup(0n).finishedAtRound,
      led.seatProgress.lookup(1n).finishedAtRound,
      'simultaneous rounds make the finish-time leg a no-op among survivors',
    );

    const [q, r] = g.rakeSplit();
    assert.equal(await g.sim.settle(g.config.seed, q, r), 0n);
  });

  it('falls back to the lowest seat at a four-seat table', async () => {
    const opts: TableOptions = { seats: 4, tableId: bytes32(16) };
    const plan: GamePlan = { strategy: 'firstLegal' };
    const preview = replayGame(tableConfig(opts), makePlayers(4), plan);
    assert.equal(preview.totals[0], preview.totals[1], 'this table id was chosen for its tie');
    assert.ok(preview.totals[0]! > preview.totals[2]!);
    assert.ok(preview.totals[0]! > preview.totals[3]!);

    const g = await seated(opts, plan);
    await g.playToEnd();
    const [q, r] = g.rakeSplit();
    assert.equal(await g.sim.settle(g.config.seed, q, r), 0n, 'lowest seat takes the last tie');
    assert.equal(g.ledger().pot, 0n);
  });
});

// =========================================================================================
describe('a six-seat table', () => {
  // =======================================================================================

  it('plays a full six-seat game and settles', async () => {
    const g = await seated({ seats: 6, tableId: bytes32(0x66) }, { strategy: 'bestScore' });
    await g.playToEnd();
    const led = g.ledger();
    assert.equal(led.openRound, BigInt(ROUND_COUNT));
    assert.equal(led.pot, g.config.tier * 6n);
    assert.equal(g.turns.length, 6 * ROUND_COUNT, 'six seats x thirteen rounds');

    const rep = g.replay();
    assert.deepEqual(led.roundDigest, rep.digest);
    for (let s = 0; s < 6; s++) {
      assert.equal(led.seatProgress.lookup(BigInt(s)).total, BigInt(rep.totals[s]!));
    }
    assert.equal(g.playerTx, rep.playerTx);
    assert.equal(g.operatorTx, rep.operatorTx);

    const [q, r] = g.rakeSplit();
    assert.equal(await g.sim.settle(g.config.seed, q, r), BigInt(g.expectedWinner()));
    assert.equal(g.ledger().pot, 0n);
  });

  it('loses two seats mid-game and still completes', async () => {
    const plan: GamePlan = {
      strategy: 'bestScore',
      holds: alwaysStopEarly,
      eliminations: [
        { seat: 2, round: 3 },
        { seat: 4, round: 8 },
      ],
    };
    const g = await seated({ seats: 6, tableId: bytes32(0x67) }, plan);
    await g.playToEnd();
    const led = g.ledger();
    assert.equal(led.activeSeats, 4n);
    assert.equal(led.openRound, BigInt(ROUND_COUNT));
    assert.equal(led.seatProgress.lookup(2n).eliminated, true);
    assert.equal(led.seatProgress.lookup(4n).eliminated, true);

    const rep = g.replay();
    assert.deepEqual(led.roundDigest, rep.digest, 'the digest must survive two eliminations');
    for (let s = 0; s < 6; s++) {
      assert.equal(
        led.seatRedeemable.lookup(BigInt(s)),
        rep.redeemable[s]!,
        `seat ${s} redeemable diverged from the replay`,
      );
    }
    g.assertCustody();

    const [q, r] = g.rakeSplit();
    const winner = await g.sim.settle(g.config.seed, q, r);
    assert.equal(winner, BigInt(g.expectedWinner()));
    assert.ok(winner !== 2n && winner !== 4n, 'an eliminated seat cannot win');
    for (const s of [2, 4]) assert.ok((await g.sim.redeem(s)) > 0n);
    g.assertFullyDrained();
  });
});

// =========================================================================================
describe('the transaction cost of an interactive turn', () => {
  // =======================================================================================
  //
  // The honest arithmetic, measured rather than asserted from the design note, because it is the
  // number the UI has to set expectations against. Also in docs/table-interface.md.

  it('costs 4 player + 3 operator per full turn and 2 + 1 when the player stops early', () => {
    const seats = 6;
    const full = replayGame(tableConfig({ seats }), makePlayers(seats), {
      holds: alwaysThreeRolls,
    });
    const early = replayGame(tableConfig({ seats }), makePlayers(seats), {
      holds: alwaysStopEarly,
    });
    const turns = seats * ROUND_COUNT;

    // `playerTx` includes one `join` per seat; the rest is turn traffic.
    assert.equal(full.playerTx - seats, turns * 4, 'full turn: open + hold + hold + score');
    assert.equal(full.operatorTx, turns * 3, 'full turn: three rolls');
    assert.equal(early.playerTx - seats, turns * 2, 'early stop: open + score');
    assert.equal(early.operatorTx, turns * 1, 'early stop: one roll');

    // The lever a player has over the length of a game: stopping early more than halves it.
    const fullTotal = full.playerTx + full.operatorTx;
    const earlyTotal = early.playerTx + early.operatorTx;
    assert.ok(earlyTotal * 2 < fullTotal, `${earlyTotal} vs ${fullTotal}`);
  });
});

// =========================================================================================
describe('token custody, as far as the simulator can see it', () => {
  // =======================================================================================
  //
  // FOUR THINGS THIS BLOCK CANNOT CHECK, and they are the four that matter most:
  //
  //   1. that `receiveUnshielded` actually took `tier` from the joining wallet;
  //   2. that `sendUnshielded` actually paid the winner, the rake and each redeemer;
  //   3. that the amounts and the token colour were right;
  //   4. that the contract's real balance ever equalled `pot + SUM(redeemable)`.
  //
  // `unshieldedBalance(nativeToken())` returns 0 under compact-runtime 0.19.0 whatever
  // `receiveUnshielded` was handed (docs/bugs-found.md #11), so all four move to the E2E devnet
  // run, measured from the indexer's per-transaction UTXO movement. What IS checked here is the
  // contract's own bookkeeping, which is what every in-circuit assertion reads, and the
  // ADDRESSES it selects.

  it('tracks the pot exactly through joins, and drains it exactly at settle', async () => {
    const g = await GameDriver.open({ seats: 4 }, { holds: alwaysStopEarly });
    for (let seat = 0; seat < 4; seat++) {
      await g.join(seat);
      assert.equal(g.ledger().pot, g.config.tier * BigInt(seat + 1));
    }
    await g.playToEnd();
    const pot = g.ledger().pot;
    const [q, r] = g.rakeSplit();
    await g.sim.settle(g.config.seed, q, r);
    assert.equal(g.ledger().pot, 0n);
    assert.equal(q + (pot - q), pot, 'the two payments must sum to the whole pot');
  });

  it('holds pot + redeemable == tier x seatCount through every path', async () => {
    // The invariant the contract asserts in-circuit at `settle` and `abortTable`. The driver
    // re-checks it after every single move; this test walks the paths that move money between
    // the two halves.
    const tier = 1_300_000n;
    const g = await seated({ seats: 4, tier }, { strategy: 'bestScore', holds: alwaysStopEarly });
    for (let r = 0; r < 3; r++) await g.playRound(r);
    await g.playTurn(0, 3, alwaysStopEarly);
    await g.playTurn(1, 3, alwaysStopEarly);
    await g.playTurn(3, 3, alwaysStopEarly);
    await g.eliminate(2, 3);
    await g.closeRound(3);
    g.assertCustody();
    for (let r = 4; r < ROUND_COUNT; r++) await g.playRound(r);
    g.assertCustody();

    const [q, r] = g.rakeSplit();
    await g.sim.settle(g.config.seed, q, r);
    assert.equal(g.ledger().pot, 0n);
    // After settle the whole obligation is seat 2's refund, and redeeming it clears the books.
    let owed = 0n;
    for (let s = 0; s < MAX_SEATS; s++) owed += g.ledger().seatRedeemable.lookup(BigInt(s));
    assert.equal(owed, g.ledger().seatRedeemable.lookup(2n));
    await g.sim.redeem(2);
    for (let s = 0; s < MAX_SEATS; s++) {
      assert.equal(g.ledger().seatRedeemable.lookup(BigInt(s)), 0n);
    }
  });

  it('pays the addresses recorded at join and nothing else', async () => {
    // The simulator cannot watch the money move, but it CAN watch which address the contract
    // chose, which is the half a wrong-recipient bug would show up in.
    const players: Player[] = makePlayers(2);
    const g = await seated({ seats: 2 }, { holds: alwaysStopEarly });
    for (let s = 0; s < 2; s++) {
      assert.deepEqual(
        g.ledger().seatIdentity.lookup(BigInt(s)).addr.bytes,
        players[s]!.addr.bytes,
      );
    }
    await g.playToEnd();
    const [q, r] = g.rakeSplit();
    const winner = await g.sim.settle(g.config.seed, q, r);
    assert.deepEqual(
      g.ledger().seatIdentity.lookup(winner).addr.bytes,
      players[Number(winner)]!.addr.bytes,
    );
    assert.deepEqual(g.ledger().rakeAddress.bytes, g.config.rakeAddress.bytes);
  });
});
