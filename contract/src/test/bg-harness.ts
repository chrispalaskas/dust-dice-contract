// Copyright (C) Shielded Technologies
// SPDX-License-Identifier: Apache-2.0

/**
 * Testbed for backgammon.compact, and a driver that plays whole games through it.
 *
 * Same conventions as simulator.ts's `TableSimulator`: block time is always explicit (the
 * runtime would default it to wall clock), and the acting party is swapped between calls, because
 * the witnesses belong to different people in production. `asPlayer` holds a seat secret, and
 * with it the seat's side of the VRF: its queries (posted by `join` and `move`) and the
 * unblinding of its answers. `asOperator` holds nothing -- the operator has no witness -- and the
 * operator's answers are computed from the ledger with the table key in `config`.
 *
 * `join` and `resolveRoll` are the only circuits that DECLARE a time, so they take `now` and
 * optionally a different `blockTime`; everything else takes `blockTime` alone.
 */

import type { JubjubPoint } from '@midnight-ntwrk/compact-runtime';

import {
  Contract as BgContract,
  ledger as bgLedger,
  type Ledger as BgLedger,
  type UserAddress,
} from '../managed/backgammon/contract/index.js';
import * as Rules from '../../../api/src/backgammon.ts';
import {
  bgAnswer,
  bgMyRoll,
  bgOpeningPointTs,
  bgQueryFor,
  bgReplayOpening,
  bgClosesOut,
  bgReplayRoll,
  bgResolvePoint,
  bgRollSecretTs,
  type BgDiceTs,
  type BgJoinEntropies,
} from '../bg-mirror.ts';
import { bgStartPick } from '../bg-slots.ts';
import { entropyKeyCommitmentTs } from '../policy-mirror.ts';
import {
  createTablePrivateState,
  NO_GAMMA,
  tableWitnesses,
  type TablePrivateState,
} from '../table-witnesses.ts';
import { vrfPublicKeyOf, vrfSecretFromSeed, type DleqProof } from '../vrf.ts';
import { BaseSimulator, DEFAULT_BLOCK_TIME, userAddress } from './simulator.ts';

export type { BgLedger };

export const STAGE_ROLL = 0n;
export const STAGE_MOVE = 1n;
export const NO_WINNER = 2n;

/** `BgPhase`, as the generated bindings number it. */
export const BG_PHASE = { filling: 0, playing: 1, decided: 2, settled: 3, aborted: 4 } as const;

export type BgConfig = {
  tableId: Uint8Array;
  tier: bigint;
  rakeAddress: UserAddress;
  /** The operator's 32 random bytes; the VRF key is derived from them, as in production. */
  seed: Uint8Array;
  vrfSecret: bigint;
  vrfPublicKey: JubjubPoint;
  moveTimeoutSecs: bigint;
  tableTimeoutSecs: bigint;
  inviteHash: Uint8Array;
};

export function bytes32(fill: number): Uint8Array {
  return new Uint8Array(32).fill(fill);
}

export function defaultBgConfig(overrides: Partial<BgConfig> = {}): BgConfig {
  const tableId = overrides.tableId ?? bytes32(0x42);
  const seed = overrides.seed ?? bytes32(0x5e);
  const vrfSecret = overrides.vrfSecret ?? vrfSecretFromSeed(seed);
  return {
    tableId,
    tier: 10_000n,
    rakeAddress: userAddress(0xaa),
    moveTimeoutSecs: 180n,
    tableTimeoutSecs: 600n,
    inviteHash: new Uint8Array(32),
    ...overrides,
    seed,
    vrfSecret,
    vrfPublicKey: overrides.vrfPublicKey ?? vrfPublicKeyOf(vrfSecret),
  };
}

/** An operator answer, as `resolveRoll` takes it. */
export type BgAnswer = { response: JubjubPoint; proof: DleqProof };

export class BackgammonSimulator extends BaseSimulator<TablePrivateState> {
  bg: BgContract<TablePrivateState>;
  config: BgConfig;
  /** The acting seat's secret, or null when the operator (or a stranger) is acting. */
  sk: Uint8Array | null = null;

  constructor(config: BgConfig) {
    super(createTablePrivateState({}));
    this.bg = new BgContract<TablePrivateState>(tableWitnesses);
    this.config = config;
  }

