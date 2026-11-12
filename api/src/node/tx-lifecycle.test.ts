import { describe, expect, it } from 'vitest';
import * as Rx from 'rxjs';
import { DefaultForkSchedule } from '@midnightntwrk/wallet-sdk';

import { pacedTransactionLifecycle } from './tx-lifecycle.js';

// What it saves can only be seen on a live chain (a record exists only for a proven transaction):
// measured on mainnet instead. Here: it is the SDK's service, it starts and stops, it keeps state.
describe('pacedTransactionLifecycle', () => {
  it('builds the SDK service, starts, keeps an empty record set, and stops', async () => {
    const service = await pacedTransactionLifecycle()(
      {
        indexerClientConnection: {
          indexerHttpUrl: 'http://127.0.0.1:9/never-asked',
          indexerWsUrl: 'ws://127.0.0.1:9/never-asked',
        },
        forks: { v9: DefaultForkSchedule.v9 },
      },
      { clock: { now: () => new Date() } },
    );
    await service.start();
    const state = await Rx.firstValueFrom(service.state());
    expect(state.records).toEqual([]);
    expect(typeof (await service.serializeState())).toBe('string');
    await service.stop();
  });
});
