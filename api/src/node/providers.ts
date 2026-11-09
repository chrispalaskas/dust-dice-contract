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
import {
  createLedger9MidnightProvider,
  createLedger9WalletProvider,
  type ContractPrivateStates,
  type MidnightProviders,
  type PrivateStateId,
  type PrivateStateProvider,
  type ProofProvider,
} from '@midnight-ntwrk/midnight-js-types';
import type { ContractAddress, SigningKey } from '@midnight-ntwrk/compact-runtime';
import { Transaction } from '@midnightntwrk/ledger-v9';

import { TX_TTL_MS } from './network.js';
import { adoptFinalized, balanceAndFinalize, type WalletContext } from './wallet.js';

/** Mutable per-call timing sink; pass a fresh one per measured circuit call. */
export interface Phases {
  proveMs: number;
  balanceMs: number;
  submitMs: number;
  /** >1 would mean a multi-proof (cross-contract) transaction. */
  proveCalls: number;
}

export const newPhases = (): Phases => ({ proveMs: 0, balanceMs: 0, submitMs: 0, proveCalls: 0 });

/**
 * midnight-js 5.0.0 keys private state by contract: `forContract(address)` gives that contract's
 * store. Plain maps here; nothing in this dapp needs it on disk (seats and seeds are persisted by
 * their owners).
 */
export class InMemoryPrivateStateProvider<
  PSI extends PrivateStateId = PrivateStateId,
  PS = unknown,
> implements PrivateStateProvider<PSI, PS> {
  private readonly states = new Map<string, Map<PSI, PS>>();
  private readonly signingKeys = new Map<string, SigningKey>();

  forContract(contractAddress: ContractAddress): ContractPrivateStates<PSI, PS> {
    const key = String(contractAddress);
    let m = this.states.get(key);
    if (!m) {
      m = new Map();
      this.states.set(key, m);
    }
    const map = m;
    return {
      contractAddress,
      set: async (id, state) => {
        map.set(id, state);
      },
      get: async (id) => map.get(id) ?? null,
      remove: async (id) => {
        map.delete(id);
      },
      clear: async () => {
        map.clear();
      },
      exportPrivateStates: async () => {
        throw new Error('in-memory private state holds nothing durable');
      },
      importPrivateStates: async () => {
        throw new Error('in-memory private state cannot be imported into');
      },
    } as ContractPrivateStates<PSI, PS>;
  }
  async clearAll(): Promise<void> {
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
  async exportSigningKeys(): Promise<never> {
    throw new Error('in-memory private state holds nothing durable');
  }
  async importSigningKeys(): Promise<never> {
    throw new Error('in-memory private state cannot be imported into');
  }
}

/**
 * @param managedDir Absolute path to the contract's compiled `managed/<name>` directory —
 *   NodeZkConfigProvider reads `keys/`, `zkir/` and `compiler/` from under it.
 * @param phases Optional timing sink (see Gate 0's Q2 methodology).
 */
export function createProviders<CK extends string, PS = unknown>(
  ctx: WalletContext,
  managedDir: string,
  phases?: Phases,
): MidnightProviders<CK, PrivateStateId, PS> {
  // midnight-js 5 hands the wallet era-tagged handles; the wallet SDK takes its own. They meet as
  // bytes: read with this build's ledger copy, then adopted at the wallet's protocol version.
  const walletProvider = createLedger9WalletProvider({
    getCoinPublicKey: () => ctx.shieldedSecretKeys.coinPublicKey,
    getEncryptionPublicKey: () => ctx.shieldedSecretKeys.encryptionPublicKey,
    async balanceTx(tx, ttl) {
      const t0 = performance.now();
      try {
        const raw = Transaction.deserialize('signature', 'proof', 'pre-binding', tx.serialize());
        const finalized = await balanceAndFinalize(ctx, raw, {
          ttl: ttl ?? new Date(Date.now() + TX_TTL_MS),
        });
        return finalized.serialize();
      } finally {
        if (phases) phases.balanceMs += performance.now() - t0;
      }
    },
  });

  const midnightProvider = createLedger9MidnightProvider(async (tx) => {
    const t0 = performance.now();
    try {
      const raw = Transaction.deserialize('signature', 'proof', 'binding', tx.serialize());
      return await ctx.wallet.submitTransaction(await adoptFinalized(ctx, raw));
    } finally {
      if (phases) phases.submitMs += performance.now() - t0;
    }
  });

  const zkConfigProvider = new NodeZkConfigProvider<CK>(managedDir);
  const rawProofProvider = httpClientProofProvider(ctx.network.proofServer, zkConfigProvider);

  const proofProvider: ProofProvider = {
    supportedEras: rawProofProvider.supportedEras,
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
    publicDataProvider: indexerPublicDataProvider({
      queryURL: ctx.network.indexer,
      subscriptionURL: ctx.network.indexerWS,
    }),
    zkConfigProvider,
    proofProvider,
    walletProvider,
    midnightProvider,
    config: { networkId: ctx.network.networkId, ttlSeconds: Math.floor(TX_TTL_MS / 1000) },
  };
}
