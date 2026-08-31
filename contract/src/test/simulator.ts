// Copyright (C) Shielded Technologies
// SPDX-License-Identifier: Apache-2.0

/**
 * Minimal testbeds for the two measurement contracts.
 *
 * Neither contract has a constructor, cross-contract calls, or any time dependence, so
 * these are much smaller than a real simulator: they hold the ledger state and the private
 * state, and build a fresh `CircuitContext` per call. A `CircuitContext` models a whole
 * call tree rather than one contract's execution, so it is not a thing to carry between
 * calls.
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
import { diceWitnesses, type DicePrivateState } from '../witnesses.ts';

const COIN_PUBLIC_KEY = '0'.repeat(64);

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
type CircuitResult<R> = {
  result: R;
  context: {
    callContext: {
      currentQueryContext: { state: ChargedState };
      currentPrivateState?: DicePrivateState;
    };
  };
};

/** The two generated contract classes, in the shape this simulator needs. */
type AnyContract = {
  initialState(ctx: never): Promise<{
    currentContractState: { data: ChargedState };
    currentPrivateState: DicePrivateState;
  }>;
};

class BaseSimulator {
  address: ContractAddress = sampleContractAddress();
  state!: ChargedState;
  privateState: DicePrivateState;
  contract: AnyContract;

  constructor(contract: AnyContract, privateState: DicePrivateState) {
    this.contract = contract;
    this.privateState = privateState;
  }

  async init(): Promise<void> {
    const { currentContractState, currentPrivateState } = await this.contract.initialState(
      createConstructorContext(this.privateState, COIN_PUBLIC_KEY) as never,
    );
    this.state = currentContractState.data;
    this.privateState = currentPrivateState;
  }

  context(circuitId: string) {
    return createCircuitContext<DicePrivateState>(
      circuitId,
      this.address,
      COIN_PUBLIC_KEY,
      this.state,
      this.privateState,
    );
  }

  /** Run a generated circuit and commit its resulting ledger and private state. */
  async run<R>(
    circuitId: string,
    call: (ctx: ReturnType<BaseSimulator['context']>) => Promise<CircuitResult<R>>,
  ): Promise<R> {
    const res = await call(this.context(circuitId));
    this.state = res.context.callContext.currentQueryContext.state;
    if (res.context.callContext.currentPrivateState !== undefined) {
      this.privateState = res.context.callContext.currentPrivateState;
    }
    return res.result;
  }
}

export class DiceSimulator extends BaseSimulator {
  dice: DiceContract<DicePrivateState>;

  constructor(privateState: DicePrivateState) {
    const contract = new DiceContract<DicePrivateState>(diceWitnesses);
    super(contract as unknown as AnyContract, privateState);
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

export class TurnSimulator extends BaseSimulator {
  turn: TurnContract<DicePrivateState>;

  constructor(privateState: DicePrivateState) {
    const contract = new TurnContract<DicePrivateState>(diceWitnesses);
    super(contract as unknown as AnyContract, privateState);
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
