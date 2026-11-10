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
import { existsSync, globSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
// TWO call sites since the GA (2026-11): compact-js 3.0.0 partitions in `internal/executable.js`
// (ESM only), inside an Effect generator -- and midnight-js-protocol 5.0.0 partitions AGAIN, on its
// own, for every call its contracts package builds (`resolvePartition` in compose-options). The
// second one is the path every `createUnprovenCallTx*` takes, so patching the first alone left a
// lone `join` on a GA devnet "ran out of gas budget" in its fallible segment (2026-11-09).
const TARGETS = [
  join(ROOT, 'node_modules/@midnight-ntwrk/compact-js/dist/esm/effect/internal/executable.js'),
  ...globSync(
    join(
      ROOT,
      'node_modules/@midnight-ntwrk/midnight-js-protocol/dist/shared/compose-options-*.js',
    ),
  ),
];
// TIME ONLY since ledger 9.1.0.1 (node 2.1.101, mainnet). The node refuses a fallible transcript
// whose declared BYTES exceed what it writes or deletes -- "ran out of gas budget" on a lone `join`
// with every dimension x4, x16 or x200; SucceedEntirely with the bytes exact and the two times x4
// (devnet, 2026-11-09; the 9.1.0.1 notes: "Each segment's writes are priced separately"). So the
// bytes are left as measured and only readTime and computeTime carry the headroom. Measured slack
// on the bytes (same join, 1186 bytes written): +1 and +16 land, +64 and +200 fail -- a few per
// cent at most, so `MIDNIGHT_GAS_BYTES_PAD` (default 0) is a probe knob, not a fix. The headroom
// on time is still needed: a merged Yacht turn's three resolves ran out of budget at x1 while the
// player's parts passed (midnight-ledger #745, open). MIDNIGHT_GAS_FACTOR sets it per process.
//
// THE BYTES RULE, MEASURED 2026-11-10 (ledger 9.1.0.1, three joins, docs/bugs-found.md #37): the
// budget a fallible segment runs under is computed from its DECLARATION, with declared deletes
// refunded. Declaring MORE writes than happen only buys headroom (+200 bytes: SucceedEntirely);
// declaring more deletes than happen shrinks the budget below the real cost (+64 bytes: "ran out
// of gas budget"); declaring NO deletes forgoes the refund and always lands (0.78 DUST instead of
// 0.47 for a join). A part is built on the state its turn opened on and executes after whatever
// landed meanwhile -- another seat's cells in the same map change the bytes a write re-declares
// -- so the defaults here are: bytesWritten + 512 (the largest drift seen was ~400, a seat's
// three answer cells filling in round 0) and bytesDeleted x0. Both are environment knobs.
const DEFAULT_FACTOR = 4;

// `const partitioned = <call to partitionTranscripts(...)>;` in `partitionAllTranscripts` -- the
// esm and cjs builds differ only in how the ledger import is spelled.
// `const partitioned = yield* tryBoundary(..., () => ledger.partitionTranscripts(...));` in
// compact-js; `partitioned = ledger.partitionTranscripts([...], parameters);` in midnight-js-protocol.
const SITE = /^(\s*)((?:const )?partitioned) = (.*partitionTranscripts\(.*\));$/m;
// This script's own previous output, so re-running re-applies rather than skips.
const APPLIED_HELPERS =
  /^[^\n]*PATCHED by scripts\/patch-gas-factor\.mjs[^\n]*\n(?:[^\n]*__gas[A-Za-z]+ = [^\n]*\n)+/m;
const APPLIED_SITE = /^(\s*)((?:const )?partitioned) = \((.*)\)\.map\(\(\[g, f\][^\n]*\);$/m;

const helpers = (indent) =>
  [
    `${indent}// PATCHED by scripts/patch-gas-factor.mjs -- see docs/bugs-found.md #21 and #36.`,
    `${indent}const __gasFactor = (() => { try { return BigInt(process.env.MIDNIGHT_GAS_FACTOR ?? ${DEFAULT_FACTOR}); } catch { return ${DEFAULT_FACTOR}n; } })();`,
    `${indent}const __gasEnv = (name, dflt) => { try { return BigInt(process.env[name] ?? dflt); } catch { return BigInt(dflt); } };`,
    `${indent}const __gasWritePad = __gasEnv('MIDNIGHT_GAS_WRITE_PAD', 512);`,
    `${indent}const __gasDeletePad = __gasEnv('MIDNIGHT_GAS_DELETE_PAD', 0);`,
    `${indent}const __gasDeleteFactor = __gasEnv('MIDNIGHT_GAS_DELETE_FACTOR', 0);`,
    `${indent}const __gasInflate = (t) => t === undefined ? t : ({ ...t, gas: { readTime: t.gas.readTime * __gasFactor, computeTime: t.gas.computeTime * __gasFactor, bytesWritten: t.gas.bytesWritten + __gasWritePad, bytesDeleted: t.gas.bytesDeleted * __gasDeleteFactor + __gasDeletePad } });`,
  ].join('\n');

for (const target of TARGETS) {
  if (!existsSync(target))
    throw new Error(`gas factor: ${target} not found -- is compact-js installed?`);
  const original = readFileSync(target, 'utf8')
    .replace(APPLIED_HELPERS, '')
    .replace(APPLIED_SITE, (_line, indent, lhs, call) => `${indent}${lhs} = ${call};`);
  const match = SITE.exec(original);
  if (match === null) throw new Error(`gas factor: no partitionTranscripts call site in ${target}`);
  const [line, indent, lhs, call] = match;
  writeFileSync(
    target,
    original.replace(
      line,
      `${helpers(indent)}\n${indent}${lhs} = (${call}).map(([g, f]) => [g, __gasInflate(f)]);`,
    ),
  );
  console.log(`gas factor: patched ${target} (fallible budget x${DEFAULT_FACTOR} by default)`);
}