  static async create(
    config: BgConfig,
    blockTime = DEFAULT_BLOCK_TIME,
  ): Promise<BackgammonSimulator> {
    const sim = new BackgammonSimulator(config);
    sim.blockTime = blockTime;
    await sim.adopt(
      sim.bg.initialState(
        sim.constructorContext(),
        config.tableId,
        config.tier,
        config.rakeAddress,
        config.vrfPublicKey,
        config.moveTimeoutSecs,
        config.tableTimeoutSecs,
        config.inviteHash,
      ),
    );
    return sim;
  }

  getLedger(): BgLedger {
    return bgLedger(this.state);
  }

  asOperator(): void {
    this.sk = null;
    this.privateState = createTablePrivateState({});
  }

  asPlayer(sk: Uint8Array, inviteCode?: Uint8Array): void {
    this.sk = sk;
    this.privateState = createTablePrivateState({ playerSecret: sk, inviteCode });
  }

  /** The acting seat's query for its roll at ply `turn`; the identity when nobody is seated. */
  queryFor(turn: number): JubjubPoint {
    return this.sk ? bgQueryFor(this.sk, this.config.tableId, turn) : NO_GAMMA;
  }

  /** Claim `slot` (the lowest free one when omitted, so tests stay deterministic). */
  join(
    payoutTo: UserAddress,
    now: number,
    blockTime = now,
    slot: number = freeSlots(this.getLedger())[0] ?? 0,
    firstQuery = this.queryFor(1),
  ): Promise<bigint> {
    this.blockTime = blockTime;
    return this.run('join', (ctx) =>
      this.bg.impureCircuits.join(ctx, BigInt(slot), payoutTo, BigInt(now), firstQuery),
    );
  }

  /**
   * The point the operator owes an answer to, read off the ledger as the daemon reads it: at a
   * filling table the opening, from the two joiners `start` will seat; after it the mover's query.
   */
  owedPoint(): JubjubPoint {
    const l = this.getLedger();
    if (Number(l.phase) === BG_PHASE.filling) {
      const pick = bgStartPick(l);
      if (!pick) throw new Error('owedPoint: fewer than two players have joined');
      return bgOpeningPointTs(this.config.tableId, [
        l.joinSlots.lookup(BigInt(pick[0])).entropy,
        l.joinSlots.lookup(BigInt(pick[1])).entropy,
      ]);
    }
    return bgResolvePoint({
      tableId: this.config.tableId,
      turn: l.turn,
      join: joinOf(l),
      query: l.query.lookup(l.toMove),
    });
  }

  /** The honest answer to what the ledger asks, under `secret` (the table's key by default). */
  answer(secret = this.config.vrfSecret): BgAnswer {
    return bgAnswer(secret, this.owedPoint());
  }

  /** The start: seat the two earliest joiners and throw the opening. */
  start(now: number, blockTime = now, answer?: BgAnswer): Promise<{ a: bigint; b: bigint }> {
    this.blockTime = blockTime;
    const { response, proof } = answer ?? this.answer();
    return this.run('start', (ctx) =>
      this.bg.impureCircuits.start(ctx, BigInt(now), response, proof.a1, proof.a2, proof.z),
    );
  }

  resolveRoll(now: number, blockTime = now, answer?: BgAnswer): Promise<[]> {
    this.blockTime = blockTime;
    const { response, proof } = answer ?? this.answer();
    return this.run('resolveRoll', (ctx) =>
      this.bg.impureCircuits.resolveRoll(ctx, BigInt(now), response, proof.a1, proof.a2, proof.z),
    );
  }

  /** Whatever the operator owes: the start at a filling table, else the mover's roll. */
  async roll(now: number, blockTime = now): Promise<void> {
    if (Number(this.getLedger().phase) === BG_PHASE.filling) await this.start(now, blockTime);
    else await this.resolveRoll(now, blockTime);
  }

  /**
   * The acting seat's roll for the ply it owes, as its browser computes it: the opening pair at
   * ply 0 (public), its own unblinded VRF roll after.
   */
  myRoll(): { gamma: JubjubPoint; dice: BgDiceTs } {
    const l = this.getLedger();
    if (l.turn === 0n)
      return { gamma: NO_GAMMA, dice: { a: Number(l.dice.a), b: Number(l.dice.b) } };
    if (!this.sk) throw new Error('myRoll: no seat is acting');
    return bgMyRoll({
      sk: this.sk,
      tableId: this.config.tableId,
      turn: l.turn,
      formedAt: l.query.lookup(l.toMove).formedAt,
      response: l.rollAnswer,
      lastSecret: l.lastSecret,
    });
  }

