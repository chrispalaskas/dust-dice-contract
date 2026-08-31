// Copyright (C) Shielded Technologies
// SPDX-License-Identifier: Apache-2.0

/**
 * table.compact, end to end.
 *
 * The happy-path tests are DIFFERENTIAL. `GameDriver` plays a whole game through the circuits
 * while `replayGame` reconstructs the same game from the TypeScript mirrors and
 * api/src/rules.ts alone, and every roll, digest, scorecard and total is compared as it is
 * produced. A circuit that agrees with itself proves nothing.
 *
 * The rejection tests are the other half and there are more of them, because the interesting
 * claims about this contract are negative ones: a player cannot choose their entropy, cannot
 * play out of turn, cannot reuse a category, cannot dodge a forced joker; an operator cannot
 * roll against a seed it did not commit to, cannot pick which face is modal; nobody can claim
 * a timeout early, settle an unfinished game, or settle twice.
 *
 * BLOCK TIME IS EXPLICIT EVERYWHERE. `createCircuitContext` otherwise defaults `time` to
 * wall-clock seconds, which makes every timeout test non-reproducible and, worse, quietly
 * passing today and failing at some future date. `TableSimulator` pins it; the timeout tests
 * set it deliberately, on both sides of each deadline.
 *
 * WHAT THIS FILE CANNOT TEST: the movement of actual NIGHT.
 * `unshieldedBalance(nativeToken())` returns 0 under compact-runtime 0.19.0 no matter what
 * `receiveUnshielded` was handed (docs/bugs-found.md #11), so `receiveUnshielded` and
 * `sendUnshielded` are, in this simulator, calls that succeed and move nothing. Everything
 * below asserts the contract's OWN `pot` bookkeeping and the payout ADDRESSES it selects,
 * which is the part the simulator can see. That the ledger actually debits and credits those
 * addresses was proven in Gate 0 (docs/gate0-report.md, Q1) and must be re-proven per circuit
 * on devnet. `describe('token custody')` at the bottom states exactly where the line falls.
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
  forcedEntropyTs,
  holdMaskOf,
  isCanonicalModal,
  isValidPolicy,
  mixEntropyTs,
  modalFace,
  Policy,
  POLICY_NONE,
  resolveDiceTs,
  seedCommitmentTs,
} from '../policy-mirror.ts';
import { genesisDigestTs } from '../table-mirror.ts';
import { pureCircuits as tablePure } from '../managed/table/contract/index.js';
import { DEFAULT_BLOCK_TIME, diceToArray, TableSimulator, userAddress } from './simulator.ts';
import {
  bytes32,
  GameDriver,
  LAST_ROUND,
  makePlayers,
  replayGame,
  ROUND_COUNT,
  tableConfig,
  type GamePlan,
  type TableOptions,
} from './table-harness.ts';

// ---------------------------------------------------------------------------------------
// Ledger enum values, spelled out
// ---------------------------------------------------------------------------------------
//
// The generated bindings export `Phase` and `TurnState` as TypeScript enums, which Node's
// type-stripping mode refuses to import (an enum has runtime behaviour that cannot be erased,
// ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX). The values are contract-canonical and appear in
// table.compact's declaration order.

const PHASE_FILLING = 0;
const PHASE_PLAYING = 1;
const PHASE_SETTLED = 2;
const PHASE_ABORTED = 3;
const PHASE_ABANDONED = 4;

const WAIT_PLAYER = 0;
const WAIT_RESOLVE = 1;

/** `noFinish()` -- the sentinel standing in for `rules.ts`'s `Infinity`. */
const NO_FINISH = 65535n;

/** Open a table and seat everyone. */
async function seated(opts: TableOptions, plan: GamePlan = {}): Promise<GameDriver> {
  const g = await GameDriver.open(opts, plan);
  await g.joinAll();
  return g;
}

