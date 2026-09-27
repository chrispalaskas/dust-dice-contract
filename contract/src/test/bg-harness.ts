// Copyright (C) Shielded Technologies
// SPDX-License-Identifier: Apache-2.0

/**
 * Testbed for backgammon.compact, and a driver that plays whole games through it.
 *
 * Same conventions as simulator.ts's `TableSimulator`: block time is always explicit (the
 * runtime would default it to wall clock), and the acting party is swapped between calls --
 * `asOperator` holds the seed, `asPlayer` a seat secret -- because the three witnesses belong to
 * different people in production. `join` and `resolveRoll` are the only circuits that DECLARE a
 * time, so they take `now` and optionally a different `blockTime`; everything else takes
 * `blockTime` alone.
 */

import {
  Contract as BgContract,
  ledger as bgLedger,
  type Ledger as BgLedger,
  type UserAddress,
} from '../managed/backgammon/contract/index.js';
import * as Rules from '../../../api/src/backgammon.ts';
import { bgForcedEntropyTs, bgRollForPly } from '../bg-mirror.ts';
import { entropyKeyCommitmentTs, seedCommitmentTs } from '../policy-mirror.ts';
import {
  createTablePrivateState,
  tableWitnesses,
  type TablePrivateState,
} from '../table-witnesses.ts';
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
  seed: Uint8Array;
  seedCommitment: Uint8Array;
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
  return {
    tableId,
    tier: 10_000n,
    rakeAddress: userAddress(0xaa),
    seed,
    seedCommitment: seedCommitmentTs(tableId, seed),
    moveTimeoutSecs: 180n,
    tableTimeoutSecs: 600n,
    inviteHash: new Uint8Array(32),
    ...overrides,
  };
}

export class BackgammonSimulator extends BaseSimulator<TablePrivateState> {
  bg: BgContract<TablePrivateState>;
  config: BgConfig;

  constructor(config: BgConfig) {
    super(createTablePrivateState({ rollSeed: config.seed }));
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
        config.seedCommitment,
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
    this.privateState = createTablePrivateState({ rollSeed: this.config.seed });
  }

  asPlayer(sk: Uint8Array, inviteCode?: Uint8Array): void {
    this.privateState = createTablePrivateState({ playerSecret: sk, inviteCode });
  }

  join(payoutTo: UserAddress, now: number, blockTime = now): Promise<bigint> {
    this.blockTime = blockTime;
    return this.run('join', (ctx) => this.bg.impureCircuits.join(ctx, payoutTo, BigInt(now)));
  }

  resolveRoll(now: number, blockTime = now): Promise<{ a: bigint; b: bigint }> {
    this.blockTime = blockTime;
    return this.run('resolveRoll', (ctx) => this.bg.impureCircuits.resolveRoll(ctx, BigInt(now)));
  }

  move(ply: Rules.Ply, blockTime = DEFAULT_BLOCK_TIME): Promise<bigint> {
    return this.moveEncoded(Rules.encodePly(ply), blockTime);
  }

  moveEncoded(enc: Rules.EncodedPly, blockTime = DEFAULT_BLOCK_TIME): Promise<bigint> {
    this.blockTime = blockTime;
    const moves = enc.moves.map((m) => ({ point: BigInt(m.point), die: BigInt(m.die) }));
    return this.run('move', (ctx) => this.bg.impureCircuits.move(ctx, moves, BigInt(enc.count)));
  }

  eliminate(seat: number, voluntary: boolean, blockTime = DEFAULT_BLOCK_TIME): Promise<bigint> {
    this.blockTime = blockTime;
    return this.run('eliminate', (ctx) =>
      this.bg.impureCircuits.eliminate(ctx, BigInt(seat), voluntary),
    );
  }

  settle(seed: Uint8Array, blockTime = DEFAULT_BLOCK_TIME): Promise<bigint> {
    this.blockTime = blockTime;
    const pot = this.getLedger().pot;
    return this.run('settle', (ctx) =>
      this.bg.impureCircuits.settle(ctx, seed, pot / 100n, pot % 100n),
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

export function diceOf(ledger: BgLedger): [number, number] {
  return [Number(ledger.dice.a), Number(ledger.dice.b)];
}

/** The two seats' pending entropies, as `resolveRoll` reads them. */
export function pendingOf(ledger: BgLedger): [Uint8Array, Uint8Array] {
  return [ledger.pendingEntropy.lookup(0n), ledger.pendingEntropy.lookup(1n)];
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

/** Seat both players at `t`, the second join starting the game. */
export async function seatBoth(sim: BackgammonSimulator, players: [Seat, Seat], t: number) {
  sim.asPlayer(players[0].sk);
  await sim.join(players[0].addr, t);
  sim.asPlayer(players[1].sk);
  await sim.join(players[1].addr, t + 1);
}

export type PlayedGame = {
  plies: number;
  winner: number;
  /** Every roll, as the chain made it, with the mirror's re-derivation beside it. */
  rolls: { turn: number; mover: number; chain: [number, number]; mirror: [number, number] }[];
  /** The clock after the last move. */
  t: number;
};

/**
 * Play to the end: the operator rolls, the mover picks a random legal ply from the rules
 * engine, and after every call the chain's board and dice are checked against the engine's and
 * the mirror's. Returns once a seat has borne off its fifteenth checker.
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
  for (let guard = 0; guard < 4000; guard++) {
    const before = sim.getLedger();
    const turn = Number(before.turn);
    // The mirror's view of the roll, from nothing but the public ledger and the seed.
    const expected = bgRollForPly(
      sim.config.tableId,
      sim.config.seed,
      pendingOf(before),
      turn,
      Number(before.toMove),
    );
    sim.asOperator();
    t += 5;
    await sim.resolveRoll(t);
    const rolled = sim.getLedger();
    const chain = diceOf(rolled);
    const mover = Number(rolled.toMove);
    rolls.push({ turn, mover, chain, mirror: [expected.a, expected.b] });
    check(`roll ${turn} matches the mirror`, chain[0] === expected.a && chain[1] === expected.b);

    const { mine, opp } = Rules.sidesFor(boardOf(rolled), mover);
    const options = Rules.legalPlies(mine, opp, chain);
    const ply = options[Math.floor(random() * options.length)];
    const after = Rules.applyPly(mine, opp, chain, ply);

    sim.asPlayer(players[mover].sk);
    t += 5;
    await sim.move(ply, t);
    const moved = sim.getLedger();
    const want = Rules.boardFrom(mover, after.mine, after.opp);
    const got = boardOf(moved);
    check(
      `ply ${turn}: the chain's board is the rules engine's`,
      JSON.stringify(got) === JSON.stringify(want),
    );
    check(
      `ply ${turn}: the mover's next entropy is forced`,
      Buffer.from(moved.pendingEntropy.lookup(BigInt(mover))).equals(
        Buffer.from(bgForcedEntropyTs(players[mover].sk, sim.config.tableId, turn + 2)),
      ),
    );
    if (after.won) {
      return { plies: turn + 1, winner: mover, rolls, t };
    }
  }
  throw new Error('playOut: no winner after 4000 plies');
}

export { entropyKeyCommitmentTs, userAddress, DEFAULT_BLOCK_TIME };
