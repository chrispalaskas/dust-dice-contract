// Wallet construction, sync, DUST registration and NIGHT transfer, for Node-side
// consumers (cli, service). Promoted from probes/gate0/src/wallet.ts, which proved this
// exact wiring end to end on the devnet; parameterised over NetworkConfig instead of a
// module-level constant so the service can hold several configs.
//
// Two footguns are load-bearing and preserved deliberately:
//
//  1. NEVER await `wallet.waitForSyncedState()` / `isSynced`. `FacadeState.isSynced` ANDs all
//     three child wallets including the shielded one, and on this SDK/indexer pairing the
//     shielded wallet never issues its `shieldedTransactions` subscription — so `isSynced`
//     never becomes true and anything awaiting it hangs forever. `isUsableSync` below mirrors
//     the real implementation minus the shielded term. (bugs-found.md §0 #7)
//
//  2. `registerNightUtxosForDustGeneration`'s third argument is a signer callback that already
//     returns a FULLY SIGNED recipe. Calling `signRecipe` on it as well double-signs and the
//     chain rejects with InputsSignaturesLengthMismatch (Custom error 192).
//
// ONE WALLET PER PROCESS, spends strictly sequential per wallet — concurrent DUST spends
// from one seed race and the loser is rejected (bugs-found.md §0 #8/#22 triad).

import { Buffer } from 'node:buffer';

