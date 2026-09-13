// Copyright (C) Shielded Technologies
// SPDX-License-Identifier: Apache-2.0

/**
 * What a stuck table needs next, so anyone can walk it to the point where seats can redeem.
 *
 * A stake leaves a table only through `redeem`, and `redeem` pays only once the table is
 * terminal (settled or aborted). Reaching that can need up to two transactions first, and none
 * of them needs the operator — the deadlines are on chain and the circuits check them, which is
 * the property that makes staking here defensible: a player can always walk their own money out.
 *
 * On 2026-09-13 a live table sat for hours holding 200 NIGHT with nobody able to do anything:
 * one seat had walked away, the operator's elimination pass was suppressed by a bug in its
 * outage grace, and the table page offered no way to do what the contract would have accepted
 * from any passer-by. This function is what the page asks so it can offer the right button.
 *
 * It is deliberately conservative — when a deadline has not passed, or the phase is already
 * terminal, it offers NOTHING rather than inviting a transaction the circuit would refuse and
 * the caller would pay a fee for.
 */

import type { Ledger as TableLedger } from './managed/table/contract/index.js';

/** Rounds per seat, as `table.compact`'s `roundCount()` fixes it. */
const ROUND_COUNT = 13;

/** `Phase` as the generated bindings spell it — plain numbers, not a Compact enum. */
const PHASE = { filling: 0, playing: 1, settled: 2, aborted: 3, abandoned: 4 } as const;

/** One thing that can be done right now to move a table towards paying out. */
export type RescueStep =
  | { readonly kind: 'none'; readonly why: string }
  /** `eliminate(seat, q, rem, voluntary=false)` — enforce a missed deadline. */
  | { readonly kind: 'eliminate'; readonly seat: number; readonly why: string }
  /** `abortTable(q, rem, now)` — finish a table that cannot finish itself. */
  | { readonly kind: 'abort'; readonly why: string };

export function nextRescueStep(led: TableLedger, nowSecs: bigint): RescueStep {
  const phase = Number(led.phase);

  if (phase === PHASE.settled || phase === PHASE.aborted) {
    return { kind: 'none', why: 'The table has finished; each seat can redeem what it is owed.' };
  }

  // Every seat eliminated is a PENDING terminal state, not a payable one: the penalties are
  // still charged and the pot still holds them. `abortTable` waives them and pays the rake.
  if (phase === PHASE.abandoned) {
    return {
      kind: 'abort',
      why:
        'Every seat is out, which is a pending state rather than a payable one. One call to ' +
        'abortTable waives every elimination penalty and makes the stakes redeemable.',
    };
  }

  const deadlinePassed = nowSecs > led.roundDeadline;

  if (phase === PHASE.filling) {
    return deadlinePassed
      ? {
          kind: 'abort',
          why: 'This table never filled and its deadline has passed. Aborting refunds every seat in full.',
        }
      : { kind: 'none', why: 'The table is still filling and its deadline has not passed.' };
  }

  if (phase !== PHASE.playing) return { kind: 'none', why: 'Nothing to do.' };

  if (!deadlinePassed) return { kind: 'none', why: 'The round deadline has not passed yet.' };
  if (Number(led.openRound) >= ROUND_COUNT) {
    return { kind: 'none', why: 'The last round is closing; the table settles from here.' };
  }

  // A seat still in the game that has not played the open round is what stops the table. The
  // circuit refuses if it has in fact already played, so this checks the same thing it does.
  for (let seat = 0; seat < Number(led.seatCount); seat++) {
    const progress = led.seatProgress.lookup(BigInt(seat));
    if (!progress.eliminated && progress.round === led.openRound) {
      return {
        kind: 'eliminate',
        seat,
        why:
          `Seat ${seat + 1} has not played round ${Number(led.openRound) + 1} and its deadline ` +
          'has passed. Eliminating it moves the table towards a state where everyone can redeem.',
      };
    }
  }

  // Nobody owes a move, so what is missing is the operator's own half of a turn. That is the
  // `operatorStalled` branch of `abortTable`, which the circuit gates on its own longer grace —
  // offer it, and let the circuit refuse if the grace has not run out yet.
  return {
    kind: 'abort',
    why:
      'Every remaining seat is waiting on the operator rather than the other way round. Once the ' +
      'operator grace has passed, aborting returns the stakes.',
  };
}
