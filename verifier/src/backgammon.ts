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
 * Verdicts (report.ts): verified, failed, findings (verified, and a player broke a rule the chain
 * does not enforce), not-settled.
 */

import { Backgammon as Rules } from '@dust-dice/api';
import {
  bgOpeningDiceTs,
  bgPlyDiceTs,
  bgStartPick,
  bgStarter,
  forfeitsTs,
} from '@dust-dice/contract';

import { Backgammon, hex, type BackgammonLedger } from './game.ts';
import {
  BG_STAGE_OPENING as STAGE_OPENING,
  everyJoinSeated,
  occupied,
  stateKey,
  sumOut,
  sumOutFor,
  type BackgammonRecord,
} from './record.ts';
import type { Report, Verdict } from './report.ts';

const STAGE_MOVE = 1n;

/** What the contract should hold: the pot once started, one stake per held slot while filling. */
function expectedBalance(led: BackgammonLedger): bigint {
  return led.phase === Backgammon.BgPhase.filling ? led.tier * BigInt(occupied(led)) : led.pot;
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

/** Check a Backgammon table's whole public record, reporting through `c`. */
export async function verifyBackgammon(record: BackgammonRecord, c: Report): Promise<Verdict> {
  c.at(undefined);
  c.section('table, as deployed');
  const final = await record.final();
  const tableId = final.tableId;
  c.note(`Backgammon table ${record.address}`);
  c.note(`tableId        ${hex(tableId)}`);
  c.note(`tier           ${final.tier}`);
  c.note(`move timeout   ${final.moveTimeoutSecs} s   table timeout ${final.tableTimeoutSecs} s`);
  c.note(`phase          ${Backgammon.BgPhase[final.phase]}`);
  // A PRACTICE table (backgammon.compact section 7) pays no winner: each seat's stake goes back to
  // the house if it is the house's, and to the rake address otherwise.
  const house = final.house.bytes;
  const practice = !house.every((b) => b === 0);
  if (practice) c.note(`practice       house ${hex(house)} (no winner is paid)`);

  if (final.phase !== Backgammon.BgPhase.settled) {
    c.note(
      `NOT FINISHED YET: this table is ${Backgammon.BgPhase[final.phase]}. Every roll so far was ` +
        'proven on chain as it was played; run this again once the table has settled for the ' +
        'full replay and the payout.',
    );
    return 'not-settled';
  }

  const steps = await record.history();
  c.section(`${steps.length} transactions`);

  let board = Rules.initialBoard();
  const findings: string[] = [];
  let prev: BackgammonLedger | undefined;
  let decidedBy = '';

  for (const [i, s] of steps.entries()) {
    const led = s.led;
    const what = [...s.entryPoints, ...s.failed].join('+');
    c.at(s);

    // A PARTIAL success: the chain applied some of the transaction's segments and not others --
    // a one-transaction ply whose move landed while the operator's roll in it failed its time
    // check after a finality stall. The failed calls changed nothing; the operator rolls again
    // in a transaction of its own, and that roll is checked where it lands.
    if (s.failed.length > 0) {
      c.note(
        `tx ${i} (${what}): only ${s.entryPoints.join('+') || 'the fee'} took effect -- ` +
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
      c.note(`tx ${i} (${what}): landed without effect -- a racing call changed the table first`);
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
          c.note(
            `tx ${i}: the start seated the two earliest of ${n} joiner(s)` +
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
            c.note(`tx ${i}: a seat left the filling table and was refunded`);
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
          c.note(`(unrecognised entry point '${ep}' -- ignored)`);
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

  c.at('summary');
  c.section('the result');
  c.note(decidedBy || 'the log does not say how the game was decided');
  c.ok('the log shows how the game was decided', decidedBy !== '');
  c.ok('the final board is the replayed board', sameBoard(board, boardOf(final)));

  c.section('the payout');
  const settleStep = steps.find((st) => st.entryPoints.includes('settle'));
  if (settleStep) c.at(settleStep);
  if (!settleStep) {
    c.ok('the settle transaction is in the log', false);
  } else {
    const tx = await record.tx(settleStep.txHash);
    const before = steps[steps.indexOf(settleStep) - 1]!.led;
    const pot = before.pot;
    const q = pot / 100n;
    const winnerAddr = final.seatIdentity.lookup(final.winner).addr.bytes;
    c.note(`settle tx ${tx.hash} in block ${tx.blockHeight}; pot ${pot}`);
    c.ok('the pot was both stakes', pot === final.tier * 2n, `pot ${pot}`);
    c.ok('settle spent ZERO user inputs', sumOut(tx.spent) === 0n);
    c.ok('settle created exactly the pot', sumOut(tx.created) === pot);
    if (final.tier === 0n) {
      // A free table (backgammon.compact section 8): no stake, so nothing to pay anyone.
      c.ok(
        'free table: the pot was 0 and settle created nothing',
        pot === 0n && sumOut(tx.created) === 0n,
      );
    } else if (practice) {
      let lost = 0n;
      for (const s of [0n, 1n]) {
        if (forfeitsTs(final.seatIdentity.lookup(s).addr.bytes, house)) lost += 1n;
      }
      const raked = final.tier * lost;
      c.ok(
        'practice: the house got back exactly its own stakes, whoever won',
        sumOutFor(tx.created, house) === pot - raked,
        `expected ${pot - raked}`,
      );
      c.ok(
        'practice: the rake took every other stake, whole -- no winner was paid',
        sumOutFor(tx.created, final.rakeAddress.bytes) === raked,
        `expected ${raked}`,
      );
    } else {
      c.ok(
        `the winner (seat ${final.winner}) was paid pot - 1% at its join-time address`,
        sumOutFor(tx.created, winnerAddr) === pot - q,
        `expected ${pot - q}`,
      );
      c.ok(
        'the rake was paid 1% at the address sealed at deploy',
        sumOutFor(tx.created, final.rakeAddress.bytes) === q,
        `expected ${q}`,
      );
    }
    c.ok('the pot is empty afterwards', final.pot === 0n);
  }

  if (findings.length > 0) {
    c.at('summary');
    c.section(`${findings.length} ply(s) broke a rule the chain does not enforce`);
    for (const f of findings) c.note(f);
    c.note(
      'The chain checks every checker, but not that a ply plays as many dice as it can, nor ' +
        'that a lone playable die is the larger. The dice and the payout above are unaffected.',
    );
  }
  if (c.failed > 0) return 'failed';
  return findings.length > 0 ? 'findings' : 'verified';
}