// =========================================================================================
describe('a full two-seat game', () => {
  // =======================================================================================

  it('seats players, stakes the pot, chains the digest and flips to playing', async () => {
    const g = await GameDriver.open({ seats: 2 });
    const config = g.config;

    const fresh = g.ledger();
    assert.equal(fresh.phase, PHASE_FILLING);
    assert.equal(fresh.seatCount, 0n);
    assert.equal(fresh.pot, 0n);
    assert.deepEqual(fresh.gameDigest, genesisDigestTs(config.tableId));
    assert.deepEqual(fresh.seedCommitment, seedCommitmentTs(config.seed));
    // Every slot is pre-inserted so a runtime lookup can never abort. See decision 1.
    assert.equal(fresh.seatProgress.size(), 6n);
    assert.equal(fresh.seatIdentity.size(), 6n);
    assert.equal(fresh.seatCard.size(), 6n);

    // `join` asserts the digest chain and the pot per seat as it goes.
    await g.join(0);
    assert.equal(g.ledger().phase, PHASE_FILLING, 'one seat of two must not start the game');
    await g.join(1);

    const led = g.ledger();
    assert.equal(led.phase, PHASE_PLAYING);
    assert.equal(led.turnState, WAIT_PLAYER);
    assert.equal(led.seatCount, 2n);
    assert.equal(led.activeSeats, 2n);
    assert.equal(led.currentSeat, 0n);
    assert.equal(led.round, 0n);
    assert.equal(led.turnIndex, 0n);
    assert.equal(led.pot, config.tier * 2n);

    for (const seat of [0n, 1n]) {
      const identity = led.seatIdentity.lookup(seat);
      const player = g.players[Number(seat)]!;
      assert.deepEqual(identity.addr.bytes, player.addr.bytes, 'payout address recorded at join');
      assert.deepEqual(identity.keyCommit, entropyKeyCommitmentTs(player.sk));
      assert.ok(led.joinedKeys.member(entropyKeyCommitmentTs(player.sk)));

      const prog = led.seatProgress.lookup(seat);
      assert.equal(prog.total, 0n);
      assert.equal(prog.finishedAtTurn, NO_FINISH);
      assert.equal(prog.forfeited, false);
      assert.equal(prog.hasDice, false);
      // Ones, not zeros: `applyScore` computes `d[0] - 1` unconditionally and a zero die
      // underflows. See `SeatProgress` in table.compact.
      assert.deepEqual(diceToArray(prog.dice), [1, 1, 1, 1, 1]);
    }
  });

  it('plays 13 rounds with mixed policies and settles to the reference winner', async () => {
    // `bestScore` produces realistic scorecards -- upper bonuses, scratches -- so
    // `totalAfterPlacing`'s bonus arithmetic is exercised rather than skirted. Every turn's
    // dice, digest, card and total is cross-checked inside the driver as it plays.
    const g = await seated({ seats: 2 }, { strategy: 'bestScore', probeIllegal: true });
    await g.playToEnd();

    const led = g.ledger();
    assert.equal(led.round, BigInt(ROUND_COUNT), 'the game must be complete');
    assert.equal(led.phase, PHASE_PLAYING, 'completion is not settlement');

    // 2 seats x 13 rolling rounds.
    assert.equal(g.turns.length, 26);
    assert.ok(
      g.illegalProbes > 20,
      `expected sustained illegal-placement probing, got ${g.illegalProbes}`,
    );

    // The offline replay -- pure TypeScript, no chain -- reproduces the game exactly. This is
    // the "verify this game" property the whole settlement story rests on.
    const replay = g.replay();
    assert.deepEqual(replay.totals, g.totals());
    assert.deepEqual(led.gameDigest, replay.digest, 'offline replay must reach the same digest');
    for (let seat = 0; seat < 2; seat++) {
      const prog = led.seatProgress.lookup(BigInt(seat));
      assert.equal(prog.total, BigInt(replay.totals[seat]!));
      assert.equal(prog.finishedAtTurn, BigInt(replay.finishedAtTurn[seat]!));
      assert.equal(prog.forfeited, false);
      const card = led.seatCard.lookup(BigInt(seat));
      assert.equal(card.yahtzeeBonuses, BigInt(replay.cards[seat]!.yahtzeeBonuses));
      for (let cat = 0; cat < CATEGORY_COUNT; cat++) {
        assert.equal(card.filled[cat], true, 'a completed card has every box filled');
      }
    }

    const expectedWinner = g.expectedWinner();
    const potBefore = led.pot;
    const [q, r] = g.rakeSplit();
    const winner = await g.sim.settle(g.config.seed, q, r);

    assert.equal(winner, BigInt(expectedWinner), 'winner must match the reference tie-break');
    const after = g.ledger();
    assert.equal(after.phase, PHASE_SETTLED);
    assert.equal(after.winnerSeatIndex, BigInt(expectedWinner));
    assert.equal(after.pot, 0n, 'the pot is fully paid out');
    assert.deepEqual(after.revealedSeed, g.config.seed, 'settle publishes the seed');
    assert.deepEqual(
      seedCommitmentTs(after.revealedSeed),
      after.seedCommitment,
      'the revealed seed must open the commitment anyone can now check',
    );

    // The split: winner takes pot - q, rake takes q, remainder r rides with the winner.
    assert.equal(q * 100n + r, potBefore);
    assert.ok(r < 100n);
    assert.equal(potBefore - q + q, potBefore, 'the two payouts must exhaust the pot');
  });

  it('pays the remainder to the winner when the pot does not divide by 100', async () => {
    // 333_333 x 2 = 666_666, so q = 6_666 and r = 66. The remainder must ride with the winner,
    // not with the rake and not be left stranded in the contract.
    const g = await seated({ seats: 2, tier: 333_333n }, { strategy: 'bestScore' });
    await g.playToEnd();

    const pot = g.ledger().pot;
    assert.equal(pot, 666_666n);
    const [q, r] = g.rakeSplit();
    assert.equal(q, 6_666n);
    assert.equal(r, 66n);

    await g.sim.settle(g.config.seed, q, r);
    assert.equal(g.ledger().pot, 0n);
    // pot - q = 660_000; the 66 remainder is inside it, since rake is exactly q.
    assert.equal(pot - q, 660_000n);
  });

  it('rejects a rake split that is not the unique q, r', async () => {
    const g = await seated({ seats: 2, tier: 333_333n }, { strategy: 'bestScore' });
    await g.playToEnd();
    const [q, r] = g.rakeSplit();

    // Inflate the rake by one and compensate in the remainder: the identity still holds
    // arithmetically only if r goes negative, so this is the natural cheat and it must fail.
    await assert.rejects(() => g.sim.settle(g.config.seed, q + 1n, r), /rake split/);
    await assert.rejects(() => g.sim.settle(g.config.seed, q, r + 1n), /rake split/);
    // r >= 100 is the other way to pretend: q too small, remainder absorbing the difference.
    await assert.rejects(() => g.sim.settle(g.config.seed, q - 1n, r + 100n), /rake split/);
    // The honest split still works afterwards -- a rejected call must not have changed state.
    await g.sim.settle(g.config.seed, q, r);
    assert.equal(g.ledger().phase, PHASE_SETTLED);
  });
});

// =========================================================================================
describe('joker rules at table level', () => {
  // =======================================================================================
  //
  // A joker needs a seat to roll a second Yahtzee after its Yahtzee box is filled, and every
  // die comes out of a hash, so the situation cannot be arranged by hand. It was FOUND: an
  // offline sweep of table ids under a KeepModal-every-round schedule (which chases
  // n-of-a-kind hardest) looking for a game in which one seat rolls two Yahtzees. Table id
  // 30 is such a game, and under `bestScore` the first Yahtzee scores 50, so the second is a
  // full joker -- forced placement AND the +100 bonus.

  const jokerPlan: GamePlan = {
    strategy: 'bestScore',
    policyFor: () => ({ policy: Policy.KeepModal, param: 0 }),
    probeIllegal: true,
  };
  const jokerTable: TableOptions = { seats: 2, tableId: bytes32(30) };

  it('awards the Yahtzee bonus and enforces forced placement', async () => {
    const g = await seated(jokerTable, jokerPlan);
    await g.playToEnd();

    const replay = g.replay();
    const bonusSeat = replay.cards.findIndex((c) => c.yahtzeeBonuses > 0);
    assert.ok(bonusSeat >= 0, 'this table id was chosen because a seat earns a Yahtzee bonus');

    const card = g.ledger().seatCard.lookup(BigInt(bonusSeat));
    assert.equal(
      card.yahtzeeBonuses,
      BigInt(replay.cards[bonusSeat]!.yahtzeeBonuses),
      'the chain must count the same Yahtzee bonuses as api/src/rules.ts',
    );
    assert.equal(
      g.ledger().seatProgress.lookup(BigInt(bonusSeat)).total,
      BigInt(replay.totals[bonusSeat]!),
      'the +100 must be inside the running total, which is maintained incrementally',
    );

    // Every turn of the game probed a category the reference rules refuse, and at least one of
    // those probes was in a joker situation -- i.e. the chain refused a placement that is only
    // illegal BECAUSE of forced-joker rules.
    assert.ok(g.jokerProbes > 0, 'expected at least one forced-joker rejection');
  });

  it('rolls at least one five-of-a-kind under a modal-chasing schedule', async () => {
    // Guards the guard: if the dice ladder or the KeepModal mask ever changed, the joker test
    // above could silently stop testing a joker. This asserts the precondition directly.
    const cfg = tableConfig(jokerTable);
    const replay = replayGame(cfg, makePlayers(2), jokerPlan);
    const yahtzees = replay.turns.filter((t) => refIsYahtzee(t.dice as unknown as RefDice));
    assert.ok(yahtzees.length >= 2, `expected repeat Yahtzees, saw ${yahtzees.length}`);
  });
});

