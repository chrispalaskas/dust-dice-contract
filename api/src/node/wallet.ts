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
import { DustAddress } from '@midnight-ntwrk/wallet-sdk-address-format';

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

/**
 * One line of where each wallet's replay stands: `applied/highest` per wallet.
 *
 * The unshielded wallet counts transactions (`appliedId/highestTransactionId`), the dust and
 * shielded ones count ledger events (`appliedIndex/highestIndex`); both pairs read the same way.
 */
function describeProgress(state: FacadeState): string {
  const pair = (progress: object): string => {
    const p = progress as Record<string, unknown>;
    const applied = p.appliedIndex ?? p.appliedId;
    const highest = p.highestIndex ?? p.highestTransactionId;
    return `${String(applied)}/${String(highest)}${p.isConnected === false ? ' (disconnected)' : ''}`;
  };
  return (
    `unshielded ${pair(state.unshielded.state.progress)} · ` +
    `dust ${pair(state.dust.state.progress)} · ` +
    `shielded ${pair(state.shielded.state.progress)}`
  );
}

/**
 * Resolves once the unshielded and dust wallets have replayed the chain to its tip.
 *
 * With `log`, reports progress every 30 s until then. A fresh wallet on preprod replays every
 * event since genesis — well over an hour at 100% CPU — and without this the daemon's log shows
 * its startup banner and then nothing, indistinguishable from a hang.
 */
export async function waitForUsableSync(
  ctx: WalletContext,
  log?: (msg: string) => void,
): Promise<FacadeState> {
  const states = ctx.wallet.state();
  const progress = log
    ? states
        .pipe(
          Rx.throttleTime(30_000),
          Rx.takeWhile((s) => !isUsableSync(s)),
        )
        .subscribe((s) => log(`syncing: ${describeProgress(s)}`))
    : undefined;
  try {
    return await Rx.firstValueFrom(states.pipe(Rx.filter(isUsableSync)));
  } finally {
    progress?.unsubscribe();
  }
}

/**
 * wallet-sdk 1.x signs synchronously, `(data) => Signature`. Wrapped in an arrow so the keystore
 * keeps `this`; the unbound method reference the 2.x code passed is not safe to assume here.
 */
function signerFor(ctx: WalletContext): (data: Uint8Array) => ledger.Signature {
  return (data) => ctx.unshieldedKeystore.signData(data);
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

/**
 * Refuses a node from another ledger generation before any wallet starts syncing against it.
 *
 * The wallet SDK's own failure mode is a 200-line Schema dump a minute into sync — "Could not
 * deserialize Ledger Event", payload tagged `midnight:event[v14]` — which is exactly what a
 * ledger-8 build produces when pointed at a ledger-9 devnet. Two devnets of different generations
 * can sit on one machine (main's board holds the default ports), so this asks the node first.
 * Ledger-8 nodes report `=8.1.x`; ledger-9 nodes report `... crate-ledger-9.1.0.0-rc.N ...`.
 */
export async function assertLedgerGeneration(network: NetworkConfig): Promise<void> {
  const rpc = network.node.replace(/^ws/, 'http');
  const res = await fetch(rpc, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 1, jsonrpc: '2.0', method: 'midnight_ledgerVersion', params: [] }),
  });
  const { result } = (await res.json()) as { result?: unknown };
  if (typeof result !== 'string') {
    throw new Error(`node at ${rpc} did not answer midnight_ledgerVersion (HTTP ${res.status})`);
  }
  if (!/(^=|ledger-)8\./.test(result)) {
    throw new Error(
      `node at ${rpc} speaks ledger "${result}" but this build speaks ledger 8 — wrong network or ` +
        `ports? Set MIDNIGHT_NODE_URL / MIDNIGHT_INDEXER_URL / MIDNIGHT_INDEXER_WS_URL / ` +
        `MIDNIGHT_PROOF_SERVER_URL to the ledger-8 stack (see docker-compose.beside-ledger9.yml).`,
    );
  }
}

