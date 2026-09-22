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
  type JubjubPoint,
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
  NO_GAMMA,
  type LobbyPrivateState,
  type TablePrivateState,
} from '../table-witnesses.ts';
import * as vrf from '../vrf.ts';

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

  /**
   * What the LAST circuit run cost the on-chain VM, by circuit id -- the Impact transcript's
   * running cost, not the proving cost. The ledger classes a call guaranteed or fallible by how
   * heavy it is (bugs-found #35, #36), so this is what a change to that classification is aimed
   * at, and measuring it here costs a test run rather than a full key build.
   */
  readonly gasCost = new Map<string, unknown>();

  /** Run a generated circuit and commit its resulting ledger and private state. */
  async run<R>(
    circuitId: string,
    call: (ctx: ReturnType<BaseSimulator<PS>['context']>) => Promise<CircuitResult<PS, R>>,
  ): Promise<R> {
    const res = await call(this.context(circuitId));
    if ('gasCost' in res) this.gasCost.set(circuitId, (res as { gasCost: unknown }).gasCost);
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

/**
 * `playerMove` kinds, as table.compact numbers them.
 *
 * Restated here rather than imported: the generated bindings spell the argument as a plain
 * `Uint<8>` (it is not a Compact `enum`), and these are the values the daemon and the website
 * will send. See `playerMove` in table.compact and docs/table-interface.md.
 */
export const MOVE_OPEN = 0;
export const MOVE_HOLD = 1;
export const MOVE_SCORE = 2;

/** The canonical "no mask" sentinel every kind but `hold` must carry. */
export const NO_MASK = (): boolean[] => [false, false, false, false, false];

/** The canonical "no entropy" sentinel every kind but `open` must carry. */
export const ZERO_BYTES32 = (): Uint8Array => new Uint8Array(32);

/** Constructor arguments for a table. */
export type TableConfig = {
  tableId: Uint8Array;
  tier: bigint;
  seats: bigint;
  rakeAddress: UserAddress;
  /** The operator's VRF secret `x`. Its PUBLIC KEY is what reaches the constructor. */
  vrfSecret: bigint;
  /** Sealed public key. Defaults to `x*G`; override to make every answer unverifiable. */
  vrfPublicKey: JubjubPoint;
  turnTimeoutSecs: bigint;
  tableTimeoutSecs: bigint;
  /** The table's play mode (docs/fast-turn-design.md): false = every roll on-chain. */
  fastMode: boolean;
  /** Early-start wait after the last join; 0 disables (`abortTable` then only ever refunds). */
  startAfterSecs: bigint;
  /** `inviteCommitment(code)` for a private table; 32 zero bytes for a public one. */
  inviteHash: Uint8Array;
};

/**
 * Testbed for table.compact.
 *
 * TWO KINDS OF METHOD, and the split is the redesign's whole point. `join` and `closeRound` are
 * the only circuits that DECLARE a time, so they take `now` (the value the circuit is told the
 * time is) and optionally `blockTime` (what the chain says it is); they default to the same
 * value, which is the honest case, and passing them apart is the only way to exercise a caller
 * lying about the clock -- see `describe('the declared-time sandwich')`.
 *
 * Everything else takes `blockTime` alone, because it declares nothing: its deadlines are kernel
 * predicates evaluated against a stored `roundDeadline`. There is nothing to under-declare in
 * `eliminate`, `settle`, `redeem`, `abortTable` or any of the three resolves.
 *
 * `blockTime` is still explicit everywhere. `createCircuitContext` defaults it to wall clock,
 * which makes any block-time-dependent test non-reproducible (docs/bugs-found.md #12).
 */
/** The contract's `packHoldMask`, for building a query off chain. Position i is bit i. */
const packMask = (mask: boolean[]): number =>
  mask.reduce((acc, held, i) => acc + (held ? 1 << i : 0), 0);

export class TableSimulator extends BaseSimulator<TablePrivateState> {
  table: TableContract<TablePrivateState>;
  config: TableConfig;

  constructor(config: TableConfig) {
    // The constructor is the operator's transaction, and it now needs NO secret at all: the
    // VRF public key is a public argument and the operator holds `x` outside the contract.
    super(createTablePrivateState({}));
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
        config.vrfPublicKey,
        config.turnTimeoutSecs,
        config.tableTimeoutSecs,
        config.fastMode,
        config.startAfterSecs,
        config.inviteHash,
      ),
    );
    return sim;
  }

  getLedger(): TableLedgerType {
    return tableLedger(this.state);
  }

  /** Act as the operator: the seed is available, no player secret is. */
  /**
   * The operator has no witness left. Kept so the tests still read as "who is acting", and so
   * that acting as the operator DROPS whatever player secret was loaded — which is what makes
   * "the operator cannot make a player's move" a real test rather than an assumed one.
   */
  asOperator(): void {
    this.privateState = createTablePrivateState({});
  }

  /** Act as the player holding `sk` (and, on a private table, knowing `inviteCode`). */
  asPlayer(sk: Uint8Array, inviteCode?: Uint8Array): void {
    this.privateState = createTablePrivateState({ playerSecret: sk, inviteCode });
    this.actingSecret = sk;
  }

  /**
   * The blinding factor behind each seat's outstanding query, by seat.
   *
   * The real client keeps this in the browser between the move that asks and the move that
   * reveals; the simulator keeps it here because one process plays every party. Losing it
   * means losing the roll — the response on chain cannot be unblinded without it, which is
   * the whole point.
   */
  blindings = new Map<number, bigint>();
  /** The secret of whoever `asPlayer` last made current. */
  actingSecret: Uint8Array = new Uint8Array(32);

  /** A fresh blinding. Deterministic per call so a failing test replays identically. */
  #nextBlinding(): bigint {
    this.blindingCounter += 1n;
    return vrf.randomScalar(
      Uint8Array.from(
        { length: 48 },
        (_, i) => Number((this.blindingCounter * 1315423911n + BigInt(i * 7 + 1)) % 251n) + 1,
      ),
    );
  }
  blindingCounter = 0n;

  /**
   * The query for the roll a move is about to unlock, and the blinding kept to unblind it.
   *
   * `holdMask` is the hold the coming roll is taken UNDER, which for roll 1 is empty. The
   * contract rebuilds this same point when the roll is revealed, so a query built on anything
   * else is simply refused.
   */
  #query(
    seat: number,
    round: bigint,
    rollIndex: bigint,
    holdMask: boolean[],
  ): { blinded: JubjubPoint; rho: bigint } {
    void seat;
    const rho = this.#nextBlinding();
    const { blinded } = vrf.blindQuery({
      tableId: this.config.tableId,
      round,
      rollIndex,
      holdMask: BigInt(packMask(holdMask)),
      seatSecret: this.actingSecret,
      blinding: rho,
    });
    return { blinded, rho };
  }

  /**
   * Submit a move that asks a query, and keep its blinding ONLY IF THE CHAIN ACCEPTED IT.
   *
   * The blinding must match the query the contract actually holds. Committing it before the
   * move lands means a REFUSED move -- and the stage-machine tests refuse moves on purpose --
   * overwrites the blinding of the query still on chain, and the next legitimate reveal
   * unblinds with the wrong rho. The real client has the same invariant: it stores rho when the
   * transaction is confirmed, not when it is built.
   */
  async #ask(seat: number, rho: bigint, submit: () => Promise<bigint>): Promise<bigint> {
    const stage = await submit();
    this.blindings.set(seat, rho);
    return stage;
  }

  /**
   * Unblind the answer on chain for `seat`, so the next move can reveal it.
   *
   * A seat with NO blinding kept -- one that never asked, or whose turn is not between rolls --
   * does not throw here. It loads a placeholder and lets the CONTRACT refuse the move with its
   * own message. The stage-machine tests call `hold` and `score` out of order on purpose and
   * assert on the contract's wording; a simulator error thrown first would be the wrong
   * rejection for the right reason.
   */
  #reveal(seat: number): void {
    const led = this.getLedger();
    const t = led.seatTurn.lookup(BigInt(seat));
    const rho = this.blindings.get(seat);
    // The answer lives in the operator's cell for the roll this seat is asking about, not in
    // the turn. An idle seat has no such cell; the placeholder lets the contract speak.
    const cell =
      Number(t.stage) === vrf.STAGE.idle
        ? undefined
        : led.vrfAnswer.lookup(vrf.answerKey(seat, vrf.askedIndex(t.stage)));
    this.privateState = {
      ...this.privateState,
      vrfBlinding: rho ?? 1n,
      vrfGamma:
        rho === undefined || cell === undefined ? NO_GAMMA : vrf.unblind(cell.response, rho),
    };
  }

  join(payoutTo: UserAddress, now: number, blockTime = now): Promise<bigint> {
    this.blockTime = blockTime;
    return this.run('join', (ctx) => this.table.impureCircuits.join(ctx, payoutTo, BigInt(now)));
  }

  /**
   * The player's move: open a turn, hold dice, or score and stop.
   *
   * Declares no time -- the round's deadline was stamped by `closeRound`. Returns the seat's
   * next stage, which is the circuit's own view of where the turn now is.
   *
   * Prefer `openTurn` / `hold` / `score` below; this is the raw form, and the one a test uses
   * when it wants to send a non-canonical argument on purpose.
   */
  playerMove(
    seat: number,
    kind: number,
    entropy: Uint8Array,
    mask: boolean[],
    category: number,
    nextBlinded: JubjubPoint,
    blockTime = DEFAULT_BLOCK_TIME,
  ): Promise<bigint> {
    this.blockTime = blockTime;
    return this.run('playerMove', (ctx) =>
      this.table.impureCircuits.playerMove(
        ctx,
        BigInt(seat),
        BigInt(kind),
        entropy,
        mask,
        BigInt(category),
        nextBlinded,
      ),
    );
  }

  /**
   * `playerMove(open)`: prove the secret, declare the forced entropy, ASK FOR ROLL 1.
   *
   * The query rides along here because roll 1 is taken under no hold, so it is formable the
   * moment the turn opens.
   */
  openTurn(seat: number, entropy: Uint8Array, blockTime = DEFAULT_BLOCK_TIME): Promise<bigint> {
    const round = this.getLedger().openRound;
    const q = this.#query(seat, round, 0n, NO_MASK());
    return this.#ask(seat, q.rho, () =>
      this.playerMove(seat, MOVE_OPEN, entropy, NO_MASK(), 0, q.blinded, blockTime),
    );
  }

  /**
   * `playerMove(hold)`: reveal the roll just answered, keep these dice, and ask for the next.
   *
   * Both halves are one transaction, and that is the ordering guarantee: the query for the
   * next roll is formed from the mask being written in this very move, so it cannot have been
   * asked before the hold was fixed.
   */
  hold(seat: number, mask: boolean[], blockTime = DEFAULT_BLOCK_TIME): Promise<bigint> {
    this.#reveal(seat);
    const t = this.getLedger().seatTurn.lookup(BigInt(seat));
    const nextIndex = t.stage === 1n ? 1n : 2n;
    const q = this.#query(seat, t.round, nextIndex, mask);
    return this.#ask(seat, q.rho, () =>
      this.playerMove(seat, MOVE_HOLD, ZERO_BYTES32(), mask, 0, q.blinded, blockTime),
    );
  }

  /** `playerMove(score)`: reveal the roll, score it, end the turn. */
  score(seat: number, category: number, blockTime = DEFAULT_BLOCK_TIME): Promise<bigint> {
    this.#reveal(seat);
    // The turn ends here, so nothing will read this query. It still has to be a point.
    return this.playerMove(
      seat,
      MOVE_SCORE,
      ZERO_BYTES32(),
      NO_MASK(),
      category,
      NO_GAMMA,
      blockTime,
    );
  }

  /**
   * The operator's move: answer the query `seat` is currently asking. An honest operator
   * reads the seat's pending turn off the ledger -- which roll, which round, which query --
   * and posts `S = x*B` with its DLEQ into the seat's answer cell. It does not touch the turn.
   *
   * Six seats have six independent pipelines and may be interleaved freely; answering an idle
   * seat is accepted and unlocks nothing (see `resolveRollRaw` for the dishonest shapes).
   */
  resolveRoll(seat: number, blockTime = DEFAULT_BLOCK_TIME): Promise<[]> {
    const t = this.getLedger().seatTurn.lookup(BigInt(seat));
    return this.resolveRollRaw(seat, vrf.askedIndex(t.stage), t.round, t.blinded, blockTime);
  }

  /**
   * The raw resolve: answer `blinded` as if it were `seat`'s query for `rollIndex` in `round`.
   * The circuit checks only the DLEQ; whether the answer matches what the seat actually asked
   * is the MOVE's check, one call later. Tests use this to post answers nobody asked for.
   */
  resolveRollRaw(
    seat: number,
    rollIndex: number,
    round: bigint,
    blinded: JubjubPoint,
    blockTime = DEFAULT_BLOCK_TIME,
  ): Promise<[]> {
    this.blockTime = blockTime;
    const { response, proof } = vrf.evaluate(this.config.vrfSecret, blinded);
    return this.run('resolveRoll', (ctx) =>
      this.table.impureCircuits.resolveRoll(
        ctx,
        BigInt(seat),
        BigInt(rollIndex),
        round,
        blinded,
        response,
        proof.a1,
        proof.a2,
        proof.z,
      ),
    );
  }

  /**
   * There is deliberately NO `resolveTurn` convenience here.
   *
   * Under pre-declared policies the operator's three rolls were one uninterrupted sequence, so
   * wrapping them read as "the operator's move". With interactive holds the player's own
   * transactions sit BETWEEN them -- open, roll 1, hold, roll 2, hold, roll 3, score -- and a
   * helper that ran the three rolls back to back would describe a turn nobody can play. Turn
   * sequencing lives in `GameDriver.playTurn`, where both parties' moves are visible in order.
   */

  /** Advance the whole table one round. The second of the two circuits that declare a time. */
  closeRound(now: number, blockTime = now): Promise<bigint> {
    this.blockTime = blockTime;
    return this.run('closeRound', (ctx) => this.table.impureCircuits.closeRound(ctx, BigInt(now)));
  }

  /**
   * Knock out a seat that let the round deadline pass. Declares no time -- `roundDeadline` is
   * compared against real block time by the kernel.
   */
  eliminate(seat: number, q: bigint, rem: bigint, blockTime: number): Promise<bigint> {
    this.blockTime = blockTime;
    return this.run('eliminate', (ctx) =>
      this.table.impureCircuits.eliminate(ctx, BigInt(seat), q, rem, false),
    );
  }

  /**
   * `eliminate` with `voluntary` set: the seat resigns itself, authorised by its own entropy
   * secret (call `asPlayer(sk)` first — the witness supplies it). Charged one round LESS than a
   * timeout: `q * 13 + rem == tier * openRound`.
   */
  resign(seat: number, q: bigint, rem: bigint, blockTime = DEFAULT_BLOCK_TIME): Promise<bigint> {
    this.blockTime = blockTime;
    return this.run('eliminate', (ctx) =>
      this.table.impureCircuits.eliminate(ctx, BigInt(seat), q, rem, true),
    );
  }

  /** `settle` declares no time: the key-waiver deadline is a kernel predicate. */
  settle(vrfSecret: bigint, q: bigint, r: bigint, blockTime = DEFAULT_BLOCK_TIME): Promise<bigint> {
    this.blockTime = blockTime;
    return this.run('settle', (ctx) => this.table.impureCircuits.settle(ctx, vrfSecret, q, r));
  }

  /** Pay one seat what it is personally owed. Legal only once the table is terminal. */
  redeem(seat: number, blockTime = DEFAULT_BLOCK_TIME): Promise<bigint> {
    this.blockTime = blockTime;
    return this.run('redeem', (ctx) => this.table.impureCircuits.redeem(ctx, BigInt(seat)));
  }

  /**
   * End a table that cannot finish. `q`/`rem` are the PER-SEAT rake on `tier`, required
   * unconditionally even on the two paths that pay no rake.
   */
  /**
   * `now` is the declared time (needed for the early start's round deadline); it defaults to
   * `blockTime`, the honest case. Pass them apart only to exercise the sandwich.
   */
  abortTable(
    q: bigint,
    rem: bigint,
    blockTime = DEFAULT_BLOCK_TIME,
    now: number = blockTime,
  ): Promise<bigint> {
    this.blockTime = blockTime;
    return this.run('abortTable', (ctx) =>
      this.table.impureCircuits.abortTable(ctx, q, rem, BigInt(now)),
    );
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
