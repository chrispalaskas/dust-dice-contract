// Copyright (C) Shielded Technologies
// SPDX-License-Identifier: Apache-2.0

/**
 * THE CUSTODY ASSERTION CATCHES A SLIP IN THE MONEY ARITHMETIC (popper re-review C011).
 *
 * `table.compact` claims its in-circuit custody check -- `assertCustodyAfterSending`, run AFTER
 * the writes in `abortTable` and `settle` -- catches "an arithmetic slip inside the contract at
 * the moment money moves". No ordinary test can try that: the real contract has no slip. So this
 * one makes the slips. Each MUTANT below is the real source with one amount off by a single atom,
 * compiled without keys (`--skip-zk`, about a second) into a temporary directory and driven
 * through the same harness as every other test. The claim survives only if every mutant is
 * refused with the custody message, and the unmutated control passes the same scenarios -- so a
 * refusal is the mutant's doing, not the pipeline's.
 *
 * A mutant whose pattern no longer matches the source fails loudly rather than silently testing
 * nothing: rewrite it against the new code.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  cpSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import type { TableModule } from './simulator.ts';
import { GameDriver, PHASE, alwaysStopEarly, perSeatRake } from './table-harness.ts';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');
/** The repo's packages: a mutant's generated JS imports `@midnight-ntwrk/compact-runtime`. */
const NODE_MODULES = join(SRC, '..', '..', 'node_modules');
const CUSTODY = /custody invariant broken/;

type Mutant = { name: string; find: string; replace: string };

const MUTANTS: Mutant[] = [
  {
    // An operator-stalled (or abandoned) abort credits a seat one atom more than its share.
    name: 'abortTable: a seat is credited its share + 1',
    find: 'seatRedeemable.insert(0, lost0 ? 0 : share);',
    replace: 'seatRedeemable.insert(0, lost0 ? 0 : (share + 1) as Uint<64>);',
  },
  {
    // The start puts one atom more into the pot than the seats staked.
    name: 'abortTable (the start): the pot is tier * n + 1',
    find: 'pot = (tier * (n as Uint<64>)) as Uint<64>;',
    replace: 'pot = (tier * (n as Uint<64>) + 1) as Uint<64>;',
  },
  {
    // The all-eliminated waiver refunds each seat one atom more than tier - rake.
    name: 'abortTable (the waiver): the share is tier - rake + 1',
    find: 'const share = raking ? (tier - rake) as Uint<64> : tier;',
    replace: 'const share = raking ? (tier - rake + 1) as Uint<64> : tier;',
  },
  {
    // settle sends the rake one atom more than the split says.
    name: 'settle: the rake is paid q + 1',
    find: 'const toRake = (practice ? forfeited : split[1]) as Uint<64>;',
    replace: 'const toRake = (practice ? forfeited : split[1] + 1) as Uint<64>;',
  },
];

/** The scenario each mutant's slip lies on. Every one must PASS on the unmutated control. */
const SCENARIOS: Record<string, (mod: TableModule) => Promise<void>> = {
  'abortTable: a seat is credited its share + 1': async (mod) => {
    // The operator stops after seat 1's open; past its grace, the abort shares out the pot.
    const g = await GameDriver.open({ seats: 2, contract: mod });
    await g.joinAll();
    await g.playTurn(1, 0, alwaysStopEarly);
    g.sim.asPlayer(g.players[0]!.sk);
    await g.sim.openTurn(0, g.entropyFor(0, 0), g.tick());
    const { q, rem } = perSeatRake(g.config.tier);
    const past = Number(g.ledger().roundDeadline + g.config.tableTimeoutSecs) + 1;
    await g.sim.abortTable(q, rem, past);
    assert.equal(g.ledger().phase, PHASE.aborted);
  },
  'abortTable (the start): the pot is tier * n + 1': async (mod) => {
    const g = await GameDriver.open({ seats: 2, contract: mod });
    await g.joinAll(); // the second join fills the table and the harness sends the start
    assert.equal(g.ledger().phase, PHASE.playing);
  },
  'abortTable (the waiver): the share is tier - rake + 1': async (mod) => {
    const g = await GameDriver.open(
      { seats: 2, contract: mod },
      { strategy: 'bestScore', holds: alwaysStopEarly },
    );
    await g.joinAll();
    await g.playRound(0);
    await g.eliminate(0, 1);
    await g.eliminate(1, 1);
    assert.equal(g.ledger().phase, PHASE.abandoned);
    const { q, rem } = perSeatRake(g.config.tier);
    await g.sim.abortTable(q, rem, g.clock);
    assert.equal(g.ledger().pot, 0n);
  },
  'settle: the rake is paid q + 1': async (mod) => {
    const g = await GameDriver.open(
      { seats: 2, contract: mod },
      { strategy: 'bestScore', holds: alwaysStopEarly },
    );
    await g.joinAll();
    await g.playToEnd();
    const [q, r] = g.rakeSplit();
    await g.sim.settle(g.config.vrfSecret, q, r);
    assert.equal(g.ledger().pot, 0n);
  },
};

let work = '';

/** Compile `table.compact` (as edited) without keys and load the result. */
async function build(name: string, edit: (src: string) => string): Promise<TableModule> {
  const dir = join(work, name.replace(/[^a-z0-9]+/gi, '-'));
  cpSync(join(work, 'src'), dir, { recursive: true });
  const file = join(dir, 'table.compact');
  writeFileSync(file, edit(readFileSync(file, 'utf8')));
  execFileSync(
    'compact',
    ['compile', '+0.36.0', '--skip-zk', file, join(dir, 'managed', 'table')],
    { env: { ...process.env, COMPACT_PATH: dir }, stdio: 'pipe' },
  );
  const mod = (await import(
    pathToFileURL(join(dir, 'managed', 'table', 'contract', 'index.js')).href
  )) as TableModule;
  return { Contract: mod.Contract, ledger: mod.ledger };
}

describe('the custody assertion catches a one-atom slip in the money arithmetic (C011)', () => {
  before(() => {
    work = mkdtempSync(join(tmpdir(), 'dust-dice-mutants-'));
    cpSync(SRC, join(work, 'src'), {
      recursive: true,
      // The Compact sources only: not the compiled output, the tests, or the TypeScript.
      filter: (p) =>
        !p.includes('/managed') && !p.includes('/test') && (p === SRC || !/\.ts$/.test(p)),
    });
    assert.ok(readdirSync(join(work, 'src')).includes('table.compact'));
    // Resolved through the symlink to the real path, so a mutant shares the simulator's runtime.
    symlinkSync(NODE_MODULES, join(work, 'node_modules'), 'dir');
  });
  after(() => {
    if (work) rmSync(work, { recursive: true, force: true });
  });

  it('control: the unmutated source, built the same way, passes every scenario', async () => {
    const mod = await build('control', (s) => s);
    for (const [name, run] of Object.entries(SCENARIOS)) {
      await assert.doesNotReject(() => run(mod), `control failed "${name}"`);
    }
  });

  for (const m of MUTANTS) {
    it(`mutant refused: ${m.name}`, async () => {
      const mod = await build(m.name, (s) => {
        const hits = s.split(m.find).length - 1;
        assert.equal(
          hits,
          1,
          `mutant "${m.name}": its pattern matches ${hits} times in table.compact`,
        );
        return s.replace(m.find, m.replace);
      });
      await assert.rejects(() => SCENARIOS[m.name]!(mod), CUSTODY);
    });
  }
});
