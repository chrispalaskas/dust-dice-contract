// Copyright (C) Shielded Technologies
// SPDX-License-Identifier: Apache-2.0
//
// Refuse to publish a dist that cannot prove: every impure circuit the compiler lists in
// contract-info.json must have its prover and verifier key. The list comes from the compiler, so
// adding or removing a circuit cannot leave a stale count behind.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const missing = [];
for (const contract of ['table', 'lobby', 'backgammon']) {
  const dir = join('dist', 'managed', contract);
  const info = join(dir, 'compiler', 'contract-info.json');
  if (!existsSync(info)) {
    missing.push(info);
    continue;
  }
  const circuits = JSON.parse(readFileSync(info, 'utf8')).circuits.filter((c) => !c.pure);
  for (const { name } of circuits) {
    for (const ext of ['prover', 'verifier']) {
      const key = join(dir, 'keys', `${name}.${ext}`);
      if (!existsSync(key)) missing.push(key);
    }
  }
}

if (missing.length > 0) {
  console.error(
    'refusing to publish: dist/managed lacks proving keys or compiler info — run a FULL ' +
      '`npm run compact` (not compact:fast) and `npm run build` first. Missing:\n  ' +
      missing.join('\n  '),
  );
  process.exit(1);
}
