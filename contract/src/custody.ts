// Copyright (C) Shielded Technologies
// SPDX-License-Identifier: Apache-2.0

/**
 * What a contract HOLDS, decoded from its own ledger state.
 *
 * A table's custody invariant is `contract balance == pot + Σ seatRedeemable`
 * (docs/table-interface.md §6), and checking it needs the left-hand side: the unshielded tokens
 * the ledger says the contract is sitting on, which is a different thing from the `pot` the
 * contract's own fields claim. Every consumer of that invariant -- the CLI driver, the
 * chain-only verifier, the table page's custody row -- decodes it here, so there is one place
 * that knows where the ledger keeps it.
 *
 * NOT the indexer's `contractAction { unshieldedBalances }`. That field exists in the 4.3.x
 * schema and it answers `[]` for every action of every contract we have looked at, including
 * tables demonstrably holding NIGHT -- so reading custody from it silently reports 0 and turns
 * the invariant into "the contract claims a pot the ledger does not back", which is exactly the
 * alarm it is supposed to raise. The serialised `ContractState` the same indexer hands out
 * DOES carry the balances (`ContractState.balance`), and so does the node's own
 * `midnight_contractState` -- that map is the source of truth here. See
 * `src/test/custody.test.ts`, which pins a real table's state against this.
 *
 * (The balance map is keyed by a `TokenType` OBJECT, not by a string: two entries for the same
 * raw hex under different tags are distinct keys, and `Map` lookup by an equal-looking object
 * literal never hits. Hence the scan below rather than a `.get()`.)
 */

import type { ContractState } from '@midnight-ntwrk/compact-runtime';

/** The native (NIGHT) token type is 32 zero bytes. Matches Compact's `nativeToken()`. */
export const NATIVE_TOKEN_HEX = '00'.repeat(32);

/** Token-type hex -> amount, for the unshielded tokens a contract holds. */
export type UnshieldedBalances = Record<string, bigint>;

const normalise = (raw: string): string => raw.replace(/^0x/, '').toLowerCase();

/**
 * The contract's unshielded balances, keyed by token-type hex.
 *
 * Shielded and dust entries are dropped: a contract's shielded holdings are coins in the Zswap
 * state, not a ledger balance, and nothing in this game stakes anything but unshielded NIGHT.
 */
export function unshieldedBalances(state: ContractState): UnshieldedBalances {
  const out: UnshieldedBalances = {};
  for (const [token, amount] of state.balance) {
    if (token.tag !== 'unshielded') continue;
    const key = normalise(token.raw);
    out[key] = (out[key] ?? 0n) + amount;
  }
  return out;
}

/** The NIGHT entry of such a map, or zero when the contract holds none. */
export function nativeBalance(balances: UnshieldedBalances): bigint {
  for (const [token, amount] of Object.entries(balances)) {
    if (normalise(token) === NATIVE_TOKEN_HEX) return amount;
  }
  return 0n;
}

/** The NIGHT a contract holds, straight from its state. */
export function nativeBalanceOf(state: ContractState): bigint {
  return nativeBalance(unshieldedBalances(state));
}
