// Copyright (C) Shielded Technologies
// SPDX-License-Identifier: Apache-2.0

/**
 * THE ONE PLACE A CLIENT TURNS AN ANSWER INTO DICE.
 *
 * A seat that has asked for a roll and been answered holds, between its turn and its answer
 * cell, everything needed to see the dice: the query it committed, the operator's `S = x*B`,
 * and -- from its own secret -- the blinding `rho` it used. `Gamma = rho^-1 * S` and the dice
 * follow from `Gamma` exactly as the contract derives them at the next move (`playerMove` in
 * table.compact): roll 1 from the roll context of index 0, a reroll from the context of ITS
 * index and then merged under the hold it was taken under.
 *
 * Four clients used to carry their own copy of this (the browser gateway, the CLI's fast
 * assembler, the game driver, the verifiers), and on 2026-09-21 the browser's drifted: it built
 * rerolls from index 0 and showed two players Full Houses the chain scored as 0. The proofs were
 * right -- the witnesses came from this same answer -- only the display lied. Hence one function,
 * and a test (reveal.test.ts) that pins it to the contract for all three indices.
 */

import type { JubjubPoint } from '@midnight-ntwrk/compact-runtime';
import { firstRollTs, rerollUnderMaskTs } from './policy-mirror.ts';
import {
  answered,
  askedIndex,
  deriveBlinding,
  packHoldMask,
  rollDigest,
  STAGE,
  unblind,
} from './vrf.ts';

/** The parts of `seatTurn[seat]` the reveal reads. Structural, so any ledger view fits. */
export interface RevealTurn {
  stage: bigint;
  round: bigint;
  blinded: JubjubPoint;
  mixed: Uint8Array;
  hold1: { bits: boolean[] };
  hold2: { bits: boolean[] };
  roll: { d0: bigint; d1: bigint; d2: bigint; d3: bigint; d4: bigint };
}

/** The parts of `vrfAnswer[answerKey(seat, index)]` the reveal reads. */
export interface RevealCell {
  round: bigint;
  blinded: JubjubPoint;
  response: JubjubPoint;
}

export interface RevealInputs {
  tableId: Uint8Array;
  seatSecret: Uint8Array;
  turn: RevealTurn;
  /** The seat's answer cell for the roll `turn.stage` is asking about. */
  cell: RevealCell;
  /**
   * The blinding to unblind with. Derived from the secret and the roll's position when omitted
   * (`deriveBlinding`, what every client uses); a caller that blinded with something else -- the
   * contract simulator's tests do -- passes it.
   */
  rho?: bigint;
}

export interface Reveal {
  /** 0..2: which roll of the turn this is. */
  index: number;
  /** The hold the roll was taken UNDER (all false for roll 1). */
  priorHold: boolean[];
  rho: bigint;
  gamma: JubjubPoint;
  /** The five dice the seat is looking at -- what its next move will prove. */
  dice: number[];
}

const NO_HOLD: boolean[] = [false, false, false, false, false];

/**
 * The dice a seat is looking at, or `null` when there is nothing to see: the seat is idle, or it
 * has asked and the cell does not yet answer THIS query (wrong round, wrong `B`, or the sentinel).
 */
export function revealFor(inputs: RevealInputs): Reveal | null {
  const { tableId, seatSecret, turn, cell } = inputs;
  if (Number(turn.stage) === STAGE.idle || !answered(turn, cell)) return null;
  const index = askedIndex(turn.stage);
  const priorHold = index === 0 ? NO_HOLD : [...(index === 1 ? turn.hold1 : turn.hold2).bits];
  const rho =
    inputs.rho ??
    deriveBlinding({
      seatSecret,
      tableId,
      round: turn.round,
      rollIndex: BigInt(index),
      holdMask: packHoldMask(priorHold),
    });
  const gamma = unblind(cell.response, rho);
  const digest = rollDigest(gamma);
  const round = Number(turn.round);
  const previous = [turn.roll.d0, turn.roll.d1, turn.roll.d2, turn.roll.d3, turn.roll.d4].map(
    Number,
  );
  const dice =
    index === 0
      ? firstRollTs(tableId, digest, turn.mixed, round)
      : rerollUnderMaskTs(tableId, digest, turn.mixed, round, index, priorHold, previous);
  return { index, priorHold, rho, gamma, dice };
}
