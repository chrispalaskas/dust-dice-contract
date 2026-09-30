// Copyright (C) Shielded Technologies
// SPDX-License-Identifier: Apache-2.0

/**
 * Testbed for backgammon.compact, and a driver that plays whole games through it.
 *
 * Same conventions as simulator.ts's `TableSimulator`: block time is always explicit (the
 * runtime would default it to wall clock), and the acting party is swapped between calls, because
 * the witnesses belong to different people in production. `asPlayer` holds a seat secret -- all a
 * seat needs to reveal its share of the opening and to compute and play its own rolls.
 * `asOperator` holds nothing: the operator has no part in the dice, only in starting, timing out
 * and settling a table, all of which anyone may do.
 *
 * `join`, `start`, `reveal` and `move` DECLARE a time, so they take `now` and optionally a
 * different `blockTime`; everything else takes `blockTime` alone.
 */

import {
  Contract as BgContract,
  ledger as bgLedger,
  type Ledger as BgLedger,
  type UserAddress,
} from '../managed/backgammon/contract/index.js';
import * as Rules from '../../../api/src/backgammon.ts';
import {
  bgMyRoll,
  bgOpeningDiceTs,
  bgPlyDiceTs,
  bgRollSecretTs,
  bgStarter,
  type BgDiceTs,
  type BgOpeningShares,
} from '../bg-mirror.ts';
import { entropyKeyCommitmentTs } from '../policy-mirror.ts';
import {
  createTablePrivateState,
  tableWitnesses,
  type TablePrivateState,
} from '../table-witnesses.ts';
import { BaseSimulator, DEFAULT_BLOCK_TIME, userAddress } from './simulator.ts';

export type { BgLedger };

export const STAGE_OPENING = 0n;
export const STAGE_MOVE = 1n;
export const NO_WINNER = 2n;

/** `BgPhase`, as the generated bindings number it. */
export const BG_PHASE = { filling: 0, playing: 1, decided: 2, settled: 3, aborted: 4 } as const;

export type BgConfig = {
  tableId: Uint8Array;
  tier: bigint;
  rakeAddress: UserAddress;
  moveTimeoutSecs: bigint;
  tableTimeoutSecs: bigint;
  inviteHash: Uint8Array;
};

export function bytes32(fill: number): Uint8Array {
  return new Uint8Array(32).fill(fill);
}