import * as Rx from 'rxjs';
import * as ledger from '@midnight-ntwrk/midnight-js-protocol/ledger';
import { unshieldedToken } from '@midnight-ntwrk/midnight-js-protocol/ledger';
import { setNetworkId, getNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import {
  CoinsAndBalances as DustCoins,
  CustomDustWallet,
  V1Builder,
} from '@midnight-ntwrk/wallet-sdk-dust-wallet/v1';
import {
  WalletFacade,
  HDWallet,
  Roles,
  ShieldedWallet,
  createKeystore,
  NoOpTransactionHistoryStorage,
  PublicKey,
  UnshieldedWallet,
  MidnightBech32m,
  UnshieldedAddress,
} from '@midnight-ntwrk/wallet-sdk';
import type { FacadeState } from '@midnight-ntwrk/wallet-sdk';

import { TX_TTL_MS, type NetworkConfig } from './network.js';

export { unshieldedToken };

export interface WalletContext {
  wallet: Awaited<ReturnType<typeof WalletFacade.init>>;
  shieldedSecretKeys: ReturnType<typeof ledger.ZswapSecretKeys.fromSeed>;
  dustSecretKey: ReturnType<typeof ledger.DustSecretKey.fromSeed>;
  unshieldedKeystore: ReturnType<typeof createKeystore>;
  /** bech32m unshielded (NIGHT) address — what a payout has to name. */
  address: string;
  network: NetworkConfig;
}

function deriveKeys(seed: string) {
  const hd = HDWallet.fromSeed(Buffer.from(seed, 'hex'));
  if (hd.type !== 'seedOk') throw new Error('invalid seed');
  const result = hd.hdWallet
    .selectAccount(0)
    .selectRoles([Roles.Zswap, Roles.NightExternal, Roles.Dust])
    .deriveKeysAt(0);
  if (result.type !== 'keysDerived') throw new Error('key derivation failed');
  hd.hdWallet.clear();
  return result.keys;
}

/** `FacadeState.isSynced` minus the shielded term — see the module header. */
function isUsableSync(state: FacadeState): boolean {
  return (
    state.dust.state.progress.isStrictlyComplete() &&
    state.unshielded.state.progress.isStrictlyComplete()
  );
}

export async function waitForUsableSync(ctx: WalletContext): Promise<FacadeState> {
  return Rx.firstValueFrom(ctx.wallet.state().pipe(Rx.filter(isUsableSync)));
}

/**
 * DUST coin selection: the LARGEST coin first.
 *
 * The SDK's default picks the smallest coin first. A wallet that has paid many fees holds a
 * dozen tiny DUST change coins beside a few large ones, and smallest-first then selects only the
 * tiny ones; the fee of a transaction with that many spends exceeds what they cover, the next
 * round of the SDK's balancing loop selects NOTHING, and the loop — which only stops when the
 * fee is covered — spins forever, allocating WASM transactions with the event loop blocked
 * (observed live: the operator daemon at 3 GB in nine minutes; docs/bugs-found.md #31). One
 * large coin covers any fee in a single iteration.
 */
const largestDustCoinFirst: DustCoins.CoinSelection = (coins) =>
  [...coins].sort((a, b) => (b.value > a.value ? 1 : b.value < a.value ? -1 : 0)).at(0);

export async function createWallet(network: NetworkConfig, seed: string): Promise<WalletContext> {
  setNetworkId(network.networkId);
  const networkId = getNetworkId();

  const keys = deriveKeys(seed);
  const shieldedSecretKeys = ledger.ZswapSecretKeys.fromSeed(keys[Roles.Zswap]);
  const dustSecretKey = ledger.DustSecretKey.fromSeed(keys[Roles.Dust]);
  // wallet-sdk 2.x takes a tagged UnshieldedSecretKey rather than raw bytes. Midnight's
  // unshielded (NIGHT) keys are Schnorr.
  const unshieldedKeystore = createKeystore(
    { kind: 'schnorr', secret: keys[Roles.NightExternal] },
    networkId,
  );

  const configuration = {
    networkId,
    indexerClientConnection: {
      indexerHttpUrl: network.indexer,
      indexerWsUrl: network.indexerWS,
    },
    provingServerUrl: new URL(network.proofServer),
    relayURL: new URL(network.node.replace(/^http/, 'ws')),
    txHistoryStorage: new NoOpTransactionHistoryStorage(),
    costParameters: { additionalFeeOverhead: 300_000_000_000_000n, feeBlocksMargin: 5 },
  };

  const wallet = await WalletFacade.init({
    configuration,
    shielded: async (config) => ShieldedWallet(config).startWithSecretKeys(shieldedSecretKeys),
    unshielded: async (config) =>
      UnshieldedWallet(config).startWithPublicKey(PublicKey.fromKeyStore(unshieldedKeystore)),
    dust: async (config) =>
      CustomDustWallet(
        config,
        new V1Builder().withDefaults().withCoinSelection(() => largestDustCoinFirst),
      ).startWithSecretKey(dustSecretKey, ledger.LedgerParameters.initialParameters().dust),
  });

  await wallet.start(shieldedSecretKeys, dustSecretKey);

  return {
    wallet,
    shieldedSecretKeys,
    dustSecretKey,
    unshieldedKeystore,
    address: unshieldedKeystore.getBech32Address().toString(),
    network,
  };
}

export interface Balances {
  night: bigint;
  dust: bigint;
  utxos: { value: bigint; registeredForDustGeneration: boolean }[];
}

/**
 * `state.unshielded.availableCoins` is `UtxoWithMeta[]` — the value lives on `.utxo.value`,
 * NOT on the element itself. NOTE: the facade's aggregate `balances` misreported mid-run
 * during Gate 0 (bugs-found #9) — for evidence-grade numbers use per-transaction indexer
 * UTXO reads (probes/gate0/tools/utxo-audit.mjs pattern), not this.
 */
export async function readBalances(ctx: WalletContext): Promise<Balances> {
  const state = await waitForUsableSync(ctx);
  return {
    night: state.unshielded.balances[unshieldedToken().raw] ?? 0n,
    dust: state.dust.balance(new Date()),
    utxos: state.unshielded.availableCoins.map((c) => ({
      value: c.utxo.value,
      registeredForDustGeneration: c.meta.registeredForDustGeneration,
    })),
  };
}

/**
 * Registers any unregistered NIGHT UTXOs for DUST generation, waiting first for the
 * projected DUST from exactly that UTXO set to cover the registration's own fee (the
 * bootstrap ordering a freshly funded wallet hits — gate0-report.md "designation").
 */
export async function ensureDustRegistered(
  ctx: WalletContext,
  log: (msg: string) => void = () => {},
): Promise<void> {
  const state = await waitForUsableSync(ctx);

  const unregistered = state.unshielded.availableCoins.filter(
    (c) => !c.meta.registeredForDustGeneration,
  );

  if (unregistered.length > 0) {
    const { fee } = await ctx.wallet.estimateRegistration(unregistered);
    log(`registering ${unregistered.length} NIGHT UTXO(s) for DUST generation (fee ${fee})`);
    await ctx.wallet.waitForGeneratedDust(unregistered, fee, { timeoutMs: 600_000 });

    // The signer callback returns an ALREADY-SIGNED recipe. Do NOT signRecipe again —
    // double-signing is rejected as InputsSignaturesLengthMismatch (Custom error 192).
    const recipe = await ctx.wallet.registerNightUtxosForDustGeneration(
      unregistered,
      ctx.unshieldedKeystore.getPublicKey(),
      ctx.unshieldedKeystore.signDataAsync,
    );
    const finalized = await ctx.wallet.finalizeRecipe(recipe);
    const txHash = await ctx.wallet.submitTransaction(finalized);
    log(`dust registration tx ${txHash}`);
  }

  if (state.dust.balance(new Date()) === 0n) {
    log('waiting for DUST to accrue');
    await Rx.firstValueFrom(
      ctx.wallet.state().pipe(
        Rx.throttleTime(2000),
        Rx.filter(isUsableSync),
        Rx.filter((s) => s.dust.balance(new Date()) > 0n),
      ),
    );
  }
}

/**
 * Sends `amount` of unshielded NIGHT to a bech32m address. Spending our own NIGHT UTXOs
 * needs our own signature (unlike DUST registration, which the callback signs).
 */
export async function transferTo(
  ctx: WalletContext,
  bech32: string,
  amount: bigint,
): Promise<string> {
  const parsed = MidnightBech32m.parse(bech32);
  const ours = ctx.unshieldedKeystore.getBech32Address();
  if (parsed.network !== ours.network) {
    throw new Error(`address is for '${String(parsed.network)}', not '${String(ours.network)}'`);
  }
  const receiverAddress = parsed.decode(UnshieldedAddress, parsed.network);

  const recipe = await ctx.wallet.transferTransaction(
    [{ type: 'unshielded', outputs: [{ type: unshieldedToken().raw, receiverAddress, amount }] }],
    { shieldedSecretKeys: ctx.shieldedSecretKeys, dustSecretKey: ctx.dustSecretKey },
    { ttl: new Date(Date.now() + TX_TTL_MS) },
  );
  const signed = await ctx.wallet.signRecipe(recipe, ctx.unshieldedKeystore.signDataAsync);
  const tx = await ctx.wallet.finalizeRecipe(signed);
  return await ctx.wallet.submitTransaction(tx);
}

/**
 * Decodes a bech32m unshielded address into the raw 32 bytes a circuit's
 * `UserAddress { bytes: Bytes<32> }` argument needs — as a plain Uint8Array, which is what
 * the compact runtime's argument type check requires.
 */
export function userAddressBytes(bech32: string): Uint8Array {
  const parsed = MidnightBech32m.parse(bech32);
  const decoded = parsed.decode(UnshieldedAddress, parsed.network);
  if (decoded.data.length !== UnshieldedAddress.keyLength) {
    throw new Error(`address ${bech32} decoded to ${decoded.data.length} bytes, expected 32`);
  }
  return new Uint8Array(decoded.data);
}
