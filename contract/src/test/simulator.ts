// Copyright (C) Shielded Technologies
// SPDX-License-Identifier: Apache-2.0

/**
 * Testbeds for every contract in this package.
 *
 * The four measurement contracts (dice, turn, scoring, takeTurn) have no constructor and no
 * time dependence, so their simulators are tiny: hold the ledger state and the private state,
 * and build a fresh `CircuitContext` per call. A `CircuitContext` models a whole call tree
 * rather than one contract's execution, so it is not a thing to carry between calls.
 *
 * `TableSimulator` and `LobbySimulator` need two things the others do not.
 *
 * BLOCK TIME IS ALWAYS EXPLICIT. `createCircuitContext` defaults its `time` argument to
 * `Math.floor(Date.now() / 1000)`, so a contract with block-time predicates gets a different
 * answer on every run and a timeout test that passes today fails at some future wall-clock
 * date. Every simulator here therefore pins `time` -- to `DEFAULT_BLOCK_TIME` unless a test
 * sets it -- and the table's timeout tests set it deliberately. Nothing in this file may call
 * `createCircuitContext` without a time.
 *
 * THE ACTING PARTY IS SWAPPABLE. The table's three witnesses belong to two different parties
 * (see src/table-witnesses.ts) and in production never share a private state. One simulator
 * process has to play all of them, so `asOperator` / `asPlayer` swap the private state between
 * calls -- which is also how "wrong secret" is tested: act as the wrong player and watch the
 * commitment assert fire.
 *
 * Circuits are async because the generated bindings return promises.
 *
 * Written in plain-field style with no TypeScript parameter properties and no `private`
 * modifiers: `node --test src/test/*.test.ts` runs these sources through Node's strip-only
 * type removal, which rejects parameter properties outright
 * (`ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`) because erasing them would change runtime
 * behaviour. Anything that is more than a type annotation has to go.
 */

import {
  createCircuitContext,
  createConstructorContext,
  sampleContractAddress,
  type ChargedState,
  type ContractAddress,
} from '@midnight-ntwrk/compact-runtime';
import {
  Contract as DiceContract,
  ledger as diceLedger,
  type Ledger as DiceLedgerType,
} from '../managed/dice/contract/index.js';
import {
  Contract as TurnContract,
  ledger as turnLedger,
  type Ledger as TurnLedgerType,
} from '../managed/turn/contract/index.js';
import {
  Contract as ScoringContract,
  ledger as scoringLedger,
  type Ledger as ScoringLedgerType,
  type Scorecard,
  type ScoreOutcome,
} from '../managed/scoring/contract/index.js';
import {
  Contract as TakeTurnContract,
  ledger as takeTurnLedger,
  type Ledger as TakeTurnLedgerType,
  type TurnOutcome,
} from '../managed/takeTurn/contract/index.js';
import {
  Contract as TableContract,
  ledger as tableLedger,
  type Dice as TableDice,
  type Ledger as TableLedgerType,
  type UserAddress,
} from '../managed/table/contract/index.js';
import {
  Contract as LobbyContract,
  ledger as lobbyLedger,
  type ContractAddress as LobbyContractAddress,
  type Ledger as LobbyLedgerType,
} from '../managed/lobby/contract/index.js';
import { diceWitnesses, type DicePrivateState } from '../witnesses.ts';
import {
  createLobbyPrivateState,
  createTablePrivateState,
  lobbyWitnesses,
  tableWitnesses,
  type LobbyPrivateState,
  type TablePrivateState,
} from '../table-witnesses.ts';

export type { Scorecard, ScoreOutcome, TurnOutcome, TableLedgerType, UserAddress };

const COIN_PUBLIC_KEY = '0'.repeat(64);

/**
 * Block time used when a test does not care, in seconds since epoch.
 *
 * A fixed value and not `Date.now()`: see the file header. Chosen well clear of zero so that
 * `lastActionAt + timeout` arithmetic in the table never has to reason about an epoch boundary.
 */
export const DEFAULT_BLOCK_TIME = 1_700_000_000;

/** The `Dice` struct as the generated bindings spell it: five bigints. */
export type DiceStruct = { d0: bigint; d1: bigint; d2: bigint; d3: bigint; d4: bigint };

export function diceToArray(d: DiceStruct): number[] {
  return [d.d0, d.d1, d.d2, d.d3, d.d4].map(Number);
}