/**
 * The addresses a seed derives to, without opening a wallet or touching the network.
 *
 * Needed before a wallet exists: a snapshot of replayed state is keyed by address
 * (`service/src/wallet-snapshots.ts`), and funding an operator means publishing its addresses
 * before it has ever started. Same derivation as `createWallet` — account 0, roles
 * Zswap/NightExternal/Dust, index 0 — so the answers are the wallet's own.
 */
export function deriveAddresses(seed: string, networkId: string): { night: string; dust: string } {
  setNetworkId(networkId);
  const id = getNetworkId();
  const keys = deriveKeys(seed);
  return {
    night: createKeystore(keys[Roles.NightExternal], id).getBech32Address().toString(),
    dust: DustAddress.encodePublicKey(
      id,
      ledger.DustSecretKey.fromSeed(keys[Roles.Dust]).publicKey,
    ),
  };
}

/**
 * A wallet's replayed state, as three opaque strings the SDK can restore from.
 *
 * WHY THIS EXISTS: a new wallet replays every ledger event since genesis before it can be used —
 * on preprod that is ~1.5 million events, hours of CPU, dominated by rebuilding the DUST
 * commitment and generation trees. Nothing about that work is specific to a run, so a daemon
 * that snapshots it restarts in seconds instead of hours, and each new lane wallet pays the sync
 * once rather than on every restart.
 *
 * The guard fields matter: restoring a snapshot into a wallet with different keys, or against a
 * different chain, would present someone else's coins as spendable and fail at signing time.
 * `restoreWallet` refuses unless the network and the derived address both match.
 *
 * Contains no secret: the states hold public chain data and the wallet's own view of it. The
 * SEED is the secret, and it is not here.
 */
export interface WalletSnapshot {
  networkId: string;
  /** The unshielded address the snapshot's seed derives to. */
  address: string;
  /** ISO timestamp, for logs and for deciding a snapshot is too stale to bother with. */
  savedAt: string;
  shielded: string;
  unshielded: string;
  dust: string;
}

/**
 * Serialise the three wallets' replayed state. Safe to call at any time; the snapshot is
 * whatever has been applied so far, and restoring it resumes from there.
 */
export async function serializeWallet(ctx: WalletContext): Promise<WalletSnapshot> {
  const [shielded, unshielded, dust] = await Promise.all([
    ctx.wallet.shielded.serializeState(),
    ctx.wallet.unshielded.serializeState(),
    ctx.wallet.dust.serializeState(),
  ]);
  return {
    networkId: ctx.network.networkId,
    address: ctx.address,
    savedAt: new Date().toISOString(),
    shielded,
    unshielded,
    dust,
  };
}

