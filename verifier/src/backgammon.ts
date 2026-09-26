// Copyright (C) Shielded Technologies
// SPDX-License-Identifier: Apache-2.0

/**
 * The chain-only verifier for a Backgammon table. Given only the table's address, it reads every
 * transaction and the state each one left, and checks:
 *
 *   1. the revealed seed opens the commitment sealed at deploy;
 *   2. every roll re-derives from that seed and the public entropies (bg-mirror.ts), including
 *      the opening and who it made move first;
 *   3. every ply re-applies to the board before it and gives the board after it
 *      (api/src/backgammon.ts, the circuit's twin);
 *   4. every ply obeyed the two rules the chain does NOT enforce -- play as many dice as you can,
 *      and the larger if only one -- reported as FINDINGS, not failures of the chain;
 *   5. the game ended as the chain says: fifteen borne off, a timeout, or a resignation;
 *   6. custody after every transaction: the contract's real native balance equals its `pot`;
 *   7. the settlement paid the winner pot - 1% at its join-time address and the rake to the
 *      sealed rake address, out of the contract's own balance (zero user inputs).
 *
 * Exit codes follow verify.ts: 0 verified, 1 a check failed (or force-settled, unreplayable),
 * 2 verified with findings (a player broke a rule the chain does not enforce), 3 not settled.
 */

import { Backgammon as Rules } from '@dust-dice/api';
import { bgRollForPly, bgStarter, nativeBalanceOf, seedCommitmentTs } from '@dust-dice/contract';
import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';

import { Checks, addressOf } from './checks.ts';
import { NETWORK } from './config.ts';
import { Backgammon, readContractState, type BackgammonLedger } from './contracts.ts';
import {
  contractActions,
  sumNative,
  sumNativeFor,
  transactionByHash,
  type ContractAction,
} from './indexer.ts';

const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex');

const STAGE_ROLL = 0n;
const STAGE_MOVE = 1n;

/** One transaction of the table's log, and what it left behind. */
interface Step {
  blockHeight: number;
  txHash: string;
  entryPoints: string[];
  led: BackgammonLedger;
  /** The contract's real native balance after this transaction. */
  balance: bigint;
}

/**
 * Where a state sits in the game, for ordering two transactions that share a block. A
 * Backgammon table is strictly sequential -- every call asserts the stage its predecessor left
 * -- so this is total within one table's log.
 */
function progress(led: BackgammonLedger): number {
  const phaseRank = led.phase >= Backgammon.BgPhase.decided ? 1 : 0;
  return (
    (phaseRank * 1_000_000 + Number(led.turn) * 4 + Number(led.stage) * 2 + Number(led.seatCount)) *
      10 +
    (led.phase === Backgammon.BgPhase.settled ? 1 : 0)
  );
}

async function readSteps(address: string): Promise<Step[]> {
  const actions = (await contractActions(address)).filter((a) => a.kind !== 'ContractDeploy');
  const byTx = new Map<string, ContractAction[]>();
  for (const a of actions) byTx.set(a.txHash, [...(byTx.get(a.txHash) ?? []), a]);
  const steps: Step[] = [];
  for (const [txHash, calls] of byTx) {
    const state = await readContractState(address, { txHash });
    steps.push({
      blockHeight: calls[0]!.blockHeight,
      txHash,
      entryPoints: calls.map((x) => x.entryPoint ?? '?'),
      led: Backgammon.ledger(state.data),
      balance: nativeBalanceOf(state),
    });
  }
  steps.sort((a, b) =>
    a.blockHeight !== b.blockHeight
      ? a.blockHeight - b.blockHeight
      : progress(a.led) - progress(b.led),
  );
  return steps;
}

function boardOf(led: BackgammonLedger): Rules.Board {
  return { s0: led.board.s0.map(Number), s1: led.board.s1.map(Number) };
}

function plyOf(led: BackgammonLedger): Rules.Ply {
  return Rules.decodePly({
    moves: led.lastPly.moves.map((m) => ({ point: Number(m.point), die: Number(m.die) })),
    count: Number(led.lastPly.count),
  });
}

function sameBoard(a: Rules.Board, b: Rules.Board): boolean {
  return a.s0.join() === b.s0.join() && a.s1.join() === b.s1.join();
}

const showPly = (ply: Rules.Ply): string =>
  ply.length === 0
    ? '(pass)'
    : ply
        .map(
          (m) =>
            `${m.point === Rules.BAR ? 'bar' : m.point}/${Math.max(m.point - m.die, 0) || 'off'}`,
        )
        .join(' ');