/**
 * What a generated circuit resolves to, in the shape this simulator needs.
 *
 * The updated ledger and private state live under `context.callContext`, not directly on
 * `context` -- a `CircuitContext` holds a `queryContexts` map keyed by contract address for
 * the whole call tree, and `callContext` is the currently executing contract's view of it.
 */
type CircuitResult<PS, R> = {
  result: R;
  context: {
    callContext: {
      currentQueryContext: { state: ChargedState };
      currentPrivateState?: PS;
    };
  };
};

/** The generated `initialState` result, in the shape this simulator needs. */
type InitialState<PS> = {
  currentContractState: { data: ChargedState };
  currentPrivateState: PS;
};

/** A generated contract class with a no-argument constructor. */
type AnyContract<PS> = {
  initialState(ctx: never): Promise<InitialState<PS>>;
};

class BaseSimulator<PS> {
  address: ContractAddress = sampleContractAddress();
  state!: ChargedState;
  privateState: PS;

  /**
   * Block time the next circuit call sees, in seconds since epoch.
   *
   * Always set. The runtime would otherwise default it to wall-clock time and make every
   * block-time predicate non-reproducible; see the file header.
   */
  blockTime: number = DEFAULT_BLOCK_TIME;

  constructor(privateState: PS) {
    this.privateState = privateState;
  }

  /** Adopt the result of a generated `initialState` call. */
  async adopt(pending: Promise<InitialState<PS>>): Promise<void> {
    const { currentContractState, currentPrivateState } = await pending;
    this.state = currentContractState.data;
    this.privateState = currentPrivateState;
  }

  constructorContext() {
    return createConstructorContext(this.privateState, COIN_PUBLIC_KEY) as never;
  }

  context(circuitId: string) {
    return createCircuitContext<PS>(
      circuitId,
      this.address,
      COIN_PUBLIC_KEY,
      this.state,
      this.privateState,
      undefined,
      undefined,
      undefined,
      this.blockTime,
    );
  }

  /** Run a generated circuit and commit its resulting ledger and private state. */
  async run<R>(
    circuitId: string,
    call: (ctx: ReturnType<BaseSimulator<PS>['context']>) => Promise<CircuitResult<PS, R>>,
  ): Promise<R> {
    const res = await call(this.context(circuitId));
    this.state = res.context.callContext.currentQueryContext.state;
    if (res.context.callContext.currentPrivateState !== undefined) {
      this.privateState = res.context.callContext.currentPrivateState;
    }
    return res.result;
  }
}

/** A simulator for a contract whose constructor takes no arguments. */
class SimpleSimulator<PS> extends BaseSimulator<PS> {
  contract: AnyContract<PS>;

  constructor(contract: AnyContract<PS>, privateState: PS) {
    super(privateState);
    this.contract = contract;
  }

  async init(): Promise<void> {
    await this.adopt(this.contract.initialState(this.constructorContext()));
  }
}

export class DiceSimulator extends SimpleSimulator<DicePrivateState> {
  dice: DiceContract<DicePrivateState>;

  constructor(privateState: DicePrivateState) {
    const contract = new DiceContract<DicePrivateState>(diceWitnesses);
    super(contract as unknown as AnyContract<DicePrivateState>, privateState);
    this.dice = contract;
  }

  static async create(privateState: DicePrivateState): Promise<DiceSimulator> {
    const sim = new DiceSimulator(privateState);
    await sim.init();
    return sim;
  }

  getLedger(): DiceLedgerType {
    return diceLedger(this.state);
  }

  rollDice(
    tableId: Uint8Array,
    seed: Uint8Array,
    playerEntropy: Uint8Array,
    round: bigint,
    rollIndex: bigint,
  ): Promise<DiceStruct> {
    return this.run('rollDice', (ctx) =>
      this.dice.impureCircuits.rollDice(ctx, tableId, seed, playerEntropy, round, rollIndex),
    );
  }

  rollDiceSecretSeed(
    tableId: Uint8Array,
    playerEntropy: Uint8Array,
    round: bigint,
    rollIndex: bigint,
  ): Promise<DiceStruct> {
    return this.run('rollDiceSecretSeed', (ctx) =>
      this.dice.impureCircuits.rollDiceSecretSeed(ctx, tableId, playerEntropy, round, rollIndex),
    );
  }

