// Copyright (C) Shielded Technologies
// SPDX-License-Identifier: Apache-2.0

/**
 * THE PURE HALF of the read side: ledger types, the shape of a game, and the constants the
 * driver and the verifier share. Nothing here touches the network, the file system or Node's
 * `Buffer`, so the game checks (yacht.ts, backgammon.ts) can run in a browser -- the /verify page
 * runs this very code. contracts.ts re-exports all of it next to the reads that need Node.
 */

import {
  Table,
  Lobby,
  Backgammon,
  answered,
  answerKey,
  askedIndex,
  STAGE as LEDGER_STAGE_VALUES,
} from '@dust-dice/contract';

export { Table, Lobby, Backgammon };

export type TableLedger = Table.Ledger;
export type BackgammonLedger = Backgammon.Ledger;
export type LobbyLedger = Lobby.Ledger;

/** Lower-case hex of some bytes, without Node's `Buffer`. */
export const hex = (b: Uint8Array): string =>
  Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

/** `Dice` as the plain five-element array everything else in this repo speaks. */
export function diceToArray(d: Table.Dice): number[] {
  return [d.d0, d.d1, d.d2, d.d3, d.d4].map(Number);
}

// ---------------------------------------------------------------------------------------
// The shape of a game, restated for the driver and the verifier
// ---------------------------------------------------------------------------------------
//
// These mirror `table.compact` and are restated here rather than imported because the generated
// bindings spell them as plain `Uint<8>` values (they are not Compact `enum`s) and because both
// the driver and the chain-only verifier need them. See docs/table-interface.md.

/** Rounds per seat: 0..12, thirteen of them, one category each. `roundCount()`. */
export const ROUND_COUNT = 13;

/** The last round a seat plays. Completing it completes the scorecard. */
export const FINAL_ROUND = 12;

/** `playerMove` kinds. */
export const MOVE_OPEN = 0;
export const MOVE_HOLD = 1;
export const MOVE_SCORE = 2;

/**
 * A seat's EFFECTIVE stage: where its turn is, counting the operator's answer.
 *
 * The ledger's own `seatTurn.stage` is written by the player's moves only -- 0 idle, then
 * "asked roll k" for k = 1..3 (`LEDGER_STAGE`) -- and the operator's `resolveRoll` answers into
 * the separate `vrfAnswer` map without touching it (table.compact, the state machine above
 * `stageIdle`; bugs-found #35 for why). Clients want the older, finer picture: has the roll the
 * seat asked for been ANSWERED yet? That is one more read, so it is folded in here:
 *
 *     asked roll k, unanswered  ->  2k - 1   (1, 3, 5: the operator owes)
 *     asked roll k, answered    ->  2k       (2, 4, 6: the player owes)
 *
 * EVEN STAGES ARE OWED BY THE PLAYER, ODD ONES BY THE OPERATOR -- exactly the split the driver
 * dispatches on and the contract's `playerOwes` divides on, so nothing downstream changed.
 */
export const STAGE = {
  idle: 0,
  awaitRoll1: 1,
  rolled1: 2,
  awaitRoll2: 3,
  rolled2: 4,
  awaitRoll3: 5,
  rolled3: 6,
} as const;

/** The ledger's own numbering: 0 idle, 1..3 "asked roll k". */
export { STAGE as LEDGER_STAGE } from '@dust-dice/contract';

/** The effective stage of one seat -- see `STAGE`. */
export function effectiveStage(led: TableLedger, seat: number): number {
  const turn = led.seatTurn.lookup(BigInt(seat));
  const asked = Number(turn.stage);
  if (asked === LEDGER_STAGE_VALUES.idle) return STAGE.idle;
  const cell = led.vrfAnswer.lookup(answerKey(seat, askedIndex(asked)));
  return answered(turn, cell) ? 2 * asked : 2 * asked - 1;
}

/** Is this seat's next move the player's? */
export const playerOwes = (stage: number): boolean => stage % 2 === 0;

/** The canonical "no mask" sentinel every `playerMove` kind but `hold` must carry. */
export const NO_MASK: boolean[] = [false, false, false, false, false];

/** The canonical "no entropy" sentinel every kind but `open` must carry. */
export const ZERO_BYTES32 = (): Uint8Array => new Uint8Array(32);

/** One seat's position, as the driver reads it off the ledger. */
export interface SeatView {
  seat: number;
  /** The next round this seat owes; `ROUND_COUNT` means finished or eliminated. */
  round: number;
  stage: number;
  eliminated: boolean;
  /** The dice as of the most recent resolved roll of the current turn. */
  roll: number[];
}

export function seatView(led: TableLedger, seat: number): SeatView {
  const prog = led.seatProgress.lookup(BigInt(seat));
  const turn = led.seatTurn.lookup(BigInt(seat));
  return {
    seat,
    round: Number(prog.round),
    stage: effectiveStage(led, seat),
    eliminated: prog.eliminated,
    // At an even stage this is the PREVIOUS reveal: the roll just answered is in the answer
    // cell, blinded, and only the seat can read it (see the CLI driver's `revealedRoll`).
    roll: diceToArray(turn.roll),
  };
}

/** Every seated slot's view, in seat order. */
export function seatViews(led: TableLedger): SeatView[] {
  return Array.from({ length: Number(led.seatCount) }, (_, s) => seatView(led, s));
}

/**
 * The penalty split `eliminate` requires: `q * 13 + rem == tier * (round + 1)`, `rem < 13`.
 *
 * Compact has no division, so the caller supplies the quotient and remainder and the circuit
 * checks the Euclidean identity -- which has exactly one solution, so supplying them grants no
 * discretion. `round + 1` reconciles the contract's 0-based rounds with the design note's
 * 1..13 numbering: a seat that never played at all forfeits a thirteenth, not nothing.
 */
export function penaltySplit(tier: bigint, round: number): { q: bigint; rem: bigint } {
  const numer = tier * BigInt(round + 1);
  return { q: numer / 13n, rem: numer % 13n };
}

/** The per-seat 1% rake on `tier` that `abortTable` requires, on every path. */
export function perSeatRake(tier: bigint): { q: bigint; rem: bigint } {
  return { q: tier / 100n, rem: tier % 100n };
}
