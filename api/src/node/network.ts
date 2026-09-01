/**
 * Network endpoints for Node-side consumers (cli, service). Browser code gets its
 * endpoints from the dapp connector instead — nothing here may leak into './index.js'.
 */

export interface NetworkConfig {
  /** Protocol network id passed to setNetworkId(); must match what the chain calls itself. */
  networkId: string;
  indexer: string;
  indexerWS: string;
  node: string;
  proofServer: string;
}

/**
 * The local ledger-9 devnet from this repo's docker-compose.yml, on the standard host ports.
 *
 * These are exactly the endpoints the Moth wallet's built-in `undeployed` preset expects,
 * which is what lets a browser wallet reach this stack with no custom network configuration.
 * Moving them is not free: Moth's ledger-version probe reads its *static* preset and caches
 * the answer keyed on network id, so a relocated stack gets keys derived under the wrong
 * ledger generation and fails at the WASM boundary rather than saying "wrong port".
 */
export const UNDEPLOYED: NetworkConfig = {
  networkId: 'undeployed',
  indexer: 'http://127.0.0.1:8088/api/v4/graphql',
  indexerWS: 'ws://127.0.0.1:8088/api/v4/graphql/ws',
  node: 'ws://127.0.0.1:9944',
  proofServer: 'http://127.0.0.1:6300',
};

/**
 * Local-dev-only: the devnet genesis funds this seed from block 0 (see README's
 * "Local-dev secrets"). Worthless anywhere else by design.
 */
export const GENESIS_SEED = '0000000000000000000000000000000000000000000000000000000000000001';

export const TX_TTL_MS = 30 * 60 * 1000;

/** UNDEPLOYED with MIDNIGHT_* env overrides applied — same variable names as upstream. */
export function resolveNetwork(env: NodeJS.ProcessEnv = process.env): NetworkConfig {
  return {
    networkId: env.MIDNIGHT_NETWORK_ID ?? UNDEPLOYED.networkId,
    indexer: env.MIDNIGHT_INDEXER_URL ?? UNDEPLOYED.indexer,
    indexerWS: env.MIDNIGHT_INDEXER_WS_URL ?? UNDEPLOYED.indexerWS,
    node: env.MIDNIGHT_NODE_URL ?? UNDEPLOYED.node,
    proofServer: env.MIDNIGHT_PROOF_SERVER_URL ?? UNDEPLOYED.proofServer,
  };
}
