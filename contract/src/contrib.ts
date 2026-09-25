// Copyright (C) Shielded Technologies
// SPDX-License-Identifier: Apache-2.0

/**
 * The off-chain half of the ON-CHAIN table's randomness: the seats' contributions
 * (reveal-core.compact), the dice they produce, and the phase schedule `eliminate` enforces.
 *
 * EVERY HASH GOES THROUGH THE CONTRACT'S OWN PURE CIRCUITS, as vrf.ts does, so a client, the
 * operator, the verifier and the tests all derive a roll from the same code the proof runs.
 * The protocol is docs/reveal-dice.md. In one line: every roll is `H(tableId, round, rollIndex,
 * v_0..v_5)` over one contribution per live seat, each `H(sk_s, tableId, round, rollIndex)`, and
 * a contribution to roll k is revealed only once every seat still rolling has fixed the hold
 * before roll k -- so nobody can compute a roll before the decision it would have informed is
 * on chain.
 *
 * `seatObligation` is THE mirror of the circuit's elimination rule and the one place a client
 * should ask "what does this seat owe right now, and since when". The operator's lifecycle, the
 * rescue panel and the turn panel all read it; a divergence between them and the circuit is a
 * proposed transaction the chain refuses, which is exactly what this module exists to prevent.
 */

import { pureCircuits } from './managed/table/contract/index.js';
import { firstRollTs, rerollUnderMaskTs } from './policy-mirror.ts';
import { askedIndex, STAGE } from './vrf.ts';

/** `noRevealRound()`: a cell nobody has revealed into. */
export const NO_REVEAL_ROUND = 255n;
/** `noRevealKey()`: the cell an open reads, never written after the constructor. */
export const NO_REVEAL_KEY = 255n;
/** The roll indices a seat reveals through `revealEntropy`; roll 0's rides on the open. */
export const REVEALED_ROLLS = [1, 2] as const;
/** Slots of the phase schedule, from `roundOpenedAt`, as `eliminate` numbers them. */
export const SLOT = {
  open: 1,
  decide1: 2,
  reveal1: 3,
  decide2: 4,
  reveal2: 5,
  score: 6,
} as const;

/** `revealKey`: where `seatReveal` keeps `seat`'s contribution to roll `rollIndex` (0..2). */
export function revealKey(seat: number | bigint, rollIndex: number | bigint): bigint {
  return BigInt(seat) * 3n + BigInt(rollIndex);
}

/** A seat's contribution to one roll: `H("contrib", tableId, round‖rollIndex, sk)`. */
export function contributionTs(
  sk: Uint8Array,
  tableId: Uint8Array,
  round: number | bigint,
  rollIndex: number | bigint,
): Uint8Array {
  return pureCircuits.contribution(sk, tableId, BigInt(round), BigInt(rollIndex));
}

/** The 32 bytes a roll's dice come from: `H("roll", tableId, round‖rollIndex, v_0..v_5)`. */
export function revealRollDigestTs(
  tableId: Uint8Array,
  round: number | bigint,
  rollIndex: number | bigint,
  values: readonly Uint8Array[],
): Uint8Array {
  if (values.length !== 6) throw new Error('revealRollDigest takes exactly six slots');
  return pureCircuits.revealRollDigest(tableId, BigInt(round), BigInt(rollIndex), [...values]);
}

/**
 * The round's digest for one roll, from the secrets of the seats that contribute.
 *
 * `contributors[s]` is slot `s`'s secret, or null for a slot that contributes the fixed zero:
 * absent, eliminated before the round, or eliminated in it without having revealed. What a
 * test or a replay computes before anything is on chain; `chainRollDigest` below reads the same
 * value off a ledger.
 */
export function chainDigestFor(
  tableId: Uint8Array,
  round: number | bigint,
  rollIndex: number | bigint,
  contributors: ReadonlyArray<Uint8Array | null>,
): Uint8Array {
  if (contributors.length !== 6) throw new Error('chainDigestFor takes exactly six slots');
  return revealRollDigestTs(
    tableId,
    round,
    rollIndex,
    contributors.map((sk) =>
      sk === null ? new Uint8Array(32) : contributionTs(sk, tableId, round, rollIndex),
    ),
  );
}

// -------------------------------------------------------------------------------------------
// Reading the ledger
// -------------------------------------------------------------------------------------------

