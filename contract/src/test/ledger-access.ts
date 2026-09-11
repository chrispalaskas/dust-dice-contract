// Copyright (C) Shielded Technologies
// SPDX-License-Identifier: Apache-2.0

/**
 * Which ledger fields does a compiled circuit READ, and which does it WRITE?
 *
 * -------------------------------------------------------------------------------------------
 * WHY THIS EXISTS
 * -------------------------------------------------------------------------------------------
 *
 * Conflict-freedom is a hard requirement of the simultaneous-rounds design, and it is a property
 * of the compiled TRANSCRIPT rather than of anything a simulator can observe. From
 * docs/concurrency-probe.md, measured over 96 real transactions:
 *
 *   * A Compact circuit's ledger interaction compiles to a transcript of Impact VM operations
 *     which the node re-executes against live state at inclusion time.
 *   * `popeq` is the operation that BINDS: it pops the value at a path and asserts it equals
 *     what the proof committed to. If another transaction moved that value first, the node
 *     rejects with `Transcript(Execution(ReadMismatch))`.
 *   * `ins` without a preceding `popeq` on the same path is a BLIND WRITE. It binds to nothing
 *     and always applies -- even against a key another transaction is writing at the same
 *     instant, which lands last-write-wins with no error at all.
 *
 * So "does `takeTurn` conflict with another seat's `takeTurn`" is answerable exactly and
 * offline: list the fields it reads and check that every one of them is either sealed, frozen
 * for the duration of a round, or that seat's own. That is what `describe('conflict-freedom')`
 * in table.test.ts does with this module, and it is a far stronger statement than any number of
 * simulator calls -- the simulator executes one circuit at a time and can never see a conflict.
 *
 * -------------------------------------------------------------------------------------------
 * HOW
 * -------------------------------------------------------------------------------------------
 *
 * By reading the generated `src/managed/table/contract/index.js` as text. That is unusual for a
 * test and it is the point: the generated artifact is the thing the node will execute, so
 * asserting against it asserts against reality rather than against a restatement of the source.
 *
 * Both reads and writes are emitted as `__compactRuntime.queryLedgerState(context,
 * partialProofData, [ ...ops ])`. Within one such group:
 *
 *   * the FIRST `idx` op carries the two-level path of the ledger field, `[bucket, index]`;
 *   * a `popeq` op anywhere in the group makes it a read;
 *   * an `ins` op anywhere in the group makes it a write.
 *
 * The `[bucket, index]` to name mapping is not hard-coded -- it is parsed out of the generated
 * `ledger()` accessor in the same file, so adding or reordering a ledger field cannot silently
 * desynchronise this module from the contract.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const GENERATED = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'managed',
  'table',
  'contract',
  'index.js',
);

const source = fs.readFileSync(GENERATED, 'utf8').replace(/\s+/g, ' ');

/** `[bucket, index]` as it appears in an `idx` path, joined for use as a map key. */
type PathKey = string;

/**
 * Ledger field names by `[bucket, index]`, parsed from the generated `ledger()` accessor.
 *
 * Every accessor begins with a `dup` and an `idx` whose path is the field's two-level address,
 * so the first such path after each `get <name>()` is that field's address.
 */