export async function createWallet(
  network: NetworkConfig,
  seed: string,
  snapshot?: WalletSnapshot,
): Promise<WalletContext> {
  setNetworkId(network.networkId);
  await assertLedgerGeneration(network);
  const networkId = getNetworkId();

  const keys = deriveKeys(seed);
  const shieldedSecretKeys = ledger.ZswapSecretKeys.fromSeed(keys[Roles.Zswap]);
  const dustSecretKey = ledger.DustSecretKey.fromSeed(keys[Roles.Dust]);
  // wallet-sdk 1.x (ledger 8) takes the raw Schnorr secret; 2.x wrapped it in a tagged
  // `{ kind: 'schnorr', secret }`.
  const unshieldedKeystore = createKeystore(keys[Roles.NightExternal], networkId);

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

  // A snapshot is only restored into the wallet it came from, on the chain it came from.
  const address = unshieldedKeystore.getBech32Address().toString();
  const restore =
    snapshot !== undefined &&
    snapshot.networkId === network.networkId &&
    snapshot.address === address
      ? snapshot
      : undefined;
  if (snapshot !== undefined && restore === undefined) {
    throw new Error(
      `refusing to restore a wallet snapshot for ${snapshot.address} on ${snapshot.networkId} ` +
        `into ${address} on ${network.networkId}`,
    );
  }

  const wallet = await WalletFacade.init({
    configuration,
    shielded: async (config) =>
      restore
        ? ShieldedWallet(config).restore(restore.shielded)
        : ShieldedWallet(config).startWithSecretKeys(shieldedSecretKeys),
    unshielded: async (config) =>
      restore
        ? UnshieldedWallet(config).restore(restore.unshielded)
        : UnshieldedWallet(config).startWithPublicKey(PublicKey.fromKeyStore(unshieldedKeystore)),
    dust: async (config) =>
      restore
        ? CustomDustWallet(
            config,
            new V1Builder().withDefaults().withCoinSelection(() => largestDustCoinFirst),
          ).restore(restore.dust)
        : CustomDustWallet(
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
    address,
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

/** What the facade's registration estimate takes — the unshielded wallet's own coin records. */
type NightUtxos = Parameters<WalletContext['wallet']['estimateRegistration']>[0];

/**
 * Waits until the DUST projected from exactly `nightUtxos` covers their own registration fee,
 * and returns that fee.
 *
 * A registration pays its fee in DUST, and the only DUST a freshly funded wallet can draw on is
 * what its not-yet-registered NIGHT has already projected — so a wallet funded seconds ago cannot
 * register yet. wallet-sdk 2.x shipped this wait as `waitForGeneratedDust`; 1.x has no such
 * helper, but `estimateRegistration` reports each UTXO's projection at the moment of the call
 * (`generatedNow`) and the ceiling it can never exceed (`maxCap`), which is all the wait needs.
 * Polled once a second, as the 2.x helper was. Fails fast when the ceiling itself is below the
 * fee: no amount of waiting makes too little NIGHT register itself.
 */
export async function waitForRegistrationFeeCoverage(
  ctx: WalletContext,
  nightUtxos: NightUtxos,
  timeoutMs: number,
  log: (msg: string) => void = () => {},
): Promise<bigint> {
  const deadline = Date.now() + timeoutMs;
  let announced = false;
  for (;;) {
    const { fee, dustGenerationEstimations } = await ctx.wallet.estimateRegistration(nightUtxos);
    const available = dustGenerationEstimations.reduce((s, e) => s + e.dust.generatedNow, 0n);
    if (available >= fee) return fee;
    const ceiling = dustGenerationEstimations.reduce((s, e) => s + e.dust.maxCap, 0n);
    if (ceiling < fee) {
      throw new Error(
        `these NIGHT UTXOs can generate at most ${ceiling} Specks of DUST, below their own ` +
          `registration fee of ${fee} — fund more NIGHT`,
      );
    }
    if (Date.now() > deadline) {
      throw new Error(
        `projected DUST ${available} never reached registration fee ${fee} within ${timeoutMs} ms`,
      );
    }
    if (!announced) {
      log(`waiting for projected DUST: have ${available}, registration fee ${fee}`);
      announced = true;
    }
    await new Promise((r) => setTimeout(r, 1_000));
  }
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
  const state = await waitForUsableSync(ctx, log);

  const unregistered = state.unshielded.availableCoins.filter(
    (c) => !c.meta.registeredForDustGeneration,
  );

  if (unregistered.length > 0) {
    const fee = await waitForRegistrationFeeCoverage(ctx, unregistered, 600_000, log);
    log(`registering ${unregistered.length} NIGHT UTXO(s) for DUST generation (fee ${fee})`);

    // The signer callback returns an ALREADY-SIGNED recipe. Do NOT signRecipe again —
    // double-signing is rejected as InputsSignaturesLengthMismatch (Custom error 192).
    const recipe = await ctx.wallet.registerNightUtxosForDustGeneration(
      unregistered,
      ctx.unshieldedKeystore.getPublicKey(),
      signerFor(ctx),
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
  const signed = await ctx.wallet.signRecipe(recipe, signerFor(ctx));
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
