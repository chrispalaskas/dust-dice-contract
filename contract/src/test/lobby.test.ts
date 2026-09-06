// Copyright (C) Shielded Technologies
// SPDX-License-Identifier: Apache-2.0

/**
 * lobby.compact.
 *
 * The lobby is a registry with no funds, no cross-contract calls and no authority over any
 * table, so there is not much to prove -- but what there is matters, because a UI that cannot
 * find a table is indistinguishable from a table that does not exist. The tests below pin the
 * one invariant it enforces (a tier's open slot cannot be overwritten while it is occupied),
 * the operator check, and the per-tier independence of the four slots.
 *
 * What is deliberately NOT tested here, because it is not true: that the lobby says anything
 * trustworthy about a table. It records what the operator tells it. A client must read a
 * table's tier, seed commitment and timeouts off the TABLE before staking -- see the trust
 * note at the top of lobby.compact.
 *
 * Run: npm test -w @dust-dice/contract
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { pureCircuits as lobbyPure } from '../managed/lobby/contract/index.js';
import { contractAddress, LobbySimulator } from './simulator.ts';
import { bytes32 } from './table-harness.ts';

/** Tiers the lobby indexes. `tierCount()` in lobby.compact. */
const TIER_COUNT = 4;

const OPERATOR = bytes32(0x5a);
const IMPOSTOR = bytes32(0x5b);

async function freshLobby(): Promise<LobbySimulator> {
  return LobbySimulator.create(OPERATOR, lobbyPure.operatorCommitmentOf(OPERATOR));
}

describe('lobby', () => {
  it('starts with every tier empty and every slot readable', async () => {
    const lobby = await freshLobby();
    const led = lobby.getLedger();

    assert.deepEqual(led.operatorCommitment, lobbyPure.operatorCommitmentOf(OPERATOR));
    // All four slots pre-inserted: a ledger Map lookup of an absent key aborts, so every read
    // below must be total without a `member` guard.
    assert.equal(led.hasOpen.size(), BigInt(TIER_COUNT));
    assert.equal(led.openTable.size(), BigInt(TIER_COUNT));
    assert.equal(led.lastClosed.size(), BigInt(TIER_COUNT));

    for (let tier = 0; tier < TIER_COUNT; tier++) {
      assert.equal(led.hasOpen.lookup(BigInt(tier)), false);
      assert.deepEqual(led.openTable.lookup(BigInt(tier)).bytes, new Uint8Array(32));
      assert.equal(led.openedCount.lookup(BigInt(tier)), 0n);
      assert.equal(led.closedCount.lookup(BigInt(tier)), 0n);
    }
  });

  it('announces a table and retires it, keeping a one-entry history', async () => {
    const lobby = await freshLobby();
    const first = contractAddress(0xa1);
    const second = contractAddress(0xa2);

    await lobby.openTableAt(2, first);
    let led = lobby.getLedger();
    assert.equal(led.hasOpen.lookup(2n), true);
    assert.deepEqual(led.openTable.lookup(2n).bytes, first.bytes);
    assert.equal(led.openedCount.lookup(2n), 1n);
    assert.equal(led.closedCount.lookup(2n), 0n);

    await lobby.tableFilled(2);
    led = lobby.getLedger();
    assert.equal(led.hasOpen.lookup(2n), false);
    assert.deepEqual(
      led.lastClosed.lookup(2n).bytes,
      first.bytes,
      'the retired table is still findable, which is what makes a settled game reviewable',
    );
    assert.deepEqual(
      led.openTable.lookup(2n).bytes,
      new Uint8Array(32),
      'the open slot is cleared, not left pointing at a full table',
    );
    assert.equal(led.closedCount.lookup(2n), 1n);

    // The cycle repeats, and `openedCount - closedCount` is the "is one open" bit either way.
    await lobby.openTableAt(2, second);
    led = lobby.getLedger();
    assert.deepEqual(led.openTable.lookup(2n).bytes, second.bytes);
    assert.deepEqual(led.lastClosed.lookup(2n).bytes, first.bytes);
    assert.equal(led.openedCount.lookup(2n), 2n);
    assert.equal(led.closedCount.lookup(2n), 1n);
    assert.equal(led.openedCount.lookup(2n) - led.closedCount.lookup(2n), 1n);
  });

  it('refuses to orphan a table that is already open', async () => {
    // The one invariant the lobby enforces. Overwriting would leave players sitting at a table
    // the UI can no longer find -- the table itself keeps working and its timeout paths still
    // protect the stakes, but nobody can reach it to play or to settle.
    const lobby = await freshLobby();
    await lobby.openTableAt(0, contractAddress(0xb1));
    await assert.rejects(
      () => lobby.openTableAt(0, contractAddress(0xb2)),
      /this tier already has an open table/,
    );
    assert.deepEqual(lobby.getLedger().openTable.lookup(0n).bytes, contractAddress(0xb1).bytes);
  });

  it('refuses to retire a tier that has nothing open', async () => {
    const lobby = await freshLobby();
    await assert.rejects(() => lobby.tableFilled(1), /this tier has no open table/);
    await lobby.openTableAt(1, contractAddress(0xc1));
    await lobby.tableFilled(1);
    await assert.rejects(() => lobby.tableFilled(1), /this tier has no open table/);
  });

  it('refuses an unknown tier', async () => {
    const lobby = await freshLobby();
    for (const tier of [TIER_COUNT, TIER_COUNT + 1, 255]) {
      await assert.rejects(() => lobby.openTableAt(tier, contractAddress(0xd1)), /unknown tier/);
      await assert.rejects(() => lobby.tableFilled(tier), /unknown tier/);
    }
  });

  it('refuses anyone who cannot open the operator commitment', async () => {
    const lobby = await freshLobby();
    lobby.asOperator(IMPOSTOR);
    await assert.rejects(() => lobby.openTableAt(0, contractAddress(0xe1)), /not the operator/);
    await assert.rejects(() => lobby.tableFilled(0), /not the operator/);

    // And the real operator still works, so the rejection was about the key.
    lobby.asOperator(OPERATOR);
    await lobby.openTableAt(0, contractAddress(0xe2));
    assert.equal(lobby.getLedger().hasOpen.lookup(0n), true);
  });

  it('keeps the four tiers independent', async () => {
    const lobby = await freshLobby();
    const addrs = [0xf0, 0xf1, 0xf2, 0xf3].map((b) => contractAddress(b));
    for (let tier = 0; tier < TIER_COUNT; tier++) {
      await lobby.openTableAt(tier, addrs[tier]!);
    }
    // Retire only tier 1; the others must be untouched.
    await lobby.tableFilled(1);

    const led = lobby.getLedger();
    for (let tier = 0; tier < TIER_COUNT; tier++) {
      const open = tier !== 1;
      assert.equal(led.hasOpen.lookup(BigInt(tier)), open, `tier ${tier}`);
      assert.equal(led.openedCount.lookup(BigInt(tier)), 1n);
      assert.equal(led.closedCount.lookup(BigInt(tier)), tier === 1 ? 1n : 0n);
      if (open) {
        assert.deepEqual(led.openTable.lookup(BigInt(tier)).bytes, addrs[tier]!.bytes);
      }
    }
  });
});
