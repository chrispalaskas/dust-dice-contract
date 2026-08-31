// The six-provider wiring for Node-side consumers, promoted from
// probes/gate0/src/providers.ts (proven end to end during Gate 0), with the timing
// instrumentation kept optional.
//
// Private state: in-memory by default. The Table contract's private state is plain data
// (a seat secret / the operator's seed supplied per call), but the level-backed provider
// self-deadlocks on concurrent opens and silently drops function-valued fields
// (bugs-found.md §0 #12/#18); nothing in this dapp needs disk-persisted private state —
// seats and seeds are persisted by their owners (cli/service) explicitly.

import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import type {
  MidnightProviders,
  PrivateStateId,
  PrivateStateProvider,
  ProofProvider,
} from '@midnight-ntwrk/midnight-js-types';
import type {
  ContractAddress,
  SigningKey,
} from '@midnight-ntwrk/midnight-js-protocol/compact-runtime';

import { TX_TTL_MS } from './network.js';
import type { WalletContext } from './wallet.js';

/** Mutable per-call timing sink; pass a fresh one per measured circuit call. */
export interface Phases {
  proveMs: number;
  balanceMs: number;
  submitMs: number;
  /** >1 would mean a multi-proof (cross-contract) transaction. */
  proveCalls: number;
}

export const newPhases = (): Phases => ({ proveMs: 0, balanceMs: 0, submitMs: 0, proveCalls: 0 });

export class InMemoryPrivateStateProvider<
  PSI extends PrivateStateId = PrivateStateId,
  PS = unknown,
> implements PrivateStateProvider<PSI, PS> {
  private readonly states = new Map<PSI, PS>();
  private readonly signingKeys = new Map<string, SigningKey>();

  setContractAddress(): void {}
  async set(id: PSI, state: PS): Promise<void> {
    this.states.set(id, state);
  }
  async get(id: PSI): Promise<PS | null> {
    return this.states.get(id) ?? null;
  }
  async remove(id: PSI): Promise<void> {
    this.states.delete(id);
  }
  async clear(): Promise<void> {
    this.states.clear();
  }
  async setSigningKey(address: ContractAddress, key: SigningKey): Promise<void> {
    this.signingKeys.set(String(address), key);
  }
  async getSigningKey(address: ContractAddress): Promise<SigningKey | null> {
    return this.signingKeys.get(String(address)) ?? null;
  }
  async removeSigningKey(address: ContractAddress): Promise<void> {
    this.signingKeys.delete(String(address));
  }
  async clearSigningKeys(): Promise<void> {
    this.signingKeys.clear();
  }
  async exportPrivateStates(): Promise<never> {
    throw new Error('in-memory private state holds nothing durable');
  }
  async importPrivateStates(): Promise<never> {
    throw new Error('in-memory private state cannot be imported into');
  }
  async exportSigningKeys(): Promise<never> {
    throw new Error('in-memory private state holds nothing durable');
  }
  async importSigningKeys(): Promise<never> {
    throw new Error('in-memory private state cannot be imported into');
  }
}

/**
 * @param managedDir Absolute path to the contract's compiled `managed/<name>` directory —
 *   NodeZkConfigProvider reads `keys/` and `zkir/` from under it.
 * @param phases Optional timing sink (see Gate 0's Q2 methodology).
 */
export function createProviders<CK extends string, PS = unknown>(
  ctx: WalletContext,
  managedDir: string,
  phases?: Phases,
): MidnightProviders<CK, PrivateStateId, PS> {
  const walletProvider = {
    getCoinPublicKey: () => ctx.shieldedSecretKeys.coinPublicKey,
    getEncryptionPublicKey: () => ctx.shieldedSecretKeys.encryptionPublicKey,

    // Balancing does NOT sign unshielded inputs; the recipe must be signed explicitly
    // afterwards, and the signer on this SDK line is async — the keystore's signDataAsync
    // already has the SignSegment shape.
    async balanceTx(tx: unknown, ttl?: Date) {
      const t0 = performance.now();
      try {
        const recipe = await ctx.wallet.balanceUnboundTransaction(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          tx as any,
          { shieldedSecretKeys: ctx.shieldedSecretKeys, dustSecretKey: ctx.dustSecretKey },
          { ttl: ttl ?? new Date(Date.now() + TX_TTL_MS) },
        );
        const signed = await ctx.wallet.signRecipe(recipe, ctx.unshieldedKeystore.signDataAsync);
        return await ctx.wallet.finalizeRecipe(signed);
      } finally {
        if (phases) phases.balanceMs += performance.now() - t0;
      }
    },

    async submitTx(tx: unknown) {
      const t0 = performance.now();
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return await ctx.wallet.submitTransaction(tx as any);
      } finally {
        if (phases) phases.submitMs += performance.now() - t0;
      }
    },
  };

  const zkConfigProvider = new NodeZkConfigProvider<CK>(managedDir);
  const rawProofProvider = httpClientProofProvider(ctx.network.proofServer, zkConfigProvider);

  const proofProvider: ProofProvider = {
    async proveTx(unproven, config) {
      const t0 = performance.now();
      try {
        return await rawProofProvider.proveTx(unproven, config);
      } finally {
        if (phases) {
          phases.proveMs += performance.now() - t0;
          phases.proveCalls += 1;
        }
      }
    },
  };

  return {
    privateStateProvider: new InMemoryPrivateStateProvider<PrivateStateId, PS>(),
    publicDataProvider: indexerPublicDataProvider(ctx.network.indexer, ctx.network.indexerWS),
    zkConfigProvider,
    proofProvider,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    walletProvider: walletProvider as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    midnightProvider: walletProvider as any,
  };
}