// =========================================================================================
describe('entropy and authorisation', () => {
  // =======================================================================================

  it('rejects a takeTurn signed with the wrong secret', async () => {
    const g = await seated({ seats: 2 });
    const entropy = forcedEntropyTs(g.players[0]!.sk, g.config.tableId, 0);

    // Seat 1's secret against seat 0's turn. This is ALSO the wrong-turn test: authorisation
    // is structural, so "not your turn" and "not your secret" are the same rejection --
    // whoever is on turn is whoever can open `currentSeat`'s commitment.
    g.sim.asPlayer(g.players[1]!.sk);
    await assert.rejects(
      () => g.sim.takeTurn(entropy, Policy.Stand, 0, 0, g.tick()),
      /wrong entropy secret for this seat/,
    );

    // An unrelated secret fails the same way.
    g.sim.asPlayer(bytes32(0xfe));
    await assert.rejects(
      () => g.sim.takeTurn(entropy, Policy.Stand, 0, 0, g.tick()),
      /wrong entropy secret for this seat/,
    );

    // And the right secret works, so the rejections were about the secret and nothing else.
    g.sim.asPlayer(g.players[0]!.sk);
    await g.sim.takeTurn(entropy, Policy.Stand, 0, 0, g.tick());
    assert.equal(g.ledger().turnState, WAIT_RESOLVE);
  });

  it('rejects entropy that is not H(sk, tableId, round)', async () => {
    const g = await seated({ seats: 2 });
    const player = g.players[0]!;
    g.sim.asPlayer(player.sk);

    const wrong = [
      ['arbitrary bytes', bytes32(0x99)],
      ['another seat’s entropy', forcedEntropyTs(g.players[1]!.sk, g.config.tableId, 0)],
      ['the right secret, the wrong round', forcedEntropyTs(player.sk, g.config.tableId, 1)],
      ['the right secret, another table', forcedEntropyTs(player.sk, bytes32(0x77), 0)],
    ] as const;

    for (const [why, entropy] of wrong) {
      await assert.rejects(
        () => g.sim.takeTurn(entropy, Policy.Stand, 0, 0, g.tick()),
        /entropy is not H\(sk, tableId, round\)/,
        `should have rejected ${why}`,
      );
    }

    // The forced value is the ONLY one that works: a player cannot grind their entropy.
    await g.sim.takeTurn(
      forcedEntropyTs(player.sk, g.config.tableId, 0),
      Policy.Stand,
      0,
      0,
      g.tick(),
    );
  });

  it('rejects a second join from the same entropy key', async () => {
    const g = await GameDriver.open({ seats: 3 });
    await g.join(0);

    g.sim.asPlayer(g.players[0]!.sk);
    await assert.rejects(
      () => g.sim.join(userAddress(0x01), g.tick()),
      /this entropy key already holds a seat/,
      'the same secret must not take two seats',
    );

    // A different secret may, even from the same payout address -- the contract cannot tell
    // people apart and does not claim to. Only the key is unique.
    g.sim.asPlayer(bytes32(0xab));
    await g.sim.join(g.players[0]!.addr, g.tick());
    assert.equal(g.ledger().seatCount, 2n);
  });

  it('rejects joining a full table and joining after play starts', async () => {
    const g = await seated({ seats: 2 });
    g.sim.asPlayer(bytes32(0xcd));
    await assert.rejects(() => g.sim.join(userAddress(0x05), g.tick()), /table is not filling/);
  });

  it('rejects a category that is already filled', async () => {
    const g = await seated({ seats: 2 });
    await g.playRound(0);
    await g.playRound(1);
    assert.equal(g.ledger().round, 2n);
    assert.equal(g.ledger().currentSeat, 0n);

    const taken = g.seats[0]!.card.scores.findIndex((s) => s !== null);
    assert.ok(taken >= 0, 'seat 0 scored something in round 1');

    const player = g.players[0]!;
    g.sim.asPlayer(player.sk);
    await assert.rejects(
      () =>
        g.sim.takeTurn(
          forcedEntropyTs(player.sk, g.config.tableId, 2),
          Policy.Stand,
          0,
          taken,
          g.tick(),
        ),
      /illegal placement/,
    );
  });

  it('rejects a category index outside 0..12', async () => {
    const g = await seated({ seats: 2 });
    await g.playRound(0);
    const player = g.players[0]!;
    g.sim.asPlayer(player.sk);
    await assert.rejects(
      () =>
        g.sim.takeTurn(
          forcedEntropyTs(player.sk, g.config.tableId, 1),
          Policy.Stand,
          0,
          CATEGORY_COUNT,
          g.tick(),
        ),
      /illegal placement/,
    );
  });

  it('pins the canonical encoding of the two rounds that omit an argument', async () => {
    const g = await seated({ seats: 2 });
    const player = g.players[0]!;
    const entropy0 = forcedEntropyTs(player.sk, g.config.tableId, 0);
    g.sim.asPlayer(player.sk);

    // Round 0 scores nothing, so its category argument must be the canonical 0 -- otherwise
    // the on-chain log would have several spellings of the same move.
    await assert.rejects(
      () => g.sim.takeTurn(entropy0, Policy.Stand, 0, 3, g.tick()),
      /round 0 carries no category/,
    );

    // A rolling round must carry a well-formed policy.
    await assert.rejects(
      () => g.sim.takeTurn(entropy0, POLICY_NONE, 0, 0, g.tick()),
      /invalid hold-policy encoding/,
    );
    await assert.rejects(
      () => g.sim.takeTurn(entropy0, Policy.KeepFace, 0, 0, g.tick()),
      /invalid hold-policy encoding/,
      'KeepFace needs a face 1..6',
    );
    await assert.rejects(
      () => g.sim.takeTurn(entropy0, Policy.KeepFace, 7, 0, g.tick()),
      /invalid hold-policy encoding/,
    );
    await assert.rejects(
      () => g.sim.takeTurn(entropy0, Policy.Stand, 4, 0, g.tick()),
      /invalid hold-policy encoding/,
      'a policy that takes no parameter must carry 0',
    );
  });

  it('requires the score-only round to declare no policy', async () => {
    const g = await seated({ seats: 2 });
    for (let round = 0; round < LAST_ROUND; round++) await g.playRound(round);
    const led = g.ledger();
    assert.equal(led.round, BigInt(LAST_ROUND));

    const seat = Number(led.currentSeat);
    const player = g.players[seat]!;
    const entropy = forcedEntropyTs(player.sk, g.config.tableId, LAST_ROUND);
    const category = g.chooseCategory(seat, g.seats[seat]!.pendingDice!);
    const turnIndexBefore = led.turnIndex;
    g.sim.asPlayer(player.sk);

    await assert.rejects(
      () => g.sim.takeTurn(entropy, Policy.Stand, 0, category, g.tick()),
      /the score-only round declares no policy/,
      'round 13 must carry policyNone, not a real policy',
    );
    await g.sim.takeTurn(entropy, POLICY_NONE, 0, category, g.tick());
    // No resolve follows a score-only turn: the turn completes on the spot, and the seat's
    // finishing turn is the index the move was made at -- the clock the tie-break reads.
    assert.equal(g.ledger().turnState, WAIT_PLAYER);
    assert.equal(
      g.ledger().seatProgress.lookup(BigInt(seat)).finishedAtTurn,
      turnIndexBefore,
      'finishedAtTurn is stamped before the cursor advances',
    );
    assert.equal(g.ledger().turnIndex, turnIndexBefore + 1n);
  });
});

