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
 * The fixture is a capture of a live tier-1 table mid-game, two seats joined, nothing redeemed:
 * `fixtures/table-state-two-seats.hex` is the `contractAction { state }` hex for
 * ff0e437589bdb945dd9eeab482ade1c8b00e9785bae9a3451b6db4434e452398 at block 2566 of a local
 * ledger-8 chain. Being a real state, it also fails if a future runtime stops carrying balances
 * in the serialisation at all -- which is the failure mode the indexer already has.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { ContractState } from '@midnight-ntwrk/compact-runtime';

import {
  NATIVE_TOKEN_HEX,
  nativeBalance,
  nativeBalanceOf,
  unshieldedBalances,
} from '../custody.ts';
import { Table } from '../index.ts';

const OTHER_TOKEN = `01${'00'.repeat(31)}`;

function fixtureState(): ContractState {
  const hex = readFileSync(
    new URL('./fixtures/table-state-two-seats.hex', import.meta.url),
    'utf8',
  ).trim();
  return ContractState.deserialize(Uint8Array.from(Buffer.from(hex, 'hex')));
}

describe('custody: a real table state', () => {
  it('carries the staked NIGHT in its balance map', () => {
    const state = fixtureState();
    assert.equal(state.balance.size, 1, 'the fixture table holds exactly one token type');
    assert.equal(nativeBalanceOf(state), 2_000_000_000n);
  });

  it('backs the pot the contract itself claims -- the custody invariant', () => {
    const state = fixtureState();
    const led = Table.ledger(state.data);

    let redeemable = 0n;
    for (let seat = 0n; seat < led.seatCount; seat++) {
      if (led.seatRedeemable.member(seat)) redeemable += led.seatRedeemable.lookup(seat);
    }

    // docs/table-interface.md §6: the ledger holds the pot plus anything owed but not yet paid.
    assert.equal(nativeBalanceOf(state), led.pot + redeemable);
    // and this particular capture is two seats' worth of a tier-1 stake, nothing eliminated
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