export async function verifyBackgammon(address: string, verbose: boolean): Promise<number> {
  setNetworkId(NETWORK.networkId);
  const c = new Checks(verbose);
  console.log(`Verifying Backgammon table ${address}\n`);

  const finalState = await readContractState(address);
  const final = Backgammon.ledger(finalState.data);
  const tableId = final.tableId;
  console.log('── table, as deployed ──');
  console.log(`  tableId        ${hex(tableId)}`);
  console.log(`  tier           ${final.tier}`);
  console.log(`  seedCommitment ${hex(final.seedCommitment)}`);
  console.log(
    `  move timeout   ${final.moveTimeoutSecs} s   table timeout ${final.tableTimeoutSecs} s`,
  );
  console.log(`  phase          ${Backgammon.BgPhase[final.phase]}`);

  if (final.phase !== Backgammon.BgPhase.settled) {
    console.log(
      `\nNOT VERIFIABLE YET: this table is ${Backgammon.BgPhase[final.phase]}. Only a settled ` +
        'table reveals the seed,\nand without the seed no roll can be re-derived. Nothing here ' +
        'says the game was dishonest.',
    );
    return 3;
  }

  console.log('\n── the revealed seed ──');
  const seed = final.revealedSeed;
  console.log(`  seed ${hex(seed)}`);
  if (seed.every((b) => b === 0)) {
    console.log(
      '\n  This table was FORCE-SETTLED: no valid seed was revealed before the grace ran out, so\n' +
        '  `settle` paid the winner the chain had already decided and left `revealedSeed` at\n' +
        '  zero. Every ply was still checked on chain as it was played, but the rolls cannot be\n' +
        '  re-derived offline.',
    );
    c.summary();
    return 1;
  }
  c.ok(
    'the seed opens the commitment sealed at deploy',
    hex(seedCommitmentTs(tableId, seed)) === hex(final.seedCommitment),
  );

  const steps = await readSteps(address);
  console.log(`\n── ${steps.length} transactions ──`);

  let board = Rules.initialBoard();
  const findings: string[] = [];
  let prev: BackgammonLedger | undefined;
  let decidedBy = '';

  for (const [i, s] of steps.entries()) {
    const led = s.led;
    const what = s.entryPoints.join('+');
    if (verbose) console.log(`  tx ${i} ${what} (block ${s.blockHeight})`);

    for (const ep of s.entryPoints) {
      switch (ep) {
        case 'join':
          break;

        case 'resolveRoll': {
          if (!prev) {
            c.ok(`tx ${i}: a roll has a state before it`, false);
            break;
          }
          const turn = Number(prev.turn);
          const expected = bgRollForPly(
            tableId,
            seed,
            [prev.pendingEntropy.lookup(0n), prev.pendingEntropy.lookup(1n)],
            turn,
            Number(prev.toMove),
          );
          c.ok(
            `roll ${turn}: re-derives from the seed`,
            Number(led.dice.a) === expected.a && Number(led.dice.b) === expected.b,
            `chain ${led.dice.a}-${led.dice.b}, replay ${expected.a}-${expected.b}`,
          );
          if (turn === 0) {
            c.ok(
              'the opening: the higher die moves first',
              Number(led.toMove) === bgStarter(expected),
              `seat 0 threw ${expected.a}, seat 1 threw ${expected.b}; seat ${led.toMove} moved first`,
            );
          }
          c.ok(`roll ${turn}: the player now owes the move`, led.stage === STAGE_MOVE);
          break;
        }

        case 'move': {
          if (!prev) {
            c.ok(`tx ${i}: a move has a state before it`, false);
            break;
          }
          const turn = Number(prev.turn);
          const mover = Number(prev.toMove);
          const dice: [number, number] = [Number(prev.dice.a), Number(prev.dice.b)];
          const ply = plyOf(led);
          const { mine, opp } = Rules.sidesFor(board, mover);
          let replayed: Rules.Board | undefined;
          try {
            const out = Rules.applyPly(mine, opp, dice, ply);
            replayed = Rules.boardFrom(mover, out.mine, out.opp);
          } catch (e) {
            c.ok(`ply ${turn}: the chain-accepted ply re-applies`, false, String(e));
          }
          if (replayed) {
            c.ok(
              `ply ${turn} (seat ${mover}, ${dice[0]}-${dice[1]}: ${showPly(ply)}): the board after`,
              sameBoard(replayed, boardOf(led)),
            );
            board = replayed;
          } else {
            board = boardOf(led);
          }
          const broke = Rules.plyRuleViolation(mine, opp, dice, ply);
          if (broke !== null) {
            findings.push(
              `ply ${turn}, seat ${mover}, ${dice[0]}-${dice[1]} ${showPly(ply)}: ${broke}`,
            );
          }
          c.ok(`ply ${turn}: the turn counter advanced`, Number(led.turn) === turn + 1);
          if (led.phase === Backgammon.BgPhase.decided) {
            decidedBy = `seat ${mover} bore off its fifteenth checker at ply ${turn}`;
            c.ok(
              'the winner has borne off all fifteen',
              Rules.hasWon(Rules.sidesFor(board, mover).mine) && Number(led.winner) === mover,
            );
          } else {
            c.ok(
              `ply ${turn}: the other seat is to roll`,
              Number(led.toMove) === 1 - mover && led.stage === STAGE_ROLL,
            );
          }
          break;
        }

        case 'eliminate': {
          if (!prev) break;
          if (prev.phase === Backgammon.BgPhase.filling) {
            console.log(`  tx ${i}: a seat left the filling table and was refunded`);
            break;
          }
          const loser = 1 - Number(led.winner);
          const timedOut = prev.stage === STAGE_MOVE && Number(prev.toMove) === loser;
          decidedBy = timedOut
            ? `seat ${loser} was eliminated (timed out or resigned while to move)`
            : `seat ${loser} resigned`;
          c.ok(
            'eliminate decided the game for the other seat',
            led.phase === Backgammon.BgPhase.decided,
          );
          break;
        }

        case 'settle':
        case 'abortTable':
          break;

        default:
          console.log(`  (unrecognised entry point '${ep}' -- ignored)`);
      }
    }

    // Custody, from the chain itself: while the table holds stakes, its native balance is its pot.
    c.ok(
      `tx ${i} (${what}): the contract holds exactly its pot`,
      s.balance === led.pot,
      `balance ${s.balance}, pot ${led.pot}`,
    );
    prev = led;
  }

  console.log('\n── the result ──');
  console.log(`  ${decidedBy || 'the log does not say how the game was decided'}`);
  c.ok('the log shows how the game was decided', decidedBy !== '');
  c.ok('the final board is the replayed board', sameBoard(board, boardOf(final)));

  console.log('\n── the payout ──');
  const settleStep = steps.find((st) => st.entryPoints.includes('settle'));
  if (!settleStep) {
    c.ok('the settle transaction is in the log', false);
  } else {
    const tx = await transactionByHash(settleStep.txHash);
    const before = steps[steps.indexOf(settleStep) - 1]!.led;
    const pot = before.pot;
    const q = pot / 100n;
    const winnerAddr = final.seatIdentity.lookup(final.winner).addr.bytes;
    console.log(`  settle tx ${tx.hash} in block ${tx.block.height}; pot ${pot}`);
    c.ok('the pot was both stakes', pot === final.tier * 2n, `pot ${pot}`);
    c.ok('settle spent ZERO user inputs', sumNative(tx.unshieldedSpentOutputs) === 0n);
    c.ok('settle created exactly the pot', sumNative(tx.unshieldedCreatedOutputs) === pot);
    c.ok(
      `the winner (seat ${final.winner}) was paid pot - 1% at its join-time address`,
      sumNativeFor(tx.unshieldedCreatedOutputs, addressOf(tx, winnerAddr)) === pot - q,
      `expected ${pot - q}`,
    );
    c.ok(
      'the rake was paid 1% at the address sealed at deploy',
      sumNativeFor(tx.unshieldedCreatedOutputs, addressOf(tx, final.rakeAddress.bytes)) === q,
      `expected ${q}`,
    );
    c.ok('the pot is empty afterwards', final.pot === 0n);
  }

  if (findings.length > 0) {
    console.log(
      `\n── ${findings.length} ply(s) broke a rule the chain does not enforce ──\n` +
        findings.map((f) => `  ${f}`).join('\n') +
        '\n  The chain checks every checker, but not that a ply plays as many dice as it can, nor\n' +
        '  that a lone playable die is the larger. The dice and the payout above are unaffected.',
    );
  }
  c.summary();
  console.log(`\n(${c.count} checks in total)`);
  if (c.failed.length > 0) return 1;
  return findings.length > 0 ? 2 : 0;
}