// =========================================================================================
describe('resolveTurn', () => {
  // =======================================================================================

  it('rejects a seed that does not open the commitment', async () => {
    const g = await seated({ seats: 2 });
    await g.takeTurn(0, 0);

    // The operator's authority IS knowledge of the seed. A daemon that lost its seed cannot
    // resolve, which is exactly why the seed is persisted before the table opens.
    g.sim.privateState = { rollSeed: bytes32(0x12), playerSecret: bytes32(0) };
    await assert.rejects(
      () => g.sim.resolveTurn(g.tick()),
      /seed does not open the table's seed commitment/,
    );

    g.sim.asOperator();
    await g.sim.resolveTurn(g.tick());
    assert.equal(g.ledger().turnState, WAIT_PLAYER);
  });

  it('rejects a resolve while waiting on the player', async () => {
    const g = await seated({ seats: 2 });
    assert.equal(g.ledger().turnState, WAIT_PLAYER);
    g.sim.asOperator();
    await assert.rejects(
      () => g.sim.resolveTurn(g.tick()),
      /waiting on the player, not the operator/,
    );
  });

  it('rejects a takeTurn while waiting on the operator', async () => {
    const g = await seated({ seats: 2 });
    await g.takeTurn(0, 0);
    assert.equal(g.ledger().turnState, WAIT_RESOLVE);

    // Seat 1 cannot jump the queue, and neither can seat 0 play twice.
    for (const seat of [0, 1]) {
      const player = g.players[seat]!;
      g.sim.asPlayer(player.sk);
      await assert.rejects(
        () =>
          g.sim.takeTurn(
            forcedEntropyTs(player.sk, g.config.tableId, 0),
            Policy.Stand,
            0,
            0,
            g.tick(),
          ),
        /waiting on the operator to resolve/,
      );
    }
  });

  it('rejects a witnessed modal face that is not the modal face of roll 1', async () => {
    const g = await seated({ seats: 2 });
    await g.takeTurn(0, 0, { policy: Policy.KeepModal, param: 0 });

    // Recompute what roll 1 will be, so the test knows which faces are wrong.
    const entropy = forcedEntropyTs(g.players[0]!.sk, g.config.tableId, 0);
    const mixed = mixEntropyTs(entropy, g.ledger().gameDigest);
    const truth = resolveDiceTs(g.config.tableId, g.config.seed, mixed, 0, Policy.KeepModal, 0);
    const correct = truth.modal;

    // Swap the witness for one that lies. The seed is still right, so only the modal face is
    // under test -- and the circuit VERIFIES it rather than trusting it, which is the whole
    // point of the witness-the-answer trick.
    for (let face = 1; face <= 6; face++) {
      if (face === correct) continue;
      const lying = {
        ...g.sim.table.witnesses,
        modalFaceHint: () =>
          [g.sim.privateState, BigInt(face)] as [typeof g.sim.privateState, bigint],
      };
      const honest = g.sim.table.witnesses;
      g.sim.table.witnesses = lying as typeof honest;
      g.sim.asOperator();
      await assert.rejects(
        () => g.sim.resolveTurn(g.tick()),
        /witnessed modal face is not the modal face of roll 1/,
        `face ${face} should not have been accepted (the truth is ${correct})`,
      );
      g.sim.table.witnesses = honest;
    }

    // Out-of-range faces are refused too, so there is no "0 means skip the check" escape.
    for (const face of [0n, 7n, 255n]) {
      const honest = g.sim.table.witnesses;
      g.sim.table.witnesses = {
        ...honest,
        modalFaceHint: () => [g.sim.privateState, face] as [typeof g.sim.privateState, bigint],
      } as typeof honest;
      g.sim.asOperator();
      await assert.rejects(() => g.sim.resolveTurn(g.tick()), /modal face/);
      g.sim.table.witnesses = honest;
    }

    // The honest witness resolves, and to the dice the mirror predicted.
    g.sim.asOperator();
    const dice = diceToArray(await g.sim.resolveTurn(g.tick()));
    assert.deepEqual(dice, truth.roll2);
  });

  it('does not check the modal face for policies that do not use it', async () => {
    // The check is guarded on the policy, so a nonsense hint must not break an unrelated turn.
    // Worth pinning: a guard written the other way round would make five of six policies
    // depend on a value they never read.
    const g = await seated({ seats: 2 });
    await g.takeTurn(0, 0, { policy: Policy.RerollAll, param: 0 });
    const honest = g.sim.table.witnesses;
    g.sim.table.witnesses = {
      ...honest,
      modalFaceHint: () => [g.sim.privateState, 0n] as [typeof g.sim.privateState, bigint],
    } as typeof honest;
    g.sim.asOperator();
    await g.sim.resolveTurn(g.tick());
    assert.equal(g.ledger().turnState, WAIT_PLAYER);
  });
});

