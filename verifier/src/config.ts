// Copyright (C) Shielded Technologies
// SPDX-License-Identifier: Apache-2.0
/**
 * The verifier's configuration: which network to read, and where the compiled contract lives.
 * Nothing here is a secret or a game parameter — the verifier only READS the chain.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { resolveNetwork, type NetworkConfig } from '@dust-dice/api/node';

const require = createRequire(import.meta.url);

/** UNDEPLOYED (the local devnet) unless the MIDNIGHT_* environment variables say otherwise. */
export const NETWORK: NetworkConfig = resolveNetwork();

const CONTRACT_ROOT = path.dirname(require.resolve('@dust-dice/contract/package.json'));
/**
 * Where `@dust-dice/contract` keeps compactc's output for the two deployables. The PUBLISHED
 * package ships them under `dist/managed` (keys and ZKIR for table and lobby only); a source
 * checkout that has compiled but not built has them under `src/managed`. Prefer the built copy,
 * which is what a consumer installs, and fall back to the source tree for development.
 */
const managedRoot = ((): string => {
  const built = path.join(CONTRACT_ROOT, 'dist', 'managed');
  return fs.existsSync(path.join(built, 'table', 'keys'))
    ? built
    : path.join(CONTRACT_ROOT, 'src', 'managed');
})();
export const MANAGED_TABLE = path.join(managedRoot, 'table');
export const MANAGED_LOBBY = path.join(managedRoot, 'lobby');
