/**
 * Multiply the gas budget the SDK declares for the FALLIBLE half of every contract call.
 *
 * Ported from the neighbouring project (dapp-hackathon-team-1, same version matrix), where it is
 * the workaround for inherited defect #21 — see docs/bugs-found.md, "#21 — client-side gas
 * under-declaration on multi-call transactions", and #36.
 *
 * `partitionTranscripts` bakes each call's execution budget into its transcript CLIENT-SIDE, sized
 * for that call as if it ran alone. A fast settlement merges seven calls, built against the state
 * before any other seat's settlement landed; when one lands first it changes what the next one
 * reads, and that one executes above its own measurement: `Transcript(Execution(OutOfGas))`. The
 * node checks only real cost <= declared cost, so declaring more is safe — the transaction pays a
 * larger fee for headroom it may not use.
 *
 * #36 IS THE REASON THIS FILE EXISTS HERE. Its fix had two halves: `resolveBallast` in
 * table.compact weighs the operator's resolve into the fallible phase — the only phase whose
 * budget can be raised — and THIS raises it. The first half shipped without the second, so the
 * resolves moved to where they could be topped up and nothing topped them up. The failure then
 * changed shape rather than going away: no longer a mempool rejection but an included transaction
 * whose fallible part fails ("Non guaranteed part of the transaction failed ... OutOfGas" in the
 * node log), which paid its fee and changed nothing. Found on the devnet 2026-09-23.
 *
 * ONLY THE FALLIBLE TRANSCRIPT IS INFLATED. The guaranteed one is budgeted against transaction
 * size at admission, and inflating it is refused (`Malformed(FeeCalculation(OutsideTimeToDismiss))`).
 * After #36 no call in a fast settlement carries a guaranteed transcript at all.
 *
 * `MIDNIGHT_GAS_FACTOR` is read at transaction-build time by server-side processes (the operator
 * builds the resolves); a browser bundle has no such variable and gets the default below, compiled
 * in from the patched package — so the UI must be rebuilt after this runs.
 *
 * Patches node_modules, so it would die on the next install — the root `postinstall` re-applies
 * it. Idempotent: any previous patch is reverted first, so the factor can be re-tuned. A call site
 * that no longer matches throws, which fails the install loudly rather than silently shipping an
 * unpatched SDK. Delete this script and its hook once the SDK budgets multi-call transactions.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TARGETS = ['esm', 'cjs'].map((flavour) =>
  join(
    ROOT,
    `node_modules/@midnight-ntwrk/compact-js/dist/${flavour}/effect/ContractExecutable.js`,
  ),
);
const DEFAULT_FACTOR = 4;

// `const partitioned = <call to partitionTranscripts(...)>;` in `partitionAllTranscripts` -- the
// esm and cjs builds differ only in how the ledger import is spelled.
const SITE = /^(\s*)const partitioned = (.*partitionTranscripts\)?\(.*\));$/m;
// This script's own previous output, so re-running re-applies rather than skips.
const APPLIED_HELPERS =
  /^[^\n]*PATCHED by scripts\/patch-gas-factor\.mjs[^\n]*\n[^\n]*__gasFactor = [^\n]*\n[^\n]*__gasInflate = [^\n]*\n/m;
const APPLIED_SITE = /^(\s*)const partitioned = \((.*)\)\.map\(\(\[g, f\][^\n]*\);$/m;

const helpers = (indent) =>
  [
    `${indent}// PATCHED by scripts/patch-gas-factor.mjs -- see docs/bugs-found.md #21 and #36.`,
    `${indent}const __gasFactor = (() => { try { return BigInt(process.env.MIDNIGHT_GAS_FACTOR ?? ${DEFAULT_FACTOR}); } catch { return ${DEFAULT_FACTOR}n; } })();`,
    `${indent}const __gasInflate = (t) => t === undefined ? t : ({ ...t, gas: { readTime: t.gas.readTime * __gasFactor, computeTime: t.gas.computeTime * __gasFactor, bytesWritten: t.gas.bytesWritten * __gasFactor, bytesDeleted: t.gas.bytesDeleted * __gasFactor } });`,
  ].join('\n');

for (const target of TARGETS) {
  if (!existsSync(target))
    throw new Error(`gas factor: ${target} not found -- is compact-js installed?`);
  const original = readFileSync(target, 'utf8')
    .replace(APPLIED_HELPERS, '')
    .replace(APPLIED_SITE, (_line, indent, call) => `${indent}const partitioned = ${call};`);
  const match = SITE.exec(original);
  if (match === null) throw new Error(`gas factor: no partitionTranscripts call site in ${target}`);
  const [line, indent, call] = match;
  writeFileSync(
    target,
    original.replace(
      line,
      `${helpers(indent)}\n${indent}const partitioned = (${call}).map(([g, f]) => [g, __gasInflate(f)]);`,
    ),
  );
  console.log(`gas factor: patched ${target} (fallible budget x${DEFAULT_FACTOR} by default)`);
}
