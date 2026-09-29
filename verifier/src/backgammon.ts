// Copyright (C) Shielded Technologies
// SPDX-License-Identifier: Apache-2.0

/**
 * The chain-only verifier for a Backgammon table. Given only the table's address, it reads every
 * transaction and the state each one left, and checks:
 *
 *   1. the VRF key `settle` revealed opens the public key sealed at deploy;
 *   2. every roll replays from that key and the secrets the moves revealed (bg-mirror.ts):
 *      the opening and who it made move first, then each ply's roll against the dice its move
 *      disclosed. The chain already checked each one as it was made (the DLEQ at every resolve,
 *      the unblinding in every move); the replay is the check that needs no proof system;
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
import {
  bgClosesOut,
  bgHeldSlots,
  bgReplayOpening,
  bgReplayRoll,
  bgStartPick,
  bgStarter,
  nativeBalanceOf,
  vrfPublicKeyOf,
} from '@dust-dice/contract';
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
/** Slots someone holds. While filling nothing else counts the players -- the contract's §6. */
const occupied = (led: BackgammonLedger): number => bgHeldSlots(led).length;

/** What the contract should hold: the pot once started, one stake per held slot while filling. */
function expectedBalance(led: BackgammonLedger): bigint {
  return led.phase === Backgammon.BgPhase.filling ? led.tier * BigInt(occupied(led)) : led.pot;
}

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
    (phaseRank * 1_000_000 + Number(led.turn) * 4 + Number(led.stage) * 2 + occupied(led)) * 10 +
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
  return causalOrder(steps);
}

/** Could this transaction's calls have taken the table from `p` to `s`? */
function produces(eps: readonly string[], p: BackgammonLedger, s: BackgammonLedger): boolean {
  const P = Backgammon.BgPhase;
  // A move advances one ply -- or two when it shut the other seat out and the contract passed
  // for it (backgammon.compact section 7).
  if (eps.includes('move')) return s.turn === p.turn + 1n || s.turn === p.turn + 2n;
  if (eps.includes('start')) return p.phase === P.filling && s.phase === P.playing;
  if (eps.includes('resolveRoll')) {
    return p.stage === STAGE_ROLL && s.stage === STAGE_MOVE && s.turn === p.turn;
  }
  if (eps.includes('join')) return occupied(s) === occupied(p) + 1;
  if (eps.includes('eliminate')) {
    return (
      (p.phase === P.filling && occupied(s) === occupied(p) - 1) ||
      (p.phase === P.playing && s.phase === P.decided && s.turn === p.turn)
    );
  }
  if (eps.includes('settle')) return p.phase === P.decided && s.phase === P.settled;
  if (eps.includes('abortTable')) return s.phase === P.aborted;
  return false;
}

/**
 * Order each block's transactions by CAUSE, not by listing: at every point take the transaction
 * whose calls explain the step from the current state; one that left the state exactly as it was
 * is a call that landed without effect (it lost a race in the same block) and goes where it
 * changed nothing. Sorting by progress alone cannot tell a winning move from the timeout claim
 * it beat -- both leave the same state behind.
 */
function causalOrder(sorted: Step[]): Step[] {
  const out: Step[] = [];
  let cur: BackgammonLedger | undefined;
  for (let i = 0; i < sorted.length;) {
    const block = sorted.filter((st) => st.blockHeight === sorted[i]!.blockHeight);
    i += block.length;
    const pending = [...block];
    while (pending.length > 0) {
      let k = pending.findIndex((st) =>
        cur === undefined ? st.entryPoints.includes('join') : produces(st.entryPoints, cur, st.led),
      );
      if (k < 0 && cur) {
        const key = stateKey(cur);
        k = pending.findIndex((st) => stateKey(st.led) === key);
      }
      if (k < 0) k = 0; // unexplained: keep its place, and let the checks say what is wrong
      const [st] = pending.splice(k, 1);
      out.push(st!);
      cur = st!.led;
    }
  }
  return out;
}