  move(
    ply: Rules.Ply,
    blockTime = DEFAULT_BLOCK_TIME,
    opts: { gamma?: JubjubPoint; nextQuery?: JubjubPoint } = {},
  ): Promise<bigint> {
    return this.moveEncoded(Rules.encodePly(ply), blockTime, opts);
  }

  moveEncoded(
    enc: Rules.EncodedPly,
    blockTime = DEFAULT_BLOCK_TIME,
    opts: { gamma?: JubjubPoint; nextQuery?: JubjubPoint } = {},
  ): Promise<bigint> {
    this.blockTime = blockTime;
    const turn = Number(this.getLedger().turn);
    const gamma = opts.gamma ?? (this.sk ? this.myRoll().gamma : NO_GAMMA);
    const nextQuery = opts.nextQuery ?? this.queryFor(turn + 2);
    this.privateState = { ...this.privateState, vrfGamma: gamma };
    const moves = enc.moves.map((m) => ({ point: BigInt(m.point), die: BigInt(m.die) }));
    return this.run('move', (ctx) =>
      this.bg.impureCircuits.move(ctx, moves, BigInt(enc.count), nextQuery),
    );
  }

  eliminate(seat: number, voluntary: boolean, blockTime = DEFAULT_BLOCK_TIME): Promise<bigint> {
    this.blockTime = blockTime;
    return this.run('eliminate', (ctx) =>
      this.bg.impureCircuits.eliminate(ctx, BigInt(seat), voluntary),
    );
  }

  settle(secret: bigint, blockTime = DEFAULT_BLOCK_TIME): Promise<bigint> {
    this.blockTime = blockTime;
    const pot = this.getLedger().pot;
    return this.run('settle', (ctx) =>
      this.bg.impureCircuits.settle(ctx, secret, pot / 100n, pot % 100n),
    );
  }

  abortTable(blockTime = DEFAULT_BLOCK_TIME): Promise<bigint> {
    this.blockTime = blockTime;
    return this.run('abortTable', (ctx) => this.bg.impureCircuits.abortTable(ctx));
  }
}

// ---------------------------------------------------------------------------------------------
// Reading the ledger in the rules engine's terms
// ---------------------------------------------------------------------------------------------

export function boardOf(ledger: BgLedger): Rules.Board {
  return {
    s0: ledger.board.s0.map(Number),
    s1: ledger.board.s1.map(Number),
  };
}

/** The ledger's `dice`: the opening pair until ply 0 is played, then the last ply's roll. */
export function diceOf(ledger: BgLedger): [number, number] {
  return [Number(ledger.dice.a), Number(ledger.dice.b)];
}

/** The two seats' join entropies, which the opening hashes. */
export function joinOf(ledger: BgLedger): BgJoinEntropies {
  return [ledger.joinEntropy.lookup(0n), ledger.joinEntropy.lookup(1n)];
}

/** How many slots a filling table has (the contract's `slotCount()`). */
export const SLOT_COUNT = 8;

