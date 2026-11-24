#!/usr/bin/env node
// Copyright (C) Shielded Technologies
// SPDX-License-Identifier: Apache-2.0

/**
 * The settlement verifier's command line: replay a whole game from the chain and nothing else.
 *
 *   npm run verify -w cli -- <table-address> [--verbose]
 *
 * It reads the table's public record off an indexer (record.ts `indexerRecord`) and hands it to
 * the game's checks: yacht.ts for a Yacht table, backgammon.ts for a Backgammon one. What is
 * checked, and what cannot be, is documented there.
 */

import { Checks } from './checks.ts';
import { verifyBackgammon } from './backgammon.ts';
import { gameOf } from './contracts.ts';
import { indexerBackgammonRecord, indexerRecord } from './node-reader.ts';
import { exitCode } from './report.ts';
import { verifyYacht } from './yacht.ts';

const address = process.argv[2];
if (!address) {
  console.error(
    'usage: npm run verify -w cli -- <table-address> [--verbose]\n\n' +
      'Replays a settled Dust Dice table from the chain alone: every roll re-derived under the\n' +
      'hold masks the players sent, every score recomputed, the winner and the payout\n' +
      're-confirmed. A Backgammon table is recognised by its entry points and replayed ply by\n' +
      'ply instead.',
  );
  process.exit(2);
}

// One bin for both games: the contract's own entry points say which it is. The checks are the
// ones the /verify page runs; this prints them.
const checks = new Checks(process.argv.includes('--verbose'));
console.log(`Verifying ${address}`);
const verdict =
  (await gameOf(address)) === 'backgammon'
    ? await verifyBackgammon(indexerBackgammonRecord(address), checks)
    : await verifyYacht(indexerRecord(address), checks);
checks.summary();
if (verdict !== 'verified' && verdict !== 'failed') console.log(`verdict: ${verdict}`);
process.exit(exitCode(verdict));