  rollDiceBitLadder(
    tableId: Uint8Array,
    seed: Uint8Array,
    playerEntropy: Uint8Array,
    round: bigint,
    rollIndex: bigint,
  ): Promise<DiceStruct> {
    return this.run('rollDiceBitLadder', (ctx) =>
      this.dice.impureCircuits.rollDiceBitLadder(
        ctx,
        tableId,
        seed,
        playerEntropy,
        round,
        rollIndex,
      ),
    );
  }

  probeHashOnly(
    tableId: Uint8Array,
    seed: Uint8Array,
    playerEntropy: Uint8Array,
    round: bigint,
    rollIndex: bigint,
  ): Promise<Uint8Array> {
    return this.run('probeHashOnly', (ctx) =>
      this.dice.impureCircuits.probeHashOnly(ctx, tableId, seed, playerEntropy, round, rollIndex),
    );
  }
}

export class TurnSimulator extends SimpleSimulator<DicePrivateState> {
  turn: TurnContract<DicePrivateState>;

  constructor(privateState: DicePrivateState) {
    const contract = new TurnContract<DicePrivateState>(diceWitnesses);
    super(contract as unknown as AnyContract<DicePrivateState>, privateState);
    this.turn = contract;
  }

  static async create(privateState: DicePrivateState): Promise<TurnSimulator> {
    const sim = new TurnSimulator(privateState);
    await sim.init();
    return sim;
  }

  getLedger(): TurnLedgerType {
    return turnLedger(this.state);
  }

  resolveTurn(
    tableId: Uint8Array,
    playerEntropy: Uint8Array,
    round: bigint,
    policy: number,
  ): Promise<{ roll0: DiceStruct; roll1: DiceStruct; roll2: DiceStruct }> {
    return this.run('resolveTurn', (ctx) =>
      this.turn.impureCircuits.resolveTurn(ctx, tableId, playerEntropy, round, policy),
    );
  }
}

/**
 * scoring.compact. No witnesses of its own -- every input is a circuit argument -- but the
 * generated `Contract` still wants a witnesses object, and `diceWitnesses` satisfies the
 * empty interface it declares.
 */
export class ScoringSimulator extends SimpleSimulator<DicePrivateState> {
  scoring: ScoringContract<DicePrivateState>;

  constructor(privateState: DicePrivateState) {
    const contract = new ScoringContract<DicePrivateState>(diceWitnesses);
    super(contract as unknown as AnyContract<DicePrivateState>, privateState);
    this.scoring = contract;
  }

  static async create(privateState: DicePrivateState): Promise<ScoringSimulator> {
    const sim = new ScoringSimulator(privateState);
    await sim.init();
    return sim;
  }

  getLedger(): ScoringLedgerType {
    return scoringLedger(this.state);
  }

  scoreTurn(category: bigint, dice: bigint[]): Promise<ScoreOutcome> {
    return this.run('scoreTurn', (ctx) =>
      this.scoring.impureCircuits.scoreTurn(ctx, category, dice),
    );
  }

  loadCard(card: Scorecard): Promise<[]> {
    return this.run('loadCard', (ctx) => this.scoring.impureCircuits.loadCard(ctx, card));
  }

  resetCard(): Promise<[]> {
    return this.run('resetCard', (ctx) => this.scoring.impureCircuits.resetCard(ctx));
  }

  settleTable(
    totals: bigint[],
    finishedAtTurn: bigint[],
    seatCount: bigint,
    pot: bigint,
    q: bigint,
    r: bigint,
  ): Promise<bigint[]> {
    return this.run('settleTable', (ctx) =>
      this.scoring.impureCircuits.settleTable(ctx, totals, finishedAtTurn, seatCount, pot, q, r),
    );
  }
}

/** takeTurn.compact: dice derivation and scoring in one circuit. */
export class TakeTurnSimulator extends SimpleSimulator<DicePrivateState> {
  takeTurnContract: TakeTurnContract<DicePrivateState>;

  constructor(privateState: DicePrivateState) {
    const contract = new TakeTurnContract<DicePrivateState>(diceWitnesses);
    super(contract as unknown as AnyContract<DicePrivateState>, privateState);
    this.takeTurnContract = contract;
  }

  static async create(privateState: DicePrivateState): Promise<TakeTurnSimulator> {
    const sim = new TakeTurnSimulator(privateState);
    await sim.init();
    return sim;
  }

