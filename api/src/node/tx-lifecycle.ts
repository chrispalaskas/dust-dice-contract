// Copyright (C) Shielded Technologies
// SPDX-License-Identifier: Apache-2.0

// The wallet facade's transaction lifecycle service, asking the indexer about pending transactions
// once a block rather than once a second.
//
// wallet-sdk-capabilities 4.0.0 asks about every transaction still pending each second until it is
// final, and Blockfrost shows a block only once it is finalized, ~18 s after it is sent: about 18
// requests a transaction. Measured on mainnet (2026-11-12, one backgammon game), that was 1,709 of
// the operator's 1,983 Blockfrost requests. The wallets' own sync confirms a transaction as it lands
// (the facade feeds their inclusions to this service), so the poll is a fallback; the sweep that
// expires a dropped transaction's record runs on the same tick, so it is slowed, not switched off.

import { Clock, DefaultServices, Duration, Effect, Scope, Stream } from 'effect';
import {
  TransactionLifecycleServiceEffectImpl,
  TransactionLifecycleServiceImpl,
  type DefaultTransactionLifecycleServiceConfiguration,
} from '@midnightntwrk/wallet-sdk/capabilities/transactionLifecycle';
import { HttpQueryClient } from '@midnightntwrk/wallet-sdk/indexer-client/effect';
import { lifecycleTransactionTraits, type LifecycleTx } from '@midnightntwrk/wallet-sdk/facade';
import type { ProtocolVersion } from '@midnightntwrk/wallet-sdk-abstractions';

/** One poll per block (6 s slots): a transaction costs ~3 requests to finality, not ~18. */
export const WALLET_TX_POLL_MS = 6_000;

/** The facade's clock: the wall time it stamps and expires lifecycle records by. */
type WallClock = { now(): Date };

/** That clock as Effect's, the way the SDK's own `init` adapts it (its `effectClockOf`). */
function effectClockOf(wall: WallClock): Clock.Clock {
  const system = Clock.make();
  const millis = () => wall.now().getTime();
  return {
    [Clock.ClockTypeId]: Clock.ClockTypeId,
    unsafeCurrentTimeMillis: millis,
    currentTimeMillis: Effect.sync(millis),
    unsafeCurrentTimeNanos: () => BigInt(millis()) * 1_000_000n,
    currentTimeNanos: Effect.sync(() => BigInt(millis()) * 1_000_000n),
    sleep: (duration) => system.sleep(duration),
  };
}

/** The SDK's service with `start` polling every `pollMs` instead of every second. */
class PacedLifecycleService extends TransactionLifecycleServiceImpl<LifecycleTx> {
  readonly #run: () => void;

  constructor(
    configuration: DefaultTransactionLifecycleServiceConfiguration,
    forkVersion: ProtocolVersion.ProtocolVersion,
    clock: Clock.Clock,
    scope: Scope.CloseableScope,
    pollMs: number,
  ) {
    const effect = new TransactionLifecycleServiceEffectImpl(
      lifecycleTransactionTraits(forkVersion),
    );
    super(effect, scope, configuration, clock);
    // As the SDK's own `start`, the tick aside; `stop` closes the same scope, which ends it.
    this.#run = () =>
      void effect
        .startPolling(Stream.tick(Duration.millis(pollMs)))
        .pipe(
          Effect.withClock(clock),
          Effect.provide(
            HttpQueryClient.layer({ url: configuration.indexerClientConnection.indexerHttpUrl }),
          ),
          Effect.provideService(Scope.Scope, scope),
          Effect.provide(DefaultServices.liveServices),
          Effect.runFork,
        );
  }

  override start(): Promise<void> {
    this.#run();
    return Promise.resolve();
  }
}

/** `WalletFacade.init`'s `transactionLifecycleService` factory, polling every `pollMs`. */
export function pacedTransactionLifecycle(pollMs: number = WALLET_TX_POLL_MS) {
  return async (
    config: DefaultTransactionLifecycleServiceConfiguration & {
      forks: { v9: ProtocolVersion.ProtocolVersion };
    },
    deps: { clock: WallClock },
  ): Promise<TransactionLifecycleServiceImpl<LifecycleTx>> =>
    new PacedLifecycleService(
      config,
      config.forks.v9,
      effectClockOf(deps.clock),
      await Effect.runPromise(Scope.make()),
      pollMs,
    );
}