/** `RevealCell`, structurally. */
export interface RevealCellTs {
  round: bigint;
  value: Uint8Array;
  out: boolean;
}

/** The parts of a table's ledger the on-chain path reads. Structural, so any view fits. */
export interface ChainLedgerView {
  tableId: Uint8Array;
  fastMode: boolean;
  seatCount: bigint;
  openRound: bigint;
  roundOpenedAt: bigint;
  phaseSecs: bigint;
  seatReveal: { lookup(key: bigint): RevealCellTs };
  seatTurn: {
    lookup(key: bigint): {
      stage: bigint;
      round: bigint;
      mixed: Uint8Array;
      hold1: { bits: boolean[] };
      hold2: { bits: boolean[] };
      roll: { d0: bigint; d1: bigint; d2: bigint; d3: bigint; d4: bigint };
    };
  };
  seatProgress: { lookup(key: bigint): { round: bigint; eliminated: boolean } };
}

/** `revealedFor`: has this slot said all it will about a roll of round `r`. */
export const revealedFor = (c: RevealCellTs, r: bigint): boolean => c.out || c.round === r;

/** `contributionOf`: the slot's value for THIS round, else the fixed zero. */
export const contributionOf = (c: RevealCellTs, r: bigint): Uint8Array =>
  c.round === r ? c.value : new Uint8Array(32);

const SLOTS = [0, 1, 2, 3, 4, 5] as const;

/** `allRevealedFor`: every live slot has revealed its contribution to roll `k` of the open round. */
export function allRevealedFor(led: ChainLedgerView, rollIndex: number): boolean {
  const r = led.openRound;
  return SLOTS.every(
    (s) =>
      BigInt(s) >= led.seatCount || revealedFor(led.seatReveal.lookup(revealKey(s, rollIndex)), r),
  );
}

/** The six contributions to roll `k` of the open round, as the circuit hashes them. */
export function contributionsFor(led: ChainLedgerView, rollIndex: number): Uint8Array[] {
  const r = led.openRound;
  return SLOTS.map((s) => contributionOf(led.seatReveal.lookup(revealKey(s, rollIndex)), r));
}

/** The digest of roll `k` of the open round, off the ledger. Meaningful once `allRevealedFor`. */
export function chainRollDigest(led: ChainLedgerView, rollIndex: number): Uint8Array {
  return revealRollDigestTs(
    led.tableId,
    led.openRound,
    rollIndex,
    contributionsFor(led, rollIndex),
  );
}

const NO_HOLD: boolean[] = [false, false, false, false, false];

export interface ChainReveal {
  /** 0..2: which roll of the turn this is. */
  index: number;
  /** The hold the roll was taken UNDER (all false for roll 1). */
  priorHold: boolean[];
  /** The five dice the seat is looking at -- what its next move will prove. */
  dice: number[];
}

/**
 * The dice a seat is looking at on an ON-CHAIN table, or null when there is nothing to see: the
 * seat is idle, or not every contribution to the roll it is waiting on is in yet.
 *
 * The on-chain analogue of `revealFor` (reveal.ts): same ladder, same merge, and the digest
 * comes from the six public cells instead of an unblinded answer. Needs no secret at all --
 * anyone watching the table sees every seat's roll the moment the reveals complete.
 */
export function chainRevealFor(led: ChainLedgerView, seat: number): ChainReveal | null {
  const turn = led.seatTurn.lookup(BigInt(seat));
  if (Number(turn.stage) === STAGE.idle) return null;
  const index = askedIndex(turn.stage);
  if (!allRevealedFor(led, index)) return null;
  const priorHold = index === 0 ? NO_HOLD : [...(index === 1 ? turn.hold1 : turn.hold2).bits];
  const digest = chainRollDigest(led, index);
  const round = Number(turn.round);
  const previous = [turn.roll.d0, turn.roll.d1, turn.roll.d2, turn.roll.d3, turn.roll.d4].map(
    Number,
  );
  const dice =
    index === 0
      ? firstRollTs(led.tableId, digest, turn.mixed, round)
      : rerollUnderMaskTs(led.tableId, digest, turn.mixed, round, index, priorHold, previous);
  return { index, priorHold, dice };
}

// -------------------------------------------------------------------------------------------
// The phase schedule -- the mirror of `eliminate`
// -------------------------------------------------------------------------------------------

