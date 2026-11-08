// Copyright (C) Shielded Technologies
// SPDX-License-Identifier: Apache-2.0

/**
 * The chain-only verifier for a Backgammon table. Given only the table's address, it reads every
 * transaction and the state each one left, and checks:
 *
 *   1. the start seated the two earliest joiners;
 *   2. every roll replays from the secrets the two players revealed (bg-mirror.ts): the opening
 *      from both seats' shares, and who it made move first, then each ply's roll from the secret
 *      its move revealed and the one the move before it revealed, against the dice the move
 *      played. No key, no operator: every input is on the ledger. (That each secret is the one
 *      FORCED from its seat's key is proven in zero knowledge as it is revealed, and is by
 *      construction not checkable from public data.)
 *   3. every ply re-applies to the board before it and gives the board after it
 *      (api/src/backgammon.ts, the circuit's twin);
 *   4. every ply obeyed the two rules the chain does NOT enforce -- play as many dice as you can,
 *      and the larger if only one -- reported as FINDINGS, not failures of the chain;
 *   5. the game ended as the chain says: fifteen borne off, a timeout, or a resignation;
 *   6. custody after every transaction: the contract's real native balance equals its `pot`;
 *   7. the settlement paid the winner pot - 1% at its join-time address and the rake to the
 *      sealed rake address, out of the contract's own balance (zero user inputs).
 *
 * Exit codes follow verify.ts: 0 verified, 1 a check failed, 2 verified with findings (a player broke a rule the chain does not enforce), 3 not settled.
 */

import { Backgammon as Rules } from '@dust-dice/api';
import {
  bgHeldSlots,
  bgOpeningDiceTs,
  bgPlyDiceTs,
  bgStartPick,
  bgStarter,
  forfeitsTs,
  nativeBalanceOf,
} from '@dust-dice/contract';
import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';

import { Checks, addressOf } from './checks.ts';
import { NETWORK } from './config.ts';
import { Backgammon, callOutcomes, readContractState, type BackgammonLedger } from './contracts.ts';
import {
  contractActions,
  sumNative,
  sumNativeFor,
  transactionByHash,
  type ContractAction,
} from './indexer.ts';

const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex');

const STAGE_OPENING = 0n;
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
  /** The calls that took effect. */
  entryPoints: string[];
  /** Calls the chain lists for this transaction but did not apply: their segment failed. */
  failed: string[];
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
    // A partial success lists every call, the ones whose segment failed too: read which applied.
    const outcomes =
      calls[0]!.txStatus === undefined || calls[0]!.txStatus === 'SUCCESS'
        ? undefined
        : await callOutcomes(address, txHash);
    steps.push({
      blockHeight: calls[0]!.blockHeight,
      txHash,
      entryPoints: outcomes
        ? outcomes.filter((o) => o.applied).map((o) => o.entryPoint)
        : calls.map((x) => x.entryPoint ?? '?'),
      failed: outcomes ? outcomes.filter((o) => !o.applied).map((o) => o.entryPoint) : [],
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
  if (eps.includes('move') || eps.includes('openingMove')) return s.turn === p.turn + 1n;
  if (eps.includes('start')) return p.phase === P.filling && s.phase === P.playing;
  if (eps.includes('reveal')) return shareCount(s) === shareCount(p) + 1;
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
    shareCount(l),
    l.board.s0.join(','),
    l.board.s1.join(','),
  ].join('|');
}

/**
 * Whether step `i` is a join whose block gained a slot for every join in it (see the loop): the
 * block's state before it is the after-state of the last step of the block before.
 */
function everyJoinSeated(steps: readonly Step[], i: number): boolean {
  const s = steps[i]!;
  if (!s.entryPoints.includes('join')) return false;
  const first = steps.findIndex((x) => x.blockHeight === s.blockHeight);
  const before = first > 0 ? occupied(steps[first - 1]!.led) : 0;
  const joins = steps.filter(
    (x) => x.blockHeight === s.blockHeight && x.entryPoints.includes('join'),
  ).length;
  return occupied(s.led) - before >= joins;
}

