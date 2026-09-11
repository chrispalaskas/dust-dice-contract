import { describe, expect, it } from 'vitest';

import { Bech32Error, decodeBech32m, unshieldedAddressBytes } from './bech32.js';
// The test — not the browser-safe module — may reach for Node-only plumbing: the whole point is
// to check this decoder against the authoritative wallet-sdk one. It derives the keys itself
// rather than through `createWallet`, which contacts the node (its ledger-generation check) and
// the indexer (wallet sync) — neither has any bearing on how an address is spelled.
import { HDWallet, Roles, createKeystore } from '@midnight-ntwrk/wallet-sdk';
import { GENESIS_SEED, userAddressBytes } from './node/index.js';

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

/**
 * Derives real addresses through the wallet SDK and checks the hand-rolled decoder against the
 * SDK's own. Deriving keys is local (no chain contact), so this needs no devnet — but it does
 * need the wallet SDK's WASM, hence the generous timeout. The derivation path (account 0, role
 * NightExternal, index 0) is the one `createWallet` uses.
 */
describe('unshieldedAddressBytes agrees with the wallet SDK', () => {
  const seeds = [
    GENESIS_SEED,
    '11'.repeat(32),
    'deadbeef'.repeat(8),
    '0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0',
  ];

  it.each(seeds)(
    'seed %s',
    async (seed) => {
      const hd = HDWallet.fromSeed(Buffer.from(seed, 'hex'));
      if (hd.type !== 'seedOk') throw new Error('invalid seed');
      const derived = hd.hdWallet
        .selectAccount(0)
        .selectRoles([Roles.NightExternal])
        .deriveKeysAt(0);
      if (derived.type !== 'keysDerived') throw new Error('key derivation failed');
      const address = createKeystore(derived.keys[Roles.NightExternal], 'undeployed')
        .getBech32Address()
        .toString();

      // The authoritative answer, via wallet-sdk's MidnightBech32m/UnshieldedAddress.
      const expected = userAddressBytes(address);
      // Ours, with no wallet-sdk involved.
      const actual = unshieldedAddressBytes(address, 'undeployed');

      expect(hex(actual)).toBe(hex(expected));
      expect(actual).toBeInstanceOf(Uint8Array);
      expect(actual.length).toBe(32);
    },
    120_000,
  );
});

describe('decodeBech32m rejects what it should', () => {
  it('a corrupted character fails the checksum rather than decoding to the wrong bytes', () => {
    const good = 'mn_addr_undeployed1h3ssm5ru2t6eqy4g3she78zlxn96e36ms6pq996aduvmateh9p9sk96u7s';
    // Flip one data character. A decoder without a checksum check would happily return bytes
    // here — and a seat would be created paying out to an address nobody holds.
    const bad = good.replace('h3ssm5', 'h3ssm4');
    expect(() => decodeBech32m(bad)).toThrow(Bech32Error);
  });

  it('rejects a truncated string, a bad character, and mixed case', () => {
    expect(() => decodeBech32m('mn_addr_undeployed1h3ss')).toThrow(Bech32Error);
    expect(() => decodeBech32m('mn_addr_undeployed1bbb!!!bbbbbbbbbbb')).toThrow(Bech32Error);
    expect(() => decodeBech32m('Mn_addr_undeployed1h3ssm5ru2t6eqy4g3she78zlxn96e36ms')).toThrow(
      Bech32Error,
    );
  });

  it('rejects a string with no separator', () => {
    expect(() => decodeBech32m('nodashesorseparatorhere')).toThrow(Bech32Error);
  });

  it('rejects a non-32-byte payload as an unshielded address', () => {
    // A valid bech32m string whose payload is not 32 bytes must not be silently accepted:
    // that is how a shielded address, or some other identifier, ends up in a payout slot.
    const short = 'mn_addr_undeployed1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq';
    expect(() => unshieldedAddressBytes(short)).toThrow(Bech32Error);
  });

  it('rejects an address for a different network when one is expected', () => {
    const good = 'mn_addr_undeployed1h3ssm5ru2t6eqy4g3she78zlxn96e36ms6pq996aduvmateh9p9sk96u7s';
    expect(() => unshieldedAddressBytes(good, 'testnet')).toThrow(/not for network/);
  });
});
