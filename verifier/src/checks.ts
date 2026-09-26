// Copyright (C) Shielded Technologies
// SPDX-License-Identifier: Apache-2.0

/**
 * What both game verifiers share: the pass/fail ledger they report through, and the match from a
 * contract's raw payout key to the bech32m owner the indexer reports.
 */

import { userAddressBytes } from '@dust-dice/api/node';

const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex');

export class Checks {
  private failures: string[] = [];
  private passes = 0;
  private readonly verbose: boolean;

  constructor(verbose: boolean) {
    this.verbose = verbose;
  }

  ok(what: string, condition: boolean, detail = ''): void {
    if (condition) {
      this.passes += 1;
      if (this.verbose) console.log(`  PASS ${what}`);
    } else {
      this.failures.push(`${what}${detail ? ` -- ${detail}` : ''}`);
      console.log(`  FAIL ${what}${detail ? ` -- ${detail}` : ''}`);
    }
  }

  get failed(): string[] {
    return this.failures;
  }

  get count(): number {
    return this.passes + this.failures.length;
  }

  summary(): void {
    console.log(
      `\n${this.failures.length === 0 ? 'VERIFIED' : 'VERIFICATION FAILED'}: ` +
        `${this.passes} checks passed, ${this.failures.length} failed`,
    );
    for (const f of this.failures) console.log(`  - ${f}`);
  }
}

/**
 * Match a raw 32-byte payout key against the bech32m owner strings the indexer reports.
 *
 * The contract stores the raw key (a circuit argument cannot be a bech32m string); the indexer
 * reports the encoded address. Rather than re-implement the encoding here, the raw key is
 * matched against whichever created output's owner decodes to it -- and the decoding is the
 * wallet SDK's, via `@dust-dice/api/node`'s `userAddressBytes`, which is pure key math and needs
 * no wallet.
 */
export function addressOf(
  tx: { unshieldedCreatedOutputs: { owner: string }[] },
  raw: Uint8Array,
): string {
  const target = hex(raw);
  for (const u of tx.unshieldedCreatedOutputs) {
    try {
      if (hex(userAddressBytes(u.owner)) === target) return u.owner;
    } catch {
      /* not an address this build can decode; skip */
    }
  }
  return '<no created output belongs to this address>';
}