/** How many of the two opening shares are in. */
function shareCount(l: BackgammonLedger): number {
  return [0n, 1n].filter((s) => l.openingShare.lookup(s).some((b) => b !== 0)).length;
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
    `  move timeout   ${final.moveTimeoutSecs} s   table timeout ${final.tableTimeoutSecs} s`,
  );
  console.log(`  phase          ${Backgammon.BgPhase[final.phase]}`);
  // A PRACTICE table (backgammon.compact section 7) pays no winner: each seat's stake goes back to
  // the house if it is the house's, and to the rake address otherwise.
  const house = final.house.bytes;
  const practice = !house.every((b) => b === 0);
  if (practice) console.log(`  practice       house ${hex(house)} (no winner is paid)`);

  if (final.phase !== Backgammon.BgPhase.settled) {
    console.log(
      `\nNOT FINISHED YET: this table is ${Backgammon.BgPhase[final.phase]}. Every roll so far was ` +
        'proven on chain as it was played;\nrun this again once the table has settled for the full ' +
        'replay and the payout.',
    );
    return 3;
  }

  const steps = await readSteps(address);
  console.log(`\n── ${steps.length} transactions ──`);

  let board = Rules.initialBoard();
  const findings: string[] = [];
  let prev: BackgammonLedger | undefined;
  let decidedBy = '';

  for (const [i, s] of steps.entries()) {
    const led = s.led;
    const what = [...s.entryPoints, ...s.failed].join('+');
    if (verbose) console.log(`  tx ${i} ${what} (block ${s.blockHeight})`);

    // A PARTIAL success: the chain applied some of the transaction's segments and not others --
    // a one-transaction ply whose move landed while the operator's roll in it failed its time
    // check after a finality stall. The failed calls changed nothing; the operator rolls again
    // in a transaction of its own, and that roll is checked where it lands.
    if (s.failed.length > 0) {
      console.log(
        `  tx ${i} (${what}): only ${s.entryPoints.join('+') || 'the fee'} took effect -- ` +
          `${s.failed.join('+')} failed on chain (a partial success)`,
      );
    }

    // A call can be INCLUDED and do nothing: built against a state a racing call changed first
    // in the same block (a roll that lost to a resignation), it fails its fallible half and
    // leaves the table as it was. The fee is spent; the game is not touched. Seen live on the
    // devnet 2026-09-25; the Yacht verifier learned the same lesson (bugs-found #34).
    //
    // The indexer keeps ONE state per block, so two transactions of one block read the same
    // after-state whatever each did. Joins are the case that tells them apart: they never
    // conflict, and each that took effect holds one more slot -- so as many slots gained over
    // the block as it has joins means every one of them took a seat (both joins of a game
    // landing together is the normal case since slot joins, 2026-09-29).
    if (prev && stateKey(prev) === stateKey(led) && !everyJoinSeated(steps, i)) {
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
          c.ok(
            'the start leaves both seats owing their share of the opening',
            led.stage === STAGE_OPENING,
          );
          break;
        }

        case 'reveal': {
          if (!prev) break;
          // Which seat revealed: the share that is new in this state.
          const seat = [0n, 1n].find(
            (x) => hex(prev!.openingShare.lookup(x)) !== hex(led.openingShare.lookup(x)),
          );
          c.ok(
            `tx ${i}: a reveal added exactly one seat's share of the opening`,
            seat !== undefined,
          );
          break;
        }

        case 'openingMove':
        case 'move': {
          if (!prev) {
            c.ok(`tx ${i}: a move has a state before it`, false);
            break;
          }
          const turn = Number(prev.turn);
          // The move discloses the roll it played. Ply 0 plays the opening, from both shares, and is
          // the higher die's to play; after it each roll replays from the secret this move revealed
          // and the one the move before it did.
          const opening =
            turn === 0
              ? bgOpeningDiceTs(tableId, [led.openingShare.lookup(0n), led.openingShare.lookup(1n)])
              : null;
          const mover = opening ? bgStarter(opening) : Number(prev.toMove);
          const dice: [number, number] = [Number(led.dice.a), Number(led.dice.b)];
          const expected = opening ?? bgPlyDiceTs(tableId, led.lastSecret, prev.lastSecret, turn);
          if (opening) {
            c.ok(
              "the opening replays from both seats' shares, and the higher die moved first",
              dice[0] === opening.a && dice[1] === opening.b && Number(led.toMove) !== mover,
              `chain ${dice[0]}-${dice[1]}, replay ${opening.a}-${opening.b}; seat ${mover} moved first`,
            );
          } else {
            c.ok(
              `roll ${turn}: replays from the secrets both players revealed`,
              dice[0] === expected.a && dice[1] === expected.b,
              `chain ${dice[0]}-${dice[1]}, replay ${expected.a}-${expected.b}`,
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
          c.ok(`ply ${turn}: the turn counter advanced`, Number(led.turn) === turn + 1);
          if (led.phase === Backgammon.BgPhase.decided) {
            decidedBy = `seat ${mover} bore off its fifteenth checker at ply ${turn}`;
            c.ok(
              'the winner has borne off all fifteen',
              Rules.hasWon(Rules.sidesFor(board, mover).mine) && Number(led.winner) === mover,
            );
          } else {
            c.ok(
              `ply ${turn}: the other seat is to move`,
              Number(led.toMove) === 1 - mover && led.stage === STAGE_MOVE,
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
          decidedBy =
            prev.stage === STAGE_OPENING
              ? `seat ${loser} was eliminated at the opening (a share or ply 0 not sent in time, or a resignation)`
              : Number(prev.toMove) === loser
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
    if (practice) {
      let lost = 0n;
      for (const s of [0n, 1n]) {
        if (forfeitsTs(final.seatIdentity.lookup(s).addr.bytes, house)) lost += 1n;
      }
      const raked = final.tier * lost;
      c.ok(
        'practice: the house got back exactly its own stakes, whoever won',
        sumNativeFor(tx.unshieldedCreatedOutputs, addressOf(tx, house)) === pot - raked,
        `expected ${pot - raked}`,
      );
      c.ok(
        'practice: the rake took every other stake, whole -- no winner was paid',
        sumNativeFor(tx.unshieldedCreatedOutputs, addressOf(tx, final.rakeAddress.bytes)) === raked,
        `expected ${raked}`,
      );
    } else {
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
    }
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