/** The slots nobody holds, in index order. */
export function freeSlots(ledger: BgLedger): number[] {
  const out: number[] = [];
  for (let i = 0; i < SLOT_COUNT; i++) {
    if (ledger.joinSlots.lookup(BigInt(i)).addr.bytes.every((b) => b === 0)) out.push(i);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// A whole game
// ---------------------------------------------------------------------------------------------

export type Seat = { sk: Uint8Array; addr: UserAddress };

export function seats(): [Seat, Seat] {
  return [
    { sk: bytes32(0x11), addr: userAddress(0x01) },
    { sk: bytes32(0x22), addr: userAddress(0x02) },
  ];
}

/** A small deterministic PRNG so a failing game can be replayed by its seed. */
export function rng(seed: number): () => number {
  let x = seed >>> 0 || 1;
  return () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return (x >>> 0) / 2 ** 32;
  };
}

/** Seat both players at `t`: two joins; the operator's `start` then seats them. */
export async function seatBoth(sim: BackgammonSimulator, players: [Seat, Seat], t: number) {
  sim.asPlayer(players[0].sk);
  await sim.join(players[0].addr, t);
  sim.asPlayer(players[1].sk);
  await sim.join(players[1].addr, t + 1);
}

export type PlayedGame = {
  plies: number;
  /** Plies the contract passed for a closed-out seat (backgammon.compact section 7). */
  autoPasses: number;
  winner: number;
  /** Every roll: what the mover saw, and what a replay from the key recomputes. */
  rolls: { turn: number; mover: number; chain: [number, number]; mirror: [number, number] }[];
  /** The clock after the last move. */
  t: number;
};

/**
 * Play to the end: the operator answers, the mover unblinds its roll and picks a random legal
 * ply from the rules engine, and after every call the chain's board and dice are checked
 * against the engine's and against a replay from the table key. Returns once a seat has borne
 * off its fifteenth checker.
 */
export async function playOut(
  sim: BackgammonSimulator,
  players: [Seat, Seat],
  random: () => number,
  start: number,
  check: (msg: string, ok: boolean) => void,
  /** Pick the ply from the legal ones; a random one by default. */
  choose?: (
    options: Rules.Ply[],
    mine: Rules.Side,
    opp: Rules.Side,
    dice: [number, number],
  ) => Rules.Ply,
): Promise<PlayedGame> {
  let t = start;
  let autoPasses = 0;
  const rolls: PlayedGame['rolls'] = [];
  const { tableId, vrfSecret } = sim.config;
  for (let guard = 0; guard < 4000; guard++) {
    const turn = Number(sim.getLedger().turn);
    sim.asOperator();
    t += 5;
    await sim.roll(t);
    const rolled = sim.getLedger();
    const mover = Number(rolled.toMove);

    sim.asPlayer(players[mover].sk);
    const seen = sim.myRoll().dice;
    const chain: [number, number] = [seen.a, seen.b];
    // The index the mover's query was formed for: this ply, unless an automatic pass carried it.
    const formed = turn === 0 ? 0 : Number(rolled.query.lookup(BigInt(mover)).formedAt);
    const replay =
      turn === 0
        ? bgReplayOpening(vrfSecret, tableId, joinOf(rolled))
        : bgReplayRoll({
            secret: vrfSecret,
            tableId,
            turn,
            formedAt: formed,
            rollSecret: bgRollSecretTs(players[mover].sk, tableId, formed),
            lastSecret: rolled.lastSecret,
          });
    rolls.push({ turn, mover, chain, mirror: [replay.a, replay.b] });
    check(`roll ${turn} matches the replay`, chain[0] === replay.a && chain[1] === replay.b);
    if (turn === 0) check('the opening is never a double', chain[0] !== chain[1]);

    const { mine, opp } = Rules.sidesFor(boardOf(rolled), mover);
    const options = Rules.legalPlies(mine, opp, chain);
    const ply = choose
      ? choose(options, mine, opp, chain)
      : options[Math.floor(random() * options.length)]!;
    const after = Rules.applyPly(mine, opp, chain, ply);
    const otherQuery = rolled.query.lookup(BigInt(1 - mover));

    t += 5;
    await sim.move(ply, t);
    const moved = sim.getLedger();
    const want = Rules.boardFrom(mover, after.mine, after.opp);
    check(
      `ply ${turn}: the chain's board is the rules engine's`,
      JSON.stringify(boardOf(moved)) === JSON.stringify(want),
    );
    check(
      `ply ${turn}: the move disclosed the roll it played`,
      diceOf(moved)[0] === chain[0] && diceOf(moved)[1] === chain[1],
    );
    check(
      `ply ${turn}: the move revealed the roll's forced secret`,
      Buffer.from(moved.lastSecret).equals(
        Buffer.from(bgRollSecretTs(players[mover].sk, tableId, formed)),
      ),
    );
    check(
      `ply ${turn}: the mover's next query is for ply ${turn + 2}`,
      moved.query.lookup(BigInt(mover)).turn === BigInt(turn + 2),
    );
    if (after.won) {
      return { plies: Number(moved.turn), autoPasses, winner: mover, rolls, t };
    }
    // Shut out: the contract passes for the other seat and the mover rolls again, the skipped
    // seat's unanswered query carried two plies on, unchanged.
    const shut = bgClosesOut(after.mine, after.opp);
    if (shut) autoPasses += 1;
    check(
      `ply ${turn}: ${shut ? 'an automatic pass, the mover again' : 'the other seat to roll'}`,
      moved.turn === BigInt(turn + (shut ? 2 : 1)) &&
        Number(moved.toMove) === (shut ? mover : 1 - mover),
    );
    const carried = moved.query.lookup(BigInt(1 - mover));
    check(
      `ply ${turn}: the other seat's query is ${shut ? 'carried forward' : 'untouched'}`,
      carried.turn === otherQuery.turn + (shut ? 2n : 0n) &&
        carried.formedAt === otherQuery.formedAt,
    );
  }
  throw new Error('playOut: no winner after 4000 plies');
}

export { entropyKeyCommitmentTs, userAddress, DEFAULT_BLOCK_TIME };