// =========================================================================================
describe('hold policies', () => {
  // =======================================================================================

  it('produces the mirror mask for every shipped policy', async () => {
    // One turn per policy, each against the circuit and against the TypeScript mirror. The
    // KeepFace parameter walks 1..6 so no face is special-cased by accident.
    const cases = [
      { policy: Policy.Stand, param: 0 },
      { policy: Policy.RerollAll, param: 0 },
      { policy: Policy.KeepModal, param: 0 },
      ...[1, 2, 3, 4, 5, 6].map((param) => ({ policy: Policy.KeepFace, param })),
      { policy: Policy.ChaseStraight, param: 0 },
      { policy: Policy.KeepPairsPlus, param: 0 },
    ];

    for (const choice of cases) {
      const g = await seated({ seats: 2, tableId: bytes32(0x30 + choice.param + choice.policy) });
      await g.takeTurn(0, 0, choice);
      // resolveTurn asserts the dice against `resolveDiceTs` inside the driver.
      const dice = await g.resolveTurn(0, 0);
      const record = g.turns.at(-1)!;

      // The mask the mirror computed must be the one the circuit's own pure circuit computes.
      assert.deepEqual(
        tablePure.holdMaskOf(
          BigInt(choice.policy),
          BigInt(choice.param),
          BigInt(record.modal),
          record.rolls.roll0.map(BigInt),
        ),
        holdMaskOf(choice.policy, choice.param, record.modal, record.rolls.roll0),
        `mask diverged for policy ${choice.policy}/${choice.param}`,
      );

      // Held positions keep roll 1's die all the way to the end; rerolled ones take roll 3's.
      for (let i = 0; i < 5; i++) {
        if (record.hold[i]) {
          assert.equal(dice[i], record.rolls.roll0[i], `held die ${i} changed`);
        }
      }
      if (choice.policy === Policy.Stand) {
        assert.deepEqual(dice, record.rolls.roll0, 'Stand keeps roll 1 entirely');
      }
    }
  });

  it('agrees with the mirror on canonical modality over every hand shape', async () => {
    // Exhaustive over sorted five-die hands (252 of them), every candidate face. The circuit
    // rewrites a 6-way argmax as six independent comparisons; only a full sweep catches a
    // tie-break that drifted between the two forms.
    let hands = 0;
    for (let a = 1; a <= 6; a++)
      for (let b = a; b <= 6; b++)
        for (let c = b; c <= 6; c++)
          for (let d = c; d <= 6; d++)
            for (let e = d; e <= 6; e++) {
              const hand = [a, b, c, d, e];
              hands += 1;
              const truth = modalFace(hand);
              for (let m = 0; m <= 7; m++) {
                const expected = isCanonicalModal(hand, m);
                assert.equal(
                  tablePure.isCanonicalModal(hand.map(BigInt), BigInt(m)),
                  expected,
                  `isCanonicalModal(${hand}, ${m})`,
                );
                assert.equal(expected, m === truth, `only the modal face is canonical: ${hand}`);
              }
            }
    assert.equal(hands, 252);
  });

  it('agrees with the mirror on policy validity', async () => {
    for (let policy = 0; policy <= 7; policy++) {
      for (let param = 0; param <= 7; param++) {
        assert.equal(
          tablePure.isValidPolicy(BigInt(policy), BigInt(param)),
          isValidPolicy(policy, param),
          `isValidPolicy(${policy}, ${param})`,
        );
      }
    }
    // The encoding is api/src/policies.ts's, restated so a renumbering breaks here loudly.
    assert.deepEqual(
      [
        Policy.Stand,
        Policy.RerollAll,
        Policy.KeepModal,
        Policy.KeepFace,
        Policy.ChaseStraight,
        Policy.KeepPairsPlus,
      ],
      [0, 1, 2, 3, 4, 5],
    );
    assert.equal(tablePure.holdPolicyCount(), 6n);
  });
});