  getLedger(): TakeTurnLedgerType {
    return takeTurnLedger(this.state);
  }

  takeTurn(
    tableId: Uint8Array,
    playerEntropy: Uint8Array,
    round: bigint,
    policy: number,
    category: bigint,
  ): Promise<TurnOutcome> {
    return this.run('takeTurn', (ctx) =>
      this.takeTurnContract.impureCircuits.takeTurn(
        ctx,
        tableId,
        playerEntropy,
        round,
        policy,
        category,
      ),
    );
  }

  loadCard(card: Scorecard): Promise<[]> {
    return this.run('loadCard', (ctx) => this.takeTurnContract.impureCircuits.loadCard(ctx, card));
  }

  resetCard(): Promise<[]> {
    return this.run('resetCard', (ctx) => this.takeTurnContract.impureCircuits.resetCard(ctx));
  }
}

// ---------------------------------------------------------------------------------------
// table.compact
// ---------------------------------------------------------------------------------------

/** A `UserAddress` from a single repeated byte -- distinct, readable test addresses. */
export function userAddress(fill: number): UserAddress {
  return { bytes: new Uint8Array(32).fill(fill) };
}

/** Constructor arguments for a table. */
export type TableConfig = {
  tableId: Uint8Array;
  tier: bigint;
  seats: bigint;
  rakeAddress: UserAddress;
  /** The operator's roll seed. Its commitment is what reaches the constructor. */
  seed: Uint8Array;
  /** Committed seed hash. Defaults to `seedCommitmentTs(tableId, seed)`; override to reject. */
  seedCommitment: Uint8Array;
  turnTimeoutSecs: bigint;
  tableTimeoutSecs: bigint;
};

/**
 * Testbed for table.compact.
 *
 * Every mutating method takes `now` (the value the circuit is TOLD the time is) and optionally
 * `blockTime` (what the chain says it is). They default to the same value, which is the honest
 * case; passing them apart is how the `stampTime` sandwich is tested, and it is the only way to
 * exercise a caller lying about the clock.
 */
export class TableSimulator extends BaseSimulator<TablePrivateState> {
  table: TableContract<TablePrivateState>;
  config: TableConfig;

  constructor(config: TableConfig) {
    // The constructor is the operator's transaction: it holds the seed, and no player exists
    // yet.
    super(createTablePrivateState({ rollSeed: config.seed }));
    this.table = new TableContract<TablePrivateState>(tableWitnesses);
    this.config = config;
  }

  static async create(
    config: TableConfig,
    blockTime = DEFAULT_BLOCK_TIME,
  ): Promise<TableSimulator> {
    const sim = new TableSimulator(config);
    sim.blockTime = blockTime;
    await sim.adopt(
      sim.table.initialState(
        sim.constructorContext(),
        config.tableId,
        config.tier,
        config.seats,
        config.rakeAddress,
        config.seedCommitment,
        config.turnTimeoutSecs,
        config.tableTimeoutSecs,
      ),
    );
    return sim;
  }

  getLedger(): TableLedgerType {
    return tableLedger(this.state);
  }

  /** Act as the operator: the seed is available, no player secret is. */
  asOperator(): void {
    this.privateState = createTablePrivateState({ rollSeed: this.config.seed });
  }

  /** Act as the player holding `sk`. The seed is deliberately NOT available. */
  asPlayer(sk: Uint8Array): void {
    this.privateState = createTablePrivateState({ playerSecret: sk });
  }

  join(payoutTo: UserAddress, now: number, blockTime = now): Promise<bigint> {
    this.blockTime = blockTime;
    return this.run('join', (ctx) => this.table.impureCircuits.join(ctx, payoutTo, BigInt(now)));
  }

  takeTurn(
    entropy: Uint8Array,
    policy: number,
    param: number,
    category: number,
    now: number,
    blockTime = now,
  ): Promise<[]> {
    this.blockTime = blockTime;
    return this.run('takeTurn', (ctx) =>
      this.table.impureCircuits.takeTurn(
        ctx,
        entropy,
        BigInt(policy),
        BigInt(param),
        BigInt(category),
        BigInt(now),
      ),
    );
  }

