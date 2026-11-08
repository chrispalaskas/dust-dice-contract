// Copyright (C) Shielded Technologies
// SPDX-License-Identifier: Apache-2.0

/**
 * Custody, decoded from a REAL table's state.
 *
 * The regression this pins: on ledger 8 / indexer 4.3.x every consumer read the contract's
 * holdings from the indexer's `contractAction { unshieldedBalances }`, which answers `[]` for
 * a contract that is demonstrably holding NIGHT -- so the table page reported "contract believes
 * it holds 2,000 NIGHT in the pot · ledger reports 0 NIGHT" for a healthy table with two seats
 * staked, which is the shape of a solvency alarm. The balances are in the serialised
 * `ContractState` the same indexer hands out, and `src/custody.ts` reads them from there.
 *
 * The fixture is a capture of a live two-seat table just STARTED, nothing redeemed:
 * `fixtures/table-state-two-seats.hex` is the `contractAction { state }` hex that table
 * 15838ed7d8850262c5541556b6d568d5df7562cb2b41322e16e6e0f0c6ad6ebb's start (`abortTable`, tx ff5a9116…, block 111) left
 * on a local ledger-9 chain, 2026-09-29 -- contract 0.5.6, the blind-VRF table with slot joins
 * (table.compact section 9): the practice bot's 1-NIGHT fast table, whose two joins landed in
 * blocks 102 and 107. Captured with `contractAction(address, offset: { transactionOffset: { hash } })`.
 * Being a real state, it also fails if a future runtime stops carrying balances in the
 * serialisation at all -- which is the failure mode the indexer already has.
 *
 * A serialised ContractState is generation-specific: its header tag is
 * `midnight:contract-state[v8]:` here, and a ledger-8 capture says `[v6]`, which the ledger-9
 * runtime refuses outright. Re-capture rather than translate when the generation or the ledger
 * layout moves.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { CompactTypeUnsignedInteger, ContractState } from '@midnight-ntwrk/compact-runtime';

import {
  NATIVE_TOKEN_HEX,
  nativeBalance,
  nativeBalanceOf,
  unshieldedBalances,
} from '../custody.ts';

const OTHER_TOKEN = `01${'00'.repeat(31)}`;

function fixtureState(): ContractState {
  const hex = readFileSync(
    new URL('./fixtures/table-state-two-seats.hex', import.meta.url),
    'utf8',
  ).trim();
  return ContractState.deserialize(Uint8Array.from(Buffer.from(hex, 'hex')));
}

/**
 * The few ledger fields this test needs, read from the fixture AT THE 0.5.6 (ledger-9) ADDRESSES it was
 * captured under -- not through the current `Table.ledger()`.
 *
 * A ledger field's address is `[bucket, index]`, and the compiler rebalances the buckets by the
 * total field count (src/test/ledger-access.ts), so adding ANY field moves every address. The
 * practice table's `house` (table.compact section 10) did exactly that, and the current bindings
 * read this real state's `pot` from what is, in 0.5.6, another field. A state has to be read
 * with the layout that wrote it -- the same reason a deployed table keeps its own build. A
 * replacement capture needs a live chain; until there is one this pins the 0.5.6 layout here,
 * and the assertions below are unchanged.
 */
function fixtureLedger056(state: ContractState) {
  const U8 = new CompactTypeUnsignedInteger(255n, 1);
  const U64 = new CompactTypeUnsignedInteger(18446744073709551615n, 8);
  const root = state.data.state.asArray()!;
  const cell = (bucket: number, index: number) => [
    ...root[bucket]!.asArray()![index]!.asCell().value,
  ];
  const redeemable = root[2]!.asArray()![5]!.asMap()!;
  return {
    tier: U64.fromValue(cell(0, 1)),
    seatCount: U8.fromValue(cell(1, 5)),
    pot: U64.fromValue(cell(1, 10)),
    seatRedeemable: (seat: bigint): bigint => {
      for (const key of redeemable.keys()) {
        if (U8.fromValue([...key.value]) === seat)
          return U64.fromValue([...redeemable.get(key)!.asCell().value]);
      }
      return 0n;
    },
  };
}

describe('custody: a real table state', () => {
  it('carries the staked NIGHT in its balance map', () => {
    const state = fixtureState();
    assert.equal(state.balance.size, 1, 'the fixture table holds exactly one token type');
    // Two seats of the practice table's 1 NIGHT (1,000,000 atomic units) each.
    assert.equal(nativeBalanceOf(state), 2_000_000n);
  });

  it('backs the pot the contract itself claims -- the custody invariant', () => {
    const state = fixtureState();
    const led = fixtureLedger056(state);

    let redeemable = 0n;
    for (let seat = 0n; seat < led.seatCount; seat++) {
      redeemable += led.seatRedeemable(seat);
    }

    // docs/table-interface.md §6: the ledger holds the pot plus anything owed but not yet paid.
    assert.equal(nativeBalanceOf(state), led.pot + redeemable);
    // and this particular capture is two seats' worth of its stake, nothing eliminated
    assert.equal(led.seatCount, 2n);
    assert.equal(redeemable, 0n);
    assert.equal(led.pot, led.tier * led.seatCount);
  });
});

describe('custody: decoding', () => {
  const state = (entries: [string, string, bigint][]): ContractState =>
    ({
      balance: new Map(entries.map(([tag, raw, v]) => [{ tag, raw }, v])),
    }) as unknown as ContractState;

  it('keys unshielded entries by token-type hex', () => {
    assert.deepEqual(
      unshieldedBalances(
        state([
          ['unshielded', NATIVE_TOKEN_HEX, 7n],
          ['unshielded', OTHER_TOKEN, 3n],
        ]),
      ),
      { [NATIVE_TOKEN_HEX]: 7n, [OTHER_TOKEN]: 3n },
    );
  });

  it('ignores shielded and dust holdings -- only the unshielded pot is custody', () => {
    const balances = unshieldedBalances(
      state([
        ['shielded', NATIVE_TOKEN_HEX, 5n],
        ['dust', NATIVE_TOKEN_HEX, 9n],
      ]),
    );
    assert.deepEqual(balances, {});
    assert.equal(nativeBalance(balances), 0n);
  });

  it('accepts an 0x prefix and upper case from the runtime', () => {
    assert.equal(
      nativeBalanceOf(state([['unshielded', `0X${NATIVE_TOKEN_HEX.toUpperCase()}`, 11n]])),
      11n,
    );
  });

  it('reports zero rather than throwing when the contract holds no NIGHT', () => {
    assert.equal(nativeBalanceOf(state([])), 0n);
    assert.equal(nativeBalanceOf(state([['unshielded', OTHER_TOKEN, 4n]])), 0n);
  });
});