function fieldNames(): Map<PathKey, string> {
  const start = source.indexOf('function ledger(');
  if (start < 0) throw new Error('generated ledger() accessor not found');
  const body = source.slice(start);
  // Descriptor NUMBERS are not stable: they are assigned in order of first use, so removing or
  // adding a circuit renumbers them all. An earlier version of this file matched
  // `_descriptor_3` specifically and broke the moment two circuits were merged. Match any
  // descriptor and rely on the structure instead.
  const re =
    /get (\w+)\(\)[^]*?path: \[ \{ tag: 'value', value: \{ value: _descriptor_\d+\.toValue\((\d+)n\), alignment: _descriptor_\d+\.alignment\(\) \} \}, \{ tag: 'value', value: \{ value: _descriptor_\d+\.toValue\((\d+)n\)/g;
  const out = new Map<PathKey, string>();
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    const name = m[1]!;
    if (seen.has(name)) continue;
    seen.add(name);
    out.set(`${m[2]},${m[3]}`, name);
  }
  return out;
}

const FIELDS = fieldNames();

/**
 * Ledger fields whose accessor the generated `ledger()` does not expose, recovered by
 * arithmetic on the ones it does.
 *
 * A `Map`, `Set` or `Counter` field is exposed as an object of methods rather than as a plain
 * getter, so the regex above never sees its address. The addresses are still allocated in
 * declaration order, though, so the gap between the last plain field before them and
 * `padStore` after them is exactly the ADT fields in order. Stated explicitly rather than
 * inferred, so a reordering of the declarations shows up as a failed assertion in
 * `assertFieldMapIsComplete` rather than as a silently mislabelled read.
 */
const ADT_FIELDS: ReadonlyArray<readonly [PathKey, string]> = [
  ['2,2', 'seatIdentity'],
  ['2,3', 'seatCard'],
  ['2,4', 'seatProgress'],
  ['2,5', 'seatTurn'],
  ['2,6', 'seatRedeemable'],
  ['2,7', 'seatReceipt'],
  ['2,8', 'joinedKeys'],
  // Declared after `padStore` (2,9) with the other late fields, between `started` and
  // `fillOpenedAt`.
  ['2,12', 'seatPaid'],
];
for (const [key, name] of ADT_FIELDS) FIELDS.set(key, name);

/**
 * The parse is only trustworthy if the addresses it did recover are where they are expected.
 *
 * Two anchors bracket the ADT block: `finalDigest` immediately before it and `padStore`
 * immediately after. If either moves, the hard-coded ADT addresses above are wrong and every
 * conclusion drawn from this module is wrong with them.
 */
export function assertFieldMapIsComplete(): void {
  const expect = (key: PathKey, name: string): void => {
    if (FIELDS.get(key) !== name) {
      throw new Error(
        `ledger layout changed: expected ${name} at ${key}, found ${FIELDS.get(key) ?? 'nothing'}` +
          ` -- update ADT_FIELDS in src/test/ledger-access.ts`,
      );
    }
  };
  // The four fields added for early start / leave-while-filling were APPENDED after `padStore`,
  // but the compiler rebalances the two buckets by total count, so bucket 1 now begins at
  // `revealedSeed` and the ADT block sits at 1,3..1,9. Re-derived from the generated accessor
  // on 2026-09-03; a future change to the declarations must come back through here.
  // With `inviteHash` the compiler split the fields over THREE buckets: `tableId` alone at
  // 0,0, the rest of the plain fields in bucket 1, and bucket 2 holding winnerSeatIndex,
  // finalDigest, the ADT block (2,2..2,8), padStore and the late fields. Re-derived from the
  // generated accessor on 2026-09-04.
  expect('1,7', 'phase');
  expect('2,1', 'finalDigest');
  expect('2,9', 'padStore');
  expect('2,10', 'startAfterSecs');
  expect('2,13', 'fillOpenedAt');
  expect('2,14', 'inviteHash');
}

/**
 * The body of one generated circuit implementation, whitespace-collapsed, or `undefined` if
 * there is none.
 *
 * A WITNESS is called with the same `this._name_0(context, partialProofData, ...)` shape as a
 * helper circuit but is dispatched to the caller-supplied witness object rather than compiled
 * into a method, so it has no body here. It also has no ledger access, which is why skipping it
 * is sound rather than merely convenient.
 */
function bodyOf(circuit: string): string | undefined {
  // Ledger 8 generates SYNCHRONOUS circuits, so there is no `async` keyword to anchor on — and
  // that keyword was what separated a method DEFINITION from a `this._name_0(` call site. The
  // lookbehind does that job now: without it the first hit is usually a call, and the body
  // sliced from there is an unrelated fragment that silently reports the wrong ledger access.
  const defRe = (name: string): RegExp => new RegExp(`(?<![.\\w])_${name}_0\\(`, 'g');
  const first = defRe(circuit).exec(source);
  if (first === null) return undefined;
  const start = first.index;
  // Every generated implementation is a top-level method of the same class, so the next
  // definition (or the end of the class) bounds this one.
  const nextRe = defRe('\\w+');
  nextRe.lastIndex = start + 1;
  const next = nextRe.exec(source);
  return source.slice(start, next ? next.index : source.length);
}

/** As `bodyOf`, but for a circuit the caller named and therefore expects to exist. */
function circuitBody(circuit: string): string {
  const body = bodyOf(circuit);
  if (body === undefined) throw new Error(`generated circuit _${circuit}_0 not found`);
  return body;
}

const OPEN = '__compactRuntime.queryLedgerState(context, partialProofData, [';

/**
 * Every circuit reachable from `circuit`, including itself.
 *
 * The compiler emits each non-`pure` helper as its own `_name_0` method and calls it as
 * `this._name_0(context, partialProofData, ...)`, so a helper's ledger access does NOT appear
 * in its caller's body. Missing that is not a cosmetic gap: `abortTable`'s entire six-seat read
 * set lives in `pendingAt` and `totalRedeemable`, and an earlier version of this file reported
 * `abortTable` as touching neither.
 *
 * Compact has no recursion, so the closure terminates; the `seen` set is belt and braces.
 */
function reachable(circuit: string): string[] {
  const seen = new Set<string>();
  const queue = [circuit];
  while (queue.length > 0) {
    const name = queue.pop()!;
    if (seen.has(name)) continue;
    const body = name === circuit ? circuitBody(name) : bodyOf(name);
    if (body === undefined) continue; // a witness: no body, no ledger access
    seen.add(name);
    for (const m of body.matchAll(/this\._(\w+)_0\(context, partialProofData/g)) {
      if (!seen.has(m[1]!)) queue.push(m[1]!);
    }
  }
  return [...seen];
}

/** Every `queryLedgerState` op-array in a circuit body, as raw text. */
function groupsIn(body: string): string[] {
  const groups: string[] = [];
  let from = 0;
  for (;;) {
    const at = body.indexOf(OPEN, from);
    if (at < 0) break;
    // Walk to the bracket that closes the op array. The ops nest `[` for paths and struct
    // values, so a depth counter is needed rather than an `indexOf(']')`.
    let depth = 0;
    let i = at + OPEN.length - 1;
    for (; i < body.length; i++) {
      if (body[i] === '[') depth += 1;
      else if (body[i] === ']') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    groups.push(body.slice(at, i + 1));
    from = i + 1;
  }
  return groups;
}

/** Every ledger op group a circuit performs, its helper circuits included. */
function ledgerGroups(circuit: string): string[] {
  return reachable(circuit).flatMap((name) => groupsIn(circuitBody(name)));
}

/**
 * The `[bucket, index]` a group addresses.
 *
 * The compiler emits the two components in one of two shapes and both have to be handled:
 * either both sit in the `idx` op's own `path` array (`path: [1, 9]`, which is what a map access
 * looks like, with the map KEY pushed afterwards), or only the bucket does and the index arrives
 * as the first pushed cell (`path: [1]` then `push 3`, which is what writing a scalar looks
 * like). Reading only the first form is what made an earlier version of this file throw on
 * `join`'s `pot` write.
 */
function fieldOf(group: string): string | undefined {
  // The contract's own state is stack slot 0. Slot 2 is the KERNEL, which is where every
  // `blockTimeGt/Gte/Lt/Lte`, `kernel.checkpoint()` and token operation lands. Kernel reads bind
  // to nothing a concurrent transaction can move -- block time is not contract state -- so they
  // are not part of the conflict analysis and are skipped rather than mislabelled.
  const dup = /\{ dup: \{ n: (\d+) \} \}/.exec(group);
  if (dup !== null && dup[1] !== '0') return undefined;

  const at = group.indexOf('path: [');
  if (at < 0) throw new Error(`ledger op group with no path: ${group}`);
  let depth = 0;
  let end = at + 'path: ['.length - 1;
  for (; end < group.length; end++) {
    if (group[end] === '[') depth += 1;
    else if (group[end] === ']') {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  const literals = [...group.slice(at, end).matchAll(/_descriptor_\d+\.toValue\((\d+)n\)/g)].map(
    (m) => m[1]!,
  );
  if (literals.length === 0) throw new Error(`ledger op group with an empty path: ${group}`);
  if (literals.length === 1) {
    const pushed = /push: \{ storage: false, value: [^]*?_descriptor_\d+\.toValue\((\d+)n\)/.exec(
      group.slice(end),
    );
    if (pushed === null) throw new Error(`ledger op group with a bucket but no index: ${group}`);
    literals.push(pushed[1]!);
  }
  const key = `${literals[0]},${literals[1]}`;
  const name = FIELDS.get(key);
  if (name === undefined) throw new Error(`ledger op group addresses unknown field ${key}`);
  return name;
}

/**
 * The ledger fields this circuit READS -- i.e. the ones it BINDS to.
 *
 * A transaction is rejected if and only if one of these has changed between proving and
 * inclusion. This is the set that decides whether two circuits can run concurrently.
 */
export function ledgerReads(circuit: string): Set<string> {
  const out = new Set<string>();
  for (const g of ledgerGroups(circuit)) {
    if (!g.includes('popeq:')) continue;
    const field = fieldOf(g);
    if (field !== undefined) out.add(field);
  }
  return out;
}

/**
 * The ledger fields this circuit WRITES.
 *
 * A write on its own binds to nothing. Two transactions writing the same field both land, and
 * if they write the same map KEY the later one silently wins -- which is why every per-seat
 * write in this contract is gated by a proof only that seat's owner can produce.
 */
export function ledgerWrites(circuit: string): Set<string> {
  const out = new Set<string>();
  for (const g of ledgerGroups(circuit)) {
    if (!g.includes('ins:')) continue;
    const field = fieldOf(g);
    if (field !== undefined) out.add(field);
  }
  return out;
}

/** Sorted, for stable assertions. */
export function sorted(set: Set<string>): string[] {
  return [...set].sort();
}