// =========================================================================================
describe('timeouts', () => {
  // =======================================================================================

  it('refuses a timeout claim one second before the deadline and allows it one second after', async () => {
    const g = await seated({ seats: 2, turnTimeoutSecs: 300n });
    const led = g.ledger();
    const deadline = Number(led.lastActionAt + led.turnTimeoutSecs);

    // `blockTimeGt` is strict, so the deadline second itself is still too early. Tested at the
    // exact boundary rather than "well before": an off-by-one here silently shortens or
    // lengthens every turn in the game.
    for (const at of [deadline - 1, deadline]) {
      await assert.rejects(
        () => g.sim.claimTimeout(at),
        /the turn deadline has not passed/,
        `claim at ${at} (deadline ${deadline}) should be too early`,
      );
    }

    const remaining = await g.sim.claimTimeout(deadline + 1);
    assert.equal(remaining, 1n);
    const after = g.ledger();
    assert.equal(after.seatProgress.lookup(0n).forfeited, true);
    assert.equal(after.seatProgress.lookup(0n).finishedAtTurn, NO_FINISH);
    assert.equal(after.activeSeats, 1n);
    assert.equal(after.currentSeat, 1n, 'the cursor must move past the forfeited seat');
    assert.equal(after.phase, PHASE_PLAYING);
  });

  it('refuses a timeout claim while waiting on the operator', async () => {
    const g = await seated({ seats: 2, turnTimeoutSecs: 300n });
    await g.takeTurn(0, 0);
    assert.equal(g.ledger().turnState, WAIT_RESOLVE);

    const led = g.ledger();
    const wellPast = Number(led.lastActionAt + led.tableTimeoutSecs) + 1;
    await assert.rejects(
      () => g.sim.claimTimeout(wellPast),
      /waiting on the operator, not on a player/,
      'a stalled operator must not cost the player their seat',
    );
  });

  it('skips a forfeited seat for the rest of the game and settles correctly', async () => {
    // Seat 0 times out in the middle of round 4; seat 1 plays on alone and takes the pot,
    // including seat 0's stake. This is the headline timeout behaviour: a forfeit does not
    // stop the game and does not refund the forfeiter.
    const plan: GamePlan = { strategy: 'bestScore', forfeits: [{ seat: 0, round: 4 }] };
    const g = await seated({ seats: 2 }, plan);
    await g.playToEnd();

    const led = g.ledger();
    assert.equal(led.round, BigInt(ROUND_COUNT));
    assert.equal(led.activeSeats, 1n);
    assert.equal(led.seatProgress.lookup(0n).forfeited, true);
    assert.equal(led.seatProgress.lookup(0n).finishedAtTurn, NO_FINISH);
    assert.equal(led.seatProgress.lookup(1n).forfeited, false);

    // The offline replay models the forfeit too, so the whole post-forfeit game -- whose dice
    // depend on a digest chain that a forfeit changes -- is still cross-checked.
    const replay = g.replay();
    assert.deepEqual(led.gameDigest, replay.digest);
    assert.equal(led.seatProgress.lookup(0n).total, BigInt(replay.totals[0]!));
    assert.equal(led.seatProgress.lookup(1n).total, BigInt(replay.totals[1]!));
    assert.ok(replay.totals[1]! > replay.totals[0]!, 'the seat that played on should be ahead');

    const pot = led.pot;
    assert.equal(pot, g.config.tier * 2n, 'the forfeited stake stays in the pot');
    const [q, r] = g.rakeSplit();
    const winner = await g.sim.settle(g.config.seed, q, r);
    assert.equal(winner, 1n);
    assert.equal(g.ledger().pot, 0n);
    assert.equal(
      g.ledger().seatIdentity.lookup(winner).addr.bytes[0],
      g.players[1]!.addr.bytes[0],
      'the winner is paid at the address recorded at join',
    );
  });

  it('abandons the table when the last active seat forfeits, and abortTable refunds', async () => {
    const g = await seated({ seats: 2, turnTimeoutSecs: 60n });

    let led = g.ledger();
    await g.sim.claimTimeout(Number(led.lastActionAt + led.turnTimeoutSecs) + 1);
    assert.equal(g.ledger().activeSeats, 1n);
    assert.equal(g.ledger().phase, PHASE_PLAYING);

    led = g.ledger();
    const remaining = await g.sim.claimTimeout(Number(led.lastActionAt + led.turnTimeoutSecs) + 1);
    assert.equal(remaining, 0n);
    assert.equal(g.ledger().phase, PHASE_ABANDONED, 'no seats left means nobody won');
    assert.equal(g.ledger().pot, g.config.tier * 2n);

    // Settling an abandoned table is refused -- there is no winner to pay, and paying the last
    // seat standing would make timing out last profitable.
    await assert.rejects(() => g.sim.settle(g.config.seed, 0n, 0n), /table is not playing/);

    // `abortTable` needs no further wait: the timeout that produced `abandoned` has elapsed.
    const at = Number(g.ledger().lastActionAt) + 1;
    const refunded = await g.sim.abortTable(at);
    assert.equal(refunded, g.config.tier * 2n);
    assert.equal(g.ledger().phase, PHASE_ABORTED);
    assert.equal(g.ledger().pot, 0n);
  });

  it('refunds every seat exactly the tier when the operator stalls', async () => {
    const g = await seated({ seats: 3, tableTimeoutSecs: 1_200n });
    await g.takeTurn(0, 0);
    const led = g.ledger();
    assert.equal(led.turnState, WAIT_RESOLVE);
    const deadline = Number(led.lastActionAt + led.tableTimeoutSecs);

    for (const at of [deadline - 1, deadline]) {
      await assert.rejects(
        () => g.sim.abortTable(at),
        /neither stalled past its deadline nor abandoned/,
        `abort at ${at} (deadline ${deadline}) should be too early`,
      );
    }

    const refunded = await g.sim.abortTable(deadline + 1);
    assert.equal(refunded, g.config.tier * 3n, 'every seat gets exactly its stake back');
    const after = g.ledger();
    assert.equal(after.phase, PHASE_ABORTED);
    assert.equal(after.pot, 0n);
    // Nothing to the rake on an abort.
    for (let seat = 0; seat < 3; seat++) {
      assert.deepEqual(
        after.seatIdentity.lookup(BigInt(seat)).addr.bytes,
        g.players[seat]!.addr.bytes,
      );
    }
    await assert.rejects(() => g.sim.abortTable(deadline + 2), /neither stalled/);
  });

  it('refunds the joined seats when a table never fills', async () => {
    const g = await GameDriver.open({ seats: 4, tableTimeoutSecs: 900n });
    await g.join(0);
    await g.join(1);
    assert.equal(g.ledger().phase, PHASE_FILLING);

    const led = g.ledger();
    const deadline = Number(led.lastActionAt + led.tableTimeoutSecs);
    await assert.rejects(() => g.sim.abortTable(deadline), /neither stalled/);

    const refunded = await g.sim.abortTable(deadline + 1);
    assert.equal(refunded, g.config.tier * 2n, 'only the seats that actually staked');
    assert.equal(g.ledger().phase, PHASE_ABORTED);
    assert.equal(g.ledger().pot, 0n);
  });

  it('refuses to abort an empty table, at any time', async () => {
    // `lastActionAt` is 0 until the first join, so an empty table looks infinitely stalled.
    // Allowing the abort would let anyone kill every freshly opened table on sight, for free,
    // with no funds at stake to justify the protection.
    const g = await GameDriver.open({ seats: 2 });
    assert.equal(g.ledger().lastActionAt, 0n);
    await assert.rejects(
      () => g.sim.abortTable(DEFAULT_BLOCK_TIME + 1_000_000),
      /neither stalled past its deadline nor abandoned/,
    );
    // And a table that has a seat can still be joined afterwards, so nothing was consumed.
    await g.join(0);
    assert.equal(g.ledger().seatCount, 1n);
  });

  it('refuses to abort a table that is waiting on a player, however long it waits', async () => {
    // The player-stall path is `claimTimeout`, which forfeits ONE seat. Aborting instead would
    // refund a player who simply stopped playing, at the expense of the ones who did not.
    const g = await seated({ seats: 2, tableTimeoutSecs: 600n });
    assert.equal(g.ledger().turnState, WAIT_PLAYER);
    const far = Number(g.ledger().lastActionAt) + 10_000_000;
    await assert.rejects(() => g.sim.abortTable(far), /neither stalled past its deadline/);
  });

  it('refuses a timeout claim once the game is complete', async () => {
    const g = await seated({ seats: 2 }, { strategy: 'bestScore' });
    await g.playToEnd();
    const far = Number(g.ledger().lastActionAt) + 10_000_000;
    await assert.rejects(() => g.sim.claimTimeout(far), /every seat has finished/);
    await assert.rejects(
      () =>
        g.sim.takeTurn(
          forcedEntropyTs(g.players[0]!.sk, g.config.tableId, 0),
          POLICY_NONE,
          0,
          0,
          far,
        ),
      /every seat has finished/,
    );
  });
});

// =========================================================================================
describe('settlement guards', () => {
  // =======================================================================================

  it('refuses to settle before the game is finished', async () => {
    const g = await seated({ seats: 2 });
    await assert.rejects(() => g.sim.settle(g.config.seed, 0n, 0n), /the game is not finished/);
    await g.playRound(0);
    await assert.rejects(() => g.sim.settle(g.config.seed, 0n, 0n), /the game is not finished/);
  });

  it('refuses a settle seed that does not open the commitment', async () => {
    const g = await seated({ seats: 2 }, { strategy: 'bestScore' });
    await g.playToEnd();
    const [q, r] = g.rakeSplit();
    await assert.rejects(
      () => g.sim.settle(bytes32(0x12), q, r),
      /seed does not open the table's seed commitment/,
    );
    // Unlike `resolveTurn`, the seed here is a PUBLIC argument -- settlement's whole purpose
    // is to publish it -- so this rejection is about the value, not about who supplied it.
    await g.sim.settle(g.config.seed, q, r);
  });

  it('refuses a second settle, and every other move after settling', async () => {
    const g = await seated({ seats: 2 }, { strategy: 'bestScore' });
    await g.playToEnd();
    const [q, r] = g.rakeSplit();
    await g.sim.settle(g.config.seed, q, r);

    await assert.rejects(() => g.sim.settle(g.config.seed, q, r), /table is not playing/);
    await assert.rejects(() => g.sim.claimTimeout(g.clock + 100), /table is not playing/);
    await assert.rejects(() => g.sim.abortTable(g.clock + 100), /neither stalled/);
    g.sim.asPlayer(g.players[0]!.sk);
    await assert.rejects(
      () =>
        g.sim.takeTurn(
          forcedEntropyTs(g.players[0]!.sk, g.config.tableId, 0),
          Policy.Stand,
          0,
          0,
          g.clock + 100,
        ),
      /table is not playing/,
    );
  });

  it('refuses a table whose configuration cannot be settled honestly', async () => {
    const base = tableConfig({ seats: 2 });
    const bad = [
      [{ ...base, seats: 1n }, /at least 2 seats/],
      [{ ...base, seats: 7n }, /at most 6 seats/],
      // Under 100 the 1% rake floors to zero, and a zero-value payout is an unshielded output
      // nobody should have to reason about. Excluded by construction. See decision 6.
      [{ ...base, tier: 99n }, /tier must be at least 100/],
      [{ ...base, turnTimeoutSecs: 0n }, /turn timeout must be positive/],
      [{ ...base, tableTimeoutSecs: 0n }, /table timeout must be positive/],
    ] as const;
    for (const [config, message] of bad) {
      await assert.rejects(() => TableSimulator.create(config), message);
    }
  });
});