/** Everything a call can change. Equal before and after = the call had no effect. */
function stateKey(l: BackgammonLedger): string {
  return [
    l.phase,
    l.seatCount,
    l.stage,
    l.toMove,
    l.turn,
    l.dice.a,
    l.dice.b,
    l.pot,
    occupied(l),
    l.winner,
    l.deadline,
    l.board.s0.join(','),
    l.board.s1.join(','),
  ].join('|');
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
  console.log(
    `  VRF public key (${final.vrfPublicKey.x.toString(16).slice(0, 16)}…, ` +
      `${final.vrfPublicKey.y.toString(16).slice(0, 16)}…)`,
  );
  console.log(
    `  move timeout   ${final.moveTimeoutSecs} s   table timeout ${final.tableTimeoutSecs} s`,
  );
  console.log(`  phase          ${Backgammon.BgPhase[final.phase]}`);

  if (final.phase !== Backgammon.BgPhase.settled) {
    console.log(
      `\nNOT REPLAYABLE YET: this table is ${Backgammon.BgPhase[final.phase]}. Only a settled ` +
        'table reveals the VRF key,\nand without it no roll can be recomputed offline. Every ' +
        'roll was still proven on chain as it was made;\nnothing here says the game was dishonest.',
    );
    return 3;
  }

  console.log('\n── the revealed VRF key ──');
  const secret = final.revealedSecret;
  if (secret === 0n) {
    console.log(
      '\n  This table was FORCE-SETTLED: the key was not revealed before the grace ran out, so\n' +
        '  `settle` paid the winner the chain had already decided and left `revealedSecret` at\n' +
        '  zero. Every roll and every ply was still checked on chain as it was made, but the\n' +
        '  rolls cannot be replayed offline.',
    );
    c.summary();
    return 1;
  }
  const pk = vrfPublicKeyOf(secret);
  c.ok(
    'the key opens the VRF public key sealed at deploy',
    pk.x === final.vrfPublicKey.x && pk.y === final.vrfPublicKey.y,
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

    // A call can be INCLUDED and do nothing: built against a state a racing call changed first
    // in the same block (a roll that lost to a resignation), it fails its fallible half and
    // leaves the table as it was. The fee is spent; the game is not touched. Seen live on the
    // devnet 2026-09-25; the Yacht verifier learned the same lesson (bugs-found #34).
    if (prev && stateKey(prev) === stateKey(led)) {
      console.log(
        `  tx ${i} (${what}): landed without effect -- a racing call changed the table first`,
      );
      c.ok(
        `tx ${i} (${what}): the contract holds exactly its stakes`,
        s.balance === expectedBalance(led),
      );
      continue;
    }

    for (const ep of s.entryPoints) {
      switch (ep) {
        case 'join':
          break;

        case 'resolveRoll': {
          if (!prev) {
            c.ok(`tx ${i}: a roll has a state before it`, false);
            break;
          }
          // The roll is for the ply the table is now at: in a one-transaction ply that is the ply
          // AFTER the move it rides with (two after, when the move shut the other seat out).
          const turn = Number(led.turn);
          // The answer is blind: its dice appear with the move that plays them.
          c.ok(`roll ${turn}: the player now owes the move`, led.stage === STAGE_MOVE);
          break;
        }

        case 'start': {
          if (!prev || prev.phase !== Backgammon.BgPhase.filling) {
            c.ok(`tx ${i}: the start has a filling table before it`, false);
            break;
          }
          // The two earliest joiners by declared time (slot breaking a tie) take seats 0 and 1.
          const pick = bgStartPick(prev);
          const n = occupied(prev);
          console.log(
            `  tx ${i}: the start seated the two earliest of ${n} joiner(s)` +
              (n > 2 ? ' and refunded the rest' : ''),
          );
          c.ok(
            'the start seated the two earliest joiners',
            pick !== null &&
              pick.every(
                (slot, seat) =>
                  hex(prev!.joinSlots.lookup(BigInt(slot)).keyCommit) ===
                  hex(led.seatIdentity.lookup(BigInt(seat)).keyCommit),
              ),
          );
          // The opening is thrown in the clear: its dice are on the ledger from this call.
          const join = [led.joinEntropy.lookup(0n), led.joinEntropy.lookup(1n)] as const;
          const expected = bgReplayOpening(secret, tableId, join);
          c.ok(
            'the opening replays from the key and both join entropies',
            Number(led.dice.a) === expected.a && Number(led.dice.b) === expected.b,
            `chain ${led.dice.a}-${led.dice.b}, replay ${expected.a}-${expected.b}`,
          );
          c.ok(
            'the opening: the higher die moves first',
            Number(led.toMove) === bgStarter(expected),
            `seat 0 threw ${expected.a}, seat 1 threw ${expected.b}; seat ${led.toMove} moved first`,
          );
          c.ok('the opening: the player now owes the move', led.stage === STAGE_MOVE);
          break;
        }

        case 'move': {
          if (!prev) {
            c.ok(`tx ${i}: a move has a state before it`, false);
            break;
          }
          const turn = Number(prev.turn);
          const mover = Number(prev.toMove);
          // The move discloses the roll it played (at ply 0, the opening already on the ledger).
          const dice: [number, number] = [Number(led.dice.a), Number(led.dice.b)];
          if (turn > 0) {
            // The index the mover's query was formed for: this ply, or an earlier one an
            // automatic pass carried forward.
            const expected = bgReplayRoll({
              secret,
              tableId,
              turn,
              formedAt: prev.query.lookup(BigInt(mover)).formedAt,
              rollSecret: led.lastSecret,
              lastSecret: prev.lastSecret,
            });
            c.ok(
              `roll ${turn}: replays from the key and the secret its move revealed`,
              dice[0] === expected.a && dice[1] === expected.b,
              `chain ${dice[0]}-${dice[1]}, replay ${expected.a}-${expected.b}`,
            );
          } else {
            c.ok(
              'ply 0 played the opening throw',
              dice[0] === Number(prev.dice.a) && dice[1] === Number(prev.dice.b),
            );
          }
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
          // Shut out by this ply, the other seat's ply is a pass the contract records itself.
          const after = Rules.sidesFor(board, mover);
          const shut =
            led.phase !== Backgammon.BgPhase.decided && bgClosesOut(after.mine, after.opp);
          c.ok(
            `ply ${turn}: the turn counter advanced${shut ? ' past the shut-out seat\u2019s pass' : ''}`,
            Number(led.turn) === turn + (shut ? 2 : 1),
          );
          if (shut)
            console.log(
              `  ply ${turn + 1}: seat ${1 - mover} was shut out -- passed by the contract`,
            );
          if (led.phase === Backgammon.BgPhase.decided) {
            decidedBy = `seat ${mover} bore off its fifteenth checker at ply ${turn}`;
            c.ok(
              'the winner has borne off all fifteen',
              Rules.hasWon(Rules.sidesFor(board, mover).mine) && Number(led.winner) === mover,
            );
          } else {
            // The other seat is to roll -- or, in a one-transaction ply, has been rolled for; after
            // an automatic pass, the mover again.
            const rolledToo = s.entryPoints.includes('resolveRoll');
            const next = shut ? mover : 1 - mover;
            c.ok(
              `ply ${turn}: ${shut ? 'the mover' : 'the other seat'} is to ${rolledToo ? 'move, rolled for in the same transaction' : 'roll'}`,
              Number(led.toMove) === next && led.stage === (rolledToo ? STAGE_MOVE : STAGE_ROLL),
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

    // Custody, from the chain itself: the pot once started, one stake per held slot before.
    c.ok(
      `tx ${i} (${what}): the contract holds exactly its stakes`,
      s.balance === expectedBalance(led),
      `balance ${s.balance}, expected ${expectedBalance(led)}`,
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