  /**
   * One roll of the operator's move. The three steps must run in order; each asserts the
   * `rollStep` it is the successor of, so a skipped or repeated step is refused on chain.
   */
  resolveRoll1(now: number, blockTime = now): Promise<TableDice> {
    this.blockTime = blockTime;
    return this.run('resolveRoll1', (ctx) =>
      this.table.impureCircuits.resolveRoll1(ctx, BigInt(now)),
    );
  }

  resolveRoll2(now: number, blockTime = now): Promise<TableDice> {
    this.blockTime = blockTime;
    return this.run('resolveRoll2', (ctx) =>
      this.table.impureCircuits.resolveRoll2(ctx, BigInt(now)),
    );
  }

  resolveRoll3(now: number, blockTime = now): Promise<TableDice> {
    this.blockTime = blockTime;
    return this.run('resolveRoll3', (ctx) =>
      this.table.impureCircuits.resolveRoll3(ctx, BigInt(now)),
    );
  }

  /**
   * The operator's whole move: all three rolls, in order, returning the turn's final dice.
   *
   * A convenience over the three circuits and NOT a circuit itself -- on chain these are three
   * separate transactions (table.compact, decision 9). Kept because almost every test cares
   * about the turn rather than about the split, and because a test that reads as
   * `resolveTurn()` is a test that still describes the game.
   *
   * `now` is the declared time for all three steps. `BaseSimulator.run` commits state only on
   * success, so a step that throws leaves the table exactly where the previous step left it --
   * which is what lets the rejection tests below assert on step 1 without cleanup.
   */
  async resolveTurn(now: number, blockTime = now): Promise<TableDice> {
    await this.resolveRoll1(now, blockTime);
    await this.resolveRoll2(now, blockTime);
    return await this.resolveRoll3(now, blockTime);
  }

  /** `settle` needs no time: no deadline is involved and the outcome is already determined. */
  settle(seed: Uint8Array, q: bigint, r: bigint, blockTime = DEFAULT_BLOCK_TIME): Promise<bigint> {
    this.blockTime = blockTime;
    return this.run('settle', (ctx) => this.table.impureCircuits.settle(ctx, seed, q, r));
  }

  claimTimeout(now: number, blockTime = now): Promise<bigint> {
    this.blockTime = blockTime;
    return this.run('claimTimeout', (ctx) =>
      this.table.impureCircuits.claimTimeout(ctx, BigInt(now)),
    );
  }

  abortTable(now: number, blockTime = now): Promise<bigint> {
    this.blockTime = blockTime;
    return this.run('abortTable', (ctx) => this.table.impureCircuits.abortTable(ctx, BigInt(now)));
  }
}

// ---------------------------------------------------------------------------------------
// lobby.compact
// ---------------------------------------------------------------------------------------

/** A `ContractAddress` from a single repeated byte. */
export function contractAddress(fill: number): LobbyContractAddress {
  return { bytes: new Uint8Array(32).fill(fill) };
}

/** Testbed for lobby.compact. No time dependence -- it holds no deadlines and no funds. */
export class LobbySimulator extends BaseSimulator<LobbyPrivateState> {
  lobby: LobbyContract<LobbyPrivateState>;

  constructor(operatorSecret: Uint8Array) {
    super(createLobbyPrivateState(operatorSecret));
    this.lobby = new LobbyContract<LobbyPrivateState>(lobbyWitnesses);
  }

  static async create(
    operatorSecret: Uint8Array,
    operatorCommitment: Uint8Array,
  ): Promise<LobbySimulator> {
    const sim = new LobbySimulator(operatorSecret);
    await sim.adopt(sim.lobby.initialState(sim.constructorContext(), operatorCommitment));
    return sim;
  }

  getLedger(): LobbyLedgerType {
    return lobbyLedger(this.state);
  }

  /** Swap in a different operator key, to test that the commitment check bites. */
  asOperator(secret: Uint8Array): void {
    this.privateState = createLobbyPrivateState(secret);
  }

  openTableAt(tier: number, address: LobbyContractAddress): Promise<[]> {
    return this.run('openTableAt', (ctx) =>
      this.lobby.impureCircuits.openTableAt(ctx, BigInt(tier), address),
    );
  }

  tableFilled(tier: number): Promise<[]> {
    return this.run('tableFilled', (ctx) =>
      this.lobby.impureCircuits.tableFilled(ctx, BigInt(tier)),
    );
  }
}