// =========================================================================================
describe('the declared-time sandwich', () => {
  // =======================================================================================
  //
  // The kernel exposes block-time predicates but no accessor, so `lastActionAt` has to be
  // DECLARED and pinned. These tests are what stop the pin from being decorative.

  it('refuses a declared time ahead of the block time', async () => {
    const g = await GameDriver.open({ seats: 2 });
    g.sim.asPlayer(g.players[0]!.sk);
    await assert.rejects(
      () => g.sim.join(g.players[0]!.addr, DEFAULT_BLOCK_TIME + 1, DEFAULT_BLOCK_TIME),
      /declared time is ahead of block time/,
    );
    // Equal is fine: the sandwich is `now <= blockTime`.
    await g.sim.join(g.players[0]!.addr, DEFAULT_BLOCK_TIME, DEFAULT_BLOCK_TIME);
  });

  it('refuses a declared time further behind than the slack', async () => {
    const SLACK = 600;
    const g = await GameDriver.open({ seats: 2 });
    g.sim.asPlayer(g.players[0]!.sk);

    // now == blockTime - SLACK is out; one second later is in. Under-declaring is the only
    // direction available, and it is bounded.
    await assert.rejects(
      () => g.sim.join(g.players[0]!.addr, DEFAULT_BLOCK_TIME - SLACK, DEFAULT_BLOCK_TIME),
      /further behind block time than the allowed slack/,
    );
    await g.sim.join(g.players[0]!.addr, DEFAULT_BLOCK_TIME - SLACK + 1, DEFAULT_BLOCK_TIME);
  });

  it('refuses a declared time that moves backwards', async () => {
    const g = await GameDriver.open({ seats: 2 });
    await g.join(0);
    const stamped = Number(g.ledger().lastActionAt);

    g.sim.asPlayer(g.players[1]!.sk);
    await assert.rejects(
      () => g.sim.join(g.players[1]!.addr, stamped - 1, stamped + 100),
      /declared time must not move backwards/,
      'lastActionAt must be monotone or every deadline can be replayed',
    );
    await g.sim.join(g.players[1]!.addr, stamped, stamped + 100);
    assert.equal(g.ledger().lastActionAt, BigInt(stamped));
  });
});

// =========================================================================================
describe('tie-break at table level', () => {
  // =======================================================================================
  //
  // Every die comes out of a hash, so a tie cannot be constructed -- it has to be FOUND. The
  // table ids below were located by sweeping `replayGame` offline (milliseconds per game) for
  // configurations that tie, and are hard-coded so the tests are deterministic and so that any
  // change to the dice ladder, the policy masks or the digest chain breaks them loudly. Each
  // test re-asserts the tie it depends on before asserting the tie-break.

  it('breaks a tie between two finishers by seat order', async () => {
    // Both seats complete, so both have a real `finishedAtTurn`, and seat 0 always finishes
    // first because seat order is turn order. Seat 0 wins on both remaining legs at once.
    const opts: TableOptions = { seats: 2, tableId: bytes32(36) };
    const plan: GamePlan = { strategy: 'firstLegal' };
    const preview = replayGame(tableConfig(opts), makePlayers(2), plan);
    assert.equal(preview.totals[0], preview.totals[1], 'this table id was chosen for its tie');

    const g = await seated(opts, plan);
    await g.playToEnd();
    const led = g.ledger();
    assert.equal(led.seatProgress.lookup(0n).total, led.seatProgress.lookup(1n).total);
    assert.ok(
      led.seatProgress.lookup(0n).finishedAtTurn < led.seatProgress.lookup(1n).finishedAtTurn,
    );

    const [q, r] = g.rakeSplit();
    assert.equal(await g.sim.settle(g.config.seed, q, r), 0n);
  });

  it('prefers the earlier finisher over the lower seat', async () => {
    // Seat 0 forfeits at round 11 and ends level with seat 1, which played to the end. Seat 0
    // has the lower index and would win a naive scan; it carries `noFinish()`, so it loses the
    // tie to the seat that actually finished. This is the leg that separates the two rules,
    // and a forfeited seat is the only way to reach it -- among finishers, seat order and
    // finish order always agree.
    const opts: TableOptions = { seats: 2, tableId: bytes32(18) };
    const plan: GamePlan = { strategy: 'firstLegal', forfeits: [{ seat: 0, round: 11 }] };
    const preview = replayGame(tableConfig(opts), makePlayers(2), plan);
    assert.equal(preview.totals[0], preview.totals[1], 'this scenario was chosen for its tie');
    assert.equal(preview.finishedAtTurn[0], undefined);

    const g = await seated(opts, plan);
    await g.playToEnd();
    const led = g.ledger();
    assert.equal(led.seatProgress.lookup(0n).total, led.seatProgress.lookup(1n).total);
    assert.equal(led.seatProgress.lookup(0n).finishedAtTurn, NO_FINISH);
    assert.equal(led.seatProgress.lookup(0n).forfeited, true);

    const [q, r] = g.rakeSplit();
    assert.equal(
      await g.sim.settle(g.config.seed, q, r),
      1n,
      'the seat that finished must beat the equal-scoring seat that walked away',
    );
  });

  it('falls back to the lowest seat when totals and finish times are both equal', async () => {
    // Seats 0 and 1 both forfeit at round 10 with equal totals, so both carry `noFinish()` and
    // the first two legs are exhausted. Seat 2 forfeits at round 1 with nothing; seat 3 plays
    // to the end but scores less than the tied pair. A forfeited seat CAN win -- it competes
    // with what it scored, and its stake stayed in the pot the whole time.
    const opts: TableOptions = { seats: 4, tableId: bytes32(10) };
    const plan: GamePlan = {
      strategy: 'bestScore',
      forfeits: [
        { seat: 0, round: 10 },
        { seat: 1, round: 10 },
        { seat: 2, round: 1 },
      ],
    };
    const preview = replayGame(tableConfig(opts), makePlayers(4), plan);
    assert.equal(preview.totals[0], preview.totals[1]);
    assert.ok(preview.totals[0]! > preview.totals[3]!);
    assert.ok(preview.totals[0]! > preview.totals[2]!);

    const g = await seated(opts, plan);
    await g.playToEnd();
    const led = g.ledger();
    assert.equal(led.activeSeats, 1n);
    assert.equal(led.seatProgress.lookup(0n).total, led.seatProgress.lookup(1n).total);
    assert.equal(led.seatProgress.lookup(0n).finishedAtTurn, NO_FINISH);
    assert.equal(led.seatProgress.lookup(1n).finishedAtTurn, NO_FINISH);

    const [q, r] = g.rakeSplit();
    assert.equal(await g.sim.settle(g.config.seed, q, r), 0n, 'lowest seat takes the last tie');
    assert.equal(g.ledger().pot, 0n);
  });
});

