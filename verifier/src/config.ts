// Copyright (C) Shielded Technologies
// SPDX-License-Identifier: Apache-2.0
/**
 * The verifier's configuration: which network to read, and where the compiled contract lives.
 * Nothing here is a secret or a game parameter — the verifier only READS the chain.
 */
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { resolveNetwork, type NetworkConfig } from '@dust-dice/api/node';

const require = createRequire(import.meta.url);

/** UNDEPLOYED (the local devnet) unless the MIDNIGHT_* environment variables say otherwise. */
export const NETWORK: NetworkConfig = resolveNetwork();

const CONTRACT_ROOT = path.dirname(require.resolve('@dust-dice/contract/package.json'));
/** compactc output for the two deployable contracts (`npm run compact -w contract`). */
export const MANAGED_TABLE = path.join(CONTRACT_ROOT, 'src', 'managed', 'table');
export const MANAGED_LOBBY = path.join(CONTRACT_ROOT, 'src', 'managed', 'lobby');