export function defaultBgConfig(overrides: Partial<BgConfig> = {}): BgConfig {
  return {
    tableId: bytes32(0x42),
    tier: 10_000n,
    rakeAddress: userAddress(0xaa),
    moveTimeoutSecs: 180n,
    tableTimeoutSecs: 600n,
    inviteHash: new Uint8Array(32),
    ...overrides,
  };
}

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

  /** Claim `slot` (the lowest free one when omitted, so tests stay deterministic). */
  join(
    payoutTo: UserAddress,
    now: number,
    blockTime = now,
    slot: number = freeSlots(this.getLedger())[0] ?? 0,
  ): Promise<bigint> {
    this.blockTime = blockTime;
    return this.run('join', (ctx) =>
      this.bg.impureCircuits.join(ctx, BigInt(slot), payoutTo, BigInt(now)),
    );
  }

  /** The start: seat the two earliest joiners. Anyone may send it. */
  start(now: number, blockTime = now): Promise<[]> {
    this.blockTime = blockTime;
    return this.run('start', (ctx) => this.bg.impureCircuits.start(ctx, BigInt(now)));
  }

  /** The acting seat reveals its share of the opening. */
  reveal(seat: number, now: number, blockTime = now): Promise<[]> {
    this.blockTime = blockTime;
    return this.run('reveal', (ctx) =>
      this.bg.impureCircuits.reveal(ctx, BigInt(seat), BigInt(now)),
    );
  }

  /**
   * The roll for the ply the table owes, as the mover's browser computes it: the opening pair at
   * ply 0 (from both shares), after it the acting seat's own roll.
   */
  myRoll(): BgDiceTs {
    const l = this.getLedger();
    if (l.turn === 0n) return bgOpeningDiceTs(this.config.tableId, sharesOf(l));
    if (!this.sk) throw new Error('myRoll: no seat is acting');
    return bgMyRoll({
      sk: this.sk,
      tableId: this.config.tableId,
      turn: l.turn,
      lastSecret: l.lastSecret,
    });
  }

  move(ply: Rules.Ply, now: number, blockTime = now): Promise<bigint> {
    return this.moveEncoded(Rules.encodePly(ply), now, blockTime);
  }

  /** Ply 0 goes to `openingMove`, every later ply to `move` -- as a client picks. */
  moveEncoded(enc: Rules.EncodedPly, now: number, blockTime = now): Promise<bigint> {
    this.blockTime = blockTime;
    const moves = enc.moves.map((m) => ({ point: BigInt(m.point), die: BigInt(m.die) }));
    const circuit = this.getLedger().turn === 0n ? 'openingMove' : 'move';
    return this.run(circuit, (ctx) =>
      this.bg.impureCircuits[circuit](ctx, moves, BigInt(enc.count), BigInt(now)),
    );
  }

  eliminate(seat: number, voluntary: boolean, blockTime = DEFAULT_BLOCK_TIME): Promise<bigint> {
    this.blockTime = blockTime;
    return this.run('eliminate', (ctx) =>
      this.bg.impureCircuits.eliminate(ctx, BigInt(seat), voluntary),
    );
  }

  settle(blockTime = DEFAULT_BLOCK_TIME): Promise<bigint> {
    this.blockTime = blockTime;
    const pot = this.getLedger().pot;
    return this.run('settle', (ctx) => this.bg.impureCircuits.settle(ctx, pot / 100n, pot % 100n));
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

/** The ledger's `dice`: the last ply's roll; zeros before ply 0. */
export function diceOf(ledger: BgLedger): [number, number] {
  return [Number(ledger.dice.a), Number(ledger.dice.b)];
}

/** Both seats' opening shares, zeros where a seat has not revealed. */
export function sharesOf(ledger: BgLedger): BgOpeningShares {
  return [ledger.openingShare.lookup(0n), ledger.openingShare.lookup(1n)];
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

/** The seat a secret holds once the table has started, or -1. */
export function seatOfKey(ledger: BgLedger, tableId: Uint8Array, sk: Uint8Array): number {
  const mine = Buffer.from(entropyKeyCommitmentTs(tableId, sk)).toString('hex');
  for (const s of [0, 1]) {
    if (Buffer.from(ledger.seatIdentity.lookup(BigInt(s)).keyCommit).toString('hex') === mine) {
      return s;
    }
  }
  return -1;
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

/** Two joins at `t`; `start` then seats them (the earlier one, `players[0]`, as seat 0). */
export async function seatBoth(sim: BackgammonSimulator, players: [Seat, Seat], t: number) {
  sim.asPlayer(players[0].sk);
  await sim.join(players[0].addr, t);
  sim.asPlayer(players[1].sk);
  await sim.join(players[1].addr, t + 1);
}

/** Start the table and have both seats reveal their shares: ply 0 is then owed. */
export async function openTable(sim: BackgammonSimulator, players: [Seat, Seat], t: number) {
  sim.asOperator();
  await sim.start(t);
  for (const s of [0, 1]) {
    sim.asPlayer(players[s]!.sk);
    await sim.reveal(s, t + 1 + s);
  }
}

export type PlayedGame = {
  plies: number;
  winner: number;
  /** Every roll: what the mover saw, and what a replay from the public log recomputes. */
  rolls: { turn: number; mover: number; chain: [number, number]; mirror: [number, number] }[];
  /** The clock after the last move. */
  t: number;
};

/**
 * Play to the end from an opened table: the mover computes its roll and picks a random legal ply
 * from the rules engine, and after every call the chain's board and dice are checked against the
 * engine's and against a replay from what the moves revealed. Returns once a seat has borne off
 * its fifteenth checker.
 */
export async function playOut(
  sim: BackgammonSimulator,
  players: [Seat, Seat],
  random: () => number,
  start: number,
  check: (msg: string, ok: boolean) => void,
): Promise<PlayedGame> {
  let t = start;
  const rolls: PlayedGame['rolls'] = [];
  const { tableId } = sim.config;
  for (let guard = 0; guard < 4000; guard++) {
    const before = sim.getLedger();
    const turn = Number(before.turn);
    const opening = turn === 0 ? bgOpeningDiceTs(tableId, sharesOf(before)) : null;
    const mover = opening ? bgStarter(opening) : Number(before.toMove);

    sim.asPlayer(players[mover]!.sk);
    const seen = sim.myRoll();
    const chain: [number, number] = [seen.a, seen.b];
    if (turn === 0) check('the opening is never a double', chain[0] !== chain[1]);

    const { mine, opp } = Rules.sidesFor(boardOf(before), mover);
    const options = Rules.legalPlies(mine, opp, chain);
    const ply = options[Math.floor(random() * options.length)]!;
    const after = Rules.applyPly(mine, opp, chain, ply);

    t += 5;
    await sim.move(ply, t);
    const moved = sim.getLedger();
    // The replay: from nothing but the public log -- the secret this move revealed and the one
    // before it (or, at the opening, the two shares).
    const replay =
      turn === 0 ? opening! : bgPlyDiceTs(tableId, moved.lastSecret, before.lastSecret, turn);
    rolls.push({ turn, mover, chain, mirror: [replay.a, replay.b] });
    check(`roll ${turn} matches the replay`, chain[0] === replay.a && chain[1] === replay.b);
    check(
      `ply ${turn}: the chain played the roll the mover saw`,
      diceOf(moved)[0] === chain[0] && diceOf(moved)[1] === chain[1],
    );
    const want = Rules.boardFrom(mover, after.mine, after.opp);
    check(
      `ply ${turn}: the chain's board is the rules engine's`,
      JSON.stringify(boardOf(moved)) === JSON.stringify(want),
    );
    check(
      `ply ${turn}: the move revealed the ply's forced secret`,
      Buffer.from(moved.lastSecret).equals(
        Buffer.from(bgRollSecretTs(players[mover]!.sk, tableId, turn)),
      ),
    );
    if (after.won) {
      return { plies: turn + 1, winner: mover, rolls, t };
    }
    check(
      `ply ${turn}: the other seat is to move`,
      Number(moved.toMove) === 1 - mover && moved.stage === STAGE_MOVE,
    );
  }
  throw new Error('playOut: no winner after 4000 plies');
}

export { entropyKeyCommitmentTs, userAddress, DEFAULT_BLOCK_TIME };