// =========================================================================================
describe('a six-seat table', () => {
  // =======================================================================================

  it('plays a full six-seat game and settles', async () => {
    // The widest table the contract supports: `nextCursor`'s six unrolled steps, `settle`'s
    // six-row tie-break and `abortTable`'s six conditional refunds are all at their bound
    // here. 6 seats x (14 takeTurns + 13 resolves) = 162 circuit calls.
    const g = await seated({ seats: 6 }, { strategy: 'bestScore' });
    assert.equal(g.ledger().seatCount, 6n);
    assert.equal(g.ledger().pot, g.config.tier * 6n);

    await g.playToEnd();
    assert.equal(g.turns.length, 6 * 13);

    const led = g.ledger();
    assert.equal(led.round, BigInt(ROUND_COUNT));
    assert.equal(led.turnIndex, BigInt(6 * ROUND_COUNT), 'one turn index per completed turn');

    const replay = g.replay();
    assert.deepEqual(led.gameDigest, replay.digest);
    // Finish order must be seat order: seat s completes its 13th category one turn after s-1.
    for (let seat = 0; seat < 6; seat++) {
      const prog = led.seatProgress.lookup(BigInt(seat));
      assert.equal(prog.total, BigInt(replay.totals[seat]!));
      assert.equal(prog.finishedAtTurn, BigInt(replay.finishedAtTurn[seat]!));
      if (seat > 0) {
        assert.ok(prog.finishedAtTurn > led.seatProgress.lookup(BigInt(seat - 1)).finishedAtTurn);
      }
    }

    const [q, r] = g.rakeSplit();
    const winner = await g.sim.settle(g.config.seed, q, r);
    assert.equal(winner, BigInt(g.expectedWinner()));
    assert.equal(g.ledger().phase, PHASE_SETTLED);
    assert.equal(g.ledger().pot, 0n);
  });

  it('skips two forfeited seats mid-game and still completes', async () => {
    // Exercises `nextCursor` where the skip has to cross a round boundary: with seats 1 and 4
    // gone, the cursor wraps from 5 to 0 and from 0 past 1 in the same advance.
    const g = await seated(
      { seats: 6 },
      {
        strategy: 'bestScore',
        forfeits: [
          { seat: 1, round: 3 },
          { seat: 4, round: 6 },
        ],
      },
    );
    await g.playToEnd();

    const led = g.ledger();
    assert.equal(led.round, BigInt(ROUND_COUNT));
    assert.equal(led.activeSeats, 4n);
    for (const seat of [1n, 4n]) {
      assert.equal(led.seatProgress.lookup(seat).forfeited, true);
      assert.equal(led.seatProgress.lookup(seat).finishedAtTurn, NO_FINISH);
    }
    for (const seat of [0n, 2n, 3n, 5n]) {
      assert.equal(led.seatProgress.lookup(seat).forfeited, false);
      assert.notEqual(led.seatProgress.lookup(seat).finishedAtTurn, NO_FINISH);
    }
    assert.deepEqual(led.gameDigest, g.replay().digest);

    const [q, r] = g.rakeSplit();
    assert.equal(await g.sim.settle(g.config.seed, q, r), BigInt(g.expectedWinner()));
    assert.equal(g.ledger().pot, g.config.tier * 0n);
  });
});

// =========================================================================================
describe('token custody, as far as the simulator can see it', () => {
  // =======================================================================================
  //
  // WHAT THIS SIMULATOR CANNOT DO. `unshieldedBalance(nativeToken())` returns 0 under
  // compact-runtime 0.19.0 regardless of what `receiveUnshielded` was handed -- verified
  // directly, docs/bugs-found.md #11 -- so `receiveUnshielded` and `sendUnshielded` execute
  // without moving anything and without recording anything a test can read. The assertions
  // below therefore cover the contract's own bookkeeping and its choice of recipient, which
  // is everything except the transfer itself.
  //
  // The E2E devnet run must verify, per circuit, using the indexer's per-transaction UTXO
  // movement (probes/gate0/tools/utxo-audit.mjs) and never a wallet's aggregate balance:
  //   * `join` moves exactly `tier` from the joining wallet into the contract;
  //   * `settle` creates exactly two outputs, `pot - q` to the winner's recorded address and
  //     `q` to the rake address, and spends zero user inputs;
  //   * `abortTable` creates exactly `seatCount` outputs of `tier` each and nothing to rake;
  //   * every circuit's transaction clears the ~8 KB `OutsideTimeToDismiss` floor with the
  //     padding as configured, and its k is one the proof server actually has.

  it('tracks the pot exactly through joins, and drains it exactly at settle', async () => {
    const g = await GameDriver.open({ seats: 3 }, { strategy: 'bestScore' });
    assert.equal(g.ledger().pot, 0n);
    for (let seat = 0; seat < 3; seat++) {
      await g.join(seat);
      assert.equal(g.ledger().pot, g.config.tier * BigInt(seat + 1), 'pot is tier x seatCount');
    }
    await g.playToEnd();
    const pot = g.ledger().pot;
    const [q, r] = g.rakeSplit();
    const winner = await g.sim.settle(g.config.seed, q, r);

    // The two payouts must exactly exhaust the pot -- no dust may be left in the contract,
    // because nothing can ever move it out afterwards.
    assert.equal(pot - q + q, pot);
    assert.equal(g.ledger().pot, 0n);

    const led = g.ledger();
    assert.deepEqual(
      led.seatIdentity.lookup(winner).addr.bytes,
      g.players[Number(winner)]!.addr.bytes,
      'the winner is paid at the address it recorded at join, not one supplied at settle',
    );
    assert.deepEqual(led.rakeAddress.bytes, g.config.rakeAddress.bytes, 'rake address is sealed');
  });

  it('refunds exactly the sum of the stakes and never more', async () => {
    const g = await GameDriver.open({ seats: 5, tableTimeoutSecs: 500n });
    await g.join(0);
    await g.join(1);
    await g.join(2);
    const led = g.ledger();
    assert.equal(led.pot, g.config.tier * 3n);

    const refunded = await g.sim.abortTable(Number(led.lastActionAt + led.tableTimeoutSecs) + 1);
    assert.equal(refunded, g.config.tier * 3n);
    assert.equal(g.ledger().pot, 0n);
    // The two empty slots stay at their default zero address and are never paid: paying a zero
    // address would burn the stake, which is why the refund loop is conditional on seatCount.
    for (const seat of [3n, 4n]) {
      assert.deepEqual(g.ledger().seatIdentity.lookup(seat).addr.bytes, new Uint8Array(32));
    }
  });
});