/** `slotViewFor`: what one slot says about the barrier for roll `k`. */
export function slotViewFor(
  led: ChainLedgerView,
  s: number,
  rollIndex: number,
): { decided: boolean; asking: boolean } {
  const r = led.openRound;
  const p = led.seatProgress.lookup(BigInt(s));
  const t = led.seatTurn.lookup(BigInt(s));
  const live = BigInt(s) < led.seatCount && !p.eliminated;
  const k = BigInt(rollIndex);
  return {
    decided: !live || p.round > r || t.stage > k,
    asking: live && p.round === r && t.stage === k + 1n,
  };
}

/** The barrier for roll `k`: every slot is past the decision this roll would inform. */
export const holdsInFor = (led: ChainLedgerView, rollIndex: number): boolean =>
  SLOTS.every((s) => slotViewFor(led, s, rollIndex).decided);

/** Some live seat is waiting for roll `k`, so everyone's contribution to it is owed. */
export const anyAskingFor = (led: ChainLedgerView, rollIndex: number): boolean =>
  SLOTS.some((s) => slotViewFor(led, s, rollIndex).asking);

export type ObligationKind = 'open' | 'decide' | 'reveal' | 'score';

/** What a seat owes right now, unblocked, and the block time past which it is eliminable for it. */
export interface Obligation {
  readonly kind: ObligationKind;
  /** The roll the obligation is about: the one to decide on, or the one to reveal for. */
  readonly rollIndex: number;
  readonly slot: number;
  /** `roundOpenedAt + slot * phaseSecs`: strictly past this, `eliminate` accepts. */
  readonly dueAt: bigint;
}

/**
 * `eliminate`'s on-chain rule, exactly: the one obligation seat `s` owes that is UNBLOCKED, or
 * null when it is blocked behind other seats (or has nothing left to do this round).
 *
 * Meaningless on a fast table (which keeps the single round deadline) and for an eliminated
 * seat; both return null.
 */
export function seatObligation(led: ChainLedgerView, seat: number): Obligation | null {
  if (led.fastMode || BigInt(seat) >= led.seatCount) return null;
  const r = led.openRound;
  const prog = led.seatProgress.lookup(BigInt(seat));
  if (prog.eliminated) return null;
  const stage = Number(led.seatTurn.lookup(BigInt(seat)).stage);
  const scored = prog.round > r;
  const own1 = led.seatReveal.lookup(revealKey(seat, 1));
  const own2 = led.seatReveal.lookup(revealKey(seat, 2));

  const owesOpen = !scored && stage === STAGE.idle;
  const owesDecide1 = stage === STAGE.askedRoll1 && allRevealedFor(led, 0);
  const owesReveal1 =
    (scored || stage >= STAGE.askedRoll2) &&
    !revealedFor(own1, r) &&
    holdsInFor(led, 1) &&
    anyAskingFor(led, 1);
  const owesDecide2 = stage === STAGE.askedRoll2 && revealedFor(own1, r) && allRevealedFor(led, 1);
  const owesReveal2 =
    (scored || stage >= STAGE.askedRoll3) &&
    !revealedFor(own2, r) &&
    holdsInFor(led, 2) &&
    anyAskingFor(led, 2);
  const owesScore = stage === STAGE.askedRoll3 && revealedFor(own2, r) && allRevealedFor(led, 2);

  const pick = (kind: ObligationKind, rollIndex: number, slot: number): Obligation => ({
    kind,
    rollIndex,
    slot,
    dueAt: led.roundOpenedAt + BigInt(slot) * led.phaseSecs,
  });
  if (owesOpen) return pick('open', 0, SLOT.open);
  if (owesDecide1) return pick('decide', 0, SLOT.decide1);
  if (owesReveal1) return pick('reveal', 1, SLOT.reveal1);
  if (owesDecide2) return pick('decide', 1, SLOT.decide2);
  if (owesReveal2) return pick('reveal', 2, SLOT.reveal2);
  if (owesScore) return pick('score', 2, SLOT.score);
  return null;
}

/** The seats `eliminate` would accept right now, in seat order. */
export function eliminableSeats(led: ChainLedgerView, nowSecs: bigint): number[] {
  const out: number[] = [];
  for (let s = 0; s < Number(led.seatCount); s++) {
    const o = seatObligation(led, s);
    if (o !== null && nowSecs > o.dueAt) out.push(s);
  }
  return out;
}
