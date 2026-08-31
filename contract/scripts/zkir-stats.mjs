// Copyright (C) Shielded Technologies
// SPDX-License-Identifier: Apache-2.0
//
// Summarise the .zkir of every compiled circuit: instruction count and opcode mix.
//
// Prover key size is a poor cost proxy -- PLONK rounds the proving domain up to a power of
// two, so circuits whose real sizes differ 5x can land on the same key size. The zkir
// instruction count is the number that actually tracks proving work.
//
// Usage: node scripts/zkir-stats.mjs <build-dir> [...]
//   where each build-dir contains zkir/*.zkir

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';

const dirs = process.argv.slice(2);
if (dirs.length === 0) {
  console.error('usage: node scripts/zkir-stats.mjs <build-dir> [...]');
  process.exit(2);
}

const rows = [];
for (const dir of dirs) {
  const zkirDir = join(dir, 'zkir');
  let entries;
  try {
    entries = readdirSync(zkirDir).filter((f) => f.endsWith('.zkir'));
  } catch {
    console.error(`no zkir/ under ${dir}, skipping`);
    continue;
  }
  for (const file of entries.sort()) {
    const ir = JSON.parse(readFileSync(join(zkirDir, file), 'utf8'));
    const ops = new Map();
    for (const ins of ir.instructions) {
      ops.set(ins.op, (ops.get(ins.op) ?? 0) + 1);
    }
    const keyPath = join(dir, 'keys', `${basename(file, '.zkir')}.prover`);
    let proverBytes = 0;
    try {
      proverBytes = statSync(keyPath).size;
    } catch {
      /* --skip-zk build: no keys */
    }
    rows.push({
      contract: basename(dir),
      circuit: basename(file, '.zkir'),
      instructions: ir.instructions.length,
      inputs: ir.num_inputs,
      proverBytes,
      ops: [...ops.entries()].sort((a, b) => b[1] - a[1]),
    });
  }
}

const pad = (s, n) => String(s).padEnd(n);
const padL = (s, n) => String(s).padStart(n);

console.log(
  [
    pad('contract', 10),
    pad('circuit', 20),
    padL('instructions', 13),
    padL('inputs', 7),
    padL('prover_bytes', 13),
  ].join(' '),
);
for (const r of rows) {
  console.log(
    [
      pad(r.contract, 10),
      pad(r.circuit, 20),
      padL(r.instructions.toLocaleString('en-US'), 13),
      padL(r.inputs, 7),
      padL(r.proverBytes.toLocaleString('en-US'), 13),
    ].join(' '),
  );
}

console.log('\ntop opcodes per circuit');
for (const r of rows) {
  const top = r.ops
    .slice(0, 6)
    .map(([op, n]) => `${op}=${n.toLocaleString('en-US')}`)
    .join('  ');
  console.log(`  ${pad(`${r.contract}/${r.circuit}`, 32)} ${top}`);
}
