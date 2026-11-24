// Copyright (C) Shielded Technologies
// SPDX-License-Identifier: Apache-2.0

/**
 * THE VERIFIER, TESTED (popper re-review C029, 2026-11-23).
 *
 * The verifier is the public evidence that a game was fair, and until now nothing tested it: its
 * only runs were against live tables. Here it is handed the record of a real game -- played by
 * the contract's own simulator, every circuit run recorded as one transaction with the state and
 * contract balance it left behind and the payouts it claimed -- and must verify it. Then it is
 * handed the same record with ONE thing forged, and must fail it: a die, a payout's recipient, a
 * balance, an amount. A verifier that passed the forgeries would be passing anything.
 *
 * The record is what an indexer would serve for an ON-CHAIN table, where every move is its own
 * transaction. (A fast table's merged turns are not built here: the simulator runs the calls one
 * by one, and the merged form is exercised on the devnet.)
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

import { GameDriver, mixedHolds, perSeatRake } from '../../contract/src/test/table-harness.ts';
import type { TableLedger } from './contracts.ts';
import type { LogGroup, Output, TxRecord, YachtRecord } from './record.ts';
import { Checks } from './checks.ts';
import { exitCode, Recorder } from './report.ts';
import { verifyYacht } from './yacht.ts';

type Effects = {
  unshieldedInputs?: Map<unknown, bigint>;
  claimedUnshieldedSpends?: Map<[unknown, { tag: string; address?: string }], bigint>;
};

type Recorded = { g: GameDriver; groups: LogGroup[]; txs: Map<string, TxRecord> };

/**
 * Fold every transaction recorded since `from` into ONE: the calls in order, the state and the
 * balance after the last, every payout. That is what a FAST turn is on chain -- the whole turn,
 * resolves and moves, in a single merged transaction -- and the verifier's `verifyMergedTurn`
 * checks it against the state it left, with no state in between to read.
 */
function merge(rec: Recorded, from: number): void {
  const parts = rec.groups.splice(from);
  if (parts.length === 0) return;
  const last = parts.at(-1)!;
  const created = parts.flatMap((p) => rec.txs.get(p.txHash)!.created);
  for (const p of parts) rec.txs.delete(p.txHash);
  const hash = `${last.txHash}-merged`;
  rec.groups.push({ ...last, txHash: hash, entryPoints: parts.flatMap((p) => p.entryPoints) });
  rec.txs.set(hash, { hash, blockHeight: last.blockHeight, created, spent: [] });
}

/** Play `round` with every turn landing as one merged transaction, then close it. */
async function fastRound(rec: Recorded, round: number): Promise<void> {
  for (const seat of rec.g.liveSeats()) {
    const from = rec.groups.length;
    await rec.g.playTurn(seat, round);
    merge(rec, from);
  }
  await rec.g.closeRound(round);
}

/** From now on, record every circuit `g` runs the way the indexer would serve it. */
function recording(g: GameDriver): Recorded {
  const groups: LogGroup[] = [];
  const txs = new Map<string, TxRecord>();
  let balance = 0n;
  g.sim.onRun = (circuit) => {
    const e = g.sim.lastEffects as Effects;
    let received = 0n;
    for (const v of e.unshieldedInputs?.values() ?? []) received += v;
    const created: Output[] = [];
    for (const [[, to], value] of e.claimedUnshieldedSpends ?? []) {
      if (to.tag === 'user' && to.address) created.push({ owner: to.address, value });
    }
    balance += received - created.reduce((a, o) => a + o.value, 0n);
    const n = groups.length + 1;
    const hash = `sim-${n}`;
    groups.push({
      blockHeight: n,
      txHash: hash,
      entryPoints: [circuit],
      led: g.sim.getLedger() as unknown as TableLedger,
      balance,
      sharesBlock: false,
    });
    txs.set(hash, { hash, blockHeight: n, created, spent: [] });
  };
  return { g, groups, txs };
}

/** A whole game -- one seat eliminated in round 4 -- settled, and the eliminated seat redeemed. */
async function recordedGame(): Promise<Recorded> {
  const g = await GameDriver.open(
    { seats: 3, fastMode: false },
    { strategy: 'bestScore', holds: mixedHolds, eliminations: [{ seat: 2, round: 3 }] },
  );
  const { groups, txs } = recording(g);
  await g.joinAll();
  await g.playToEnd();
  const [q, r] = g.rakeSplit();
  await g.sim.settle(g.config.vrfSecret, q, r);
  await g.sim.redeem(2); // the eliminated seat takes its refund
  g.sim.onRun = undefined;
  return { g, groups, txs };
}

function recordOf(groups: LogGroup[], txs: Map<string, TxRecord>, final: TableLedger): YachtRecord {
  return {
    address: 'simulated',
    final: async () => final,
    history: async () => groups,
    tx: async (hash) => {
      const t = txs.get(hash);
      if (!t) throw new Error(`no transaction ${hash}`);
      return t;
    },
  };
}

/**
 * Run the verifier as the command line does, with its report captured rather than printed; return
 * the exit code and the report. Then run it again as the /verify page does -- collecting rows in a
 * `Recorder` -- and require the same verdict and the same tally: the page and the command line
 * are one verifier, and this is where that stays true.
 */
async function verifyQuietly(record: YachtRecord): Promise<{ code: number; report: string }> {
  const lines: string[] = [];
  const log = console.log;
  console.log = (...a: unknown[]) => void lines.push(a.map(String).join(' '));
  const checks = new Checks(false);
  let verdict;
  try {
    verdict = await verifyYacht(record, checks);
    checks.summary();
  } finally {
    console.log = log;
  }
  const page = new Recorder();
  assert.equal(await verifyYacht(record, page), verdict, 'the page reaches the same verdict');
  assert.deepEqual(
    [page.passed, page.failed],
    [checks.passed, checks.failed],
    'the page counts the same checks',
  );
  return { code: exitCode(verdict), report: lines.join('\n') };
}

/** `led` with one seat's published roll replaced. */
function withRoll(led: TableLedger, seat: number, roll: Record<string, bigint>): TableLedger {
  const turns = led.seatTurn;
  const forged = new Proxy(turns, {
    get(t, k) {
      if (k === 'lookup') {
        return (s: bigint) => (s === BigInt(seat) ? { ...t.lookup(s), roll } : t.lookup(s));
      }
      const v = Reflect.get(t, k);
      return typeof v === 'function' ? v.bind(t) : v;
    },
  });
  return new Proxy(led, {
    get: (t, k) => (k === 'seatTurn' ? forged : Reflect.get(t, k)),
  });
}

describe('the verifier against a recorded game, and against forgeries of it', () => {
  let game: Awaited<ReturnType<typeof recordedGame>>;
  let final: TableLedger;

  before(async () => {
    game = await recordedGame();
    final = game.groups.at(-1)!.led;
  });

  it('verifies the honest record: every roll, score, payout and balance', async () => {
    const { code, report } = await verifyQuietly(recordOf(game.groups, game.txs, final));
    assert.equal(code, 0, report);
    assert.match(report, /VERIFIED/);
    assert.match(report, /custody checks over \d+ transactions/);
  });

  it('fails a record with one die changed', async () => {
    const i = game.groups.findIndex(
      (gr) => gr.entryPoints[0] === 'playerMove' && Number(gr.led.seatTurn.lookup(0n).roll.d0) > 0,
    );
    assert.ok(i > 0, 'a move that published seat 1 dice');
    const roll = game.groups[i]!.led.seatTurn.lookup(0n).roll;
    const groups = game.groups.map((gr, j) =>
      j === i ? { ...gr, led: withRoll(gr.led, 0, { ...roll, d0: (roll.d0 % 6n) + 1n }) } : gr,
    );
    const { code, report } = await verifyQuietly(recordOf(groups, game.txs, final));
    assert.equal(code, 1, report);
  });

  it("fails a settle whose rake went to someone else's address", async () => {
    const settle = game.groups.find((gr) => gr.entryPoints[0] === 'settle')!;
    const rake = Buffer.from(final.rakeAddress.bytes).toString('hex');
    // Nobody the table knows (the harness's rake address is ee..ee, its seats are low bytes).
    const STRANGER = '5a'.repeat(32);
    assert.notEqual(rake, STRANGER);
    const txs = new Map(game.txs);
    const t = txs.get(settle.txHash)!;
    txs.set(settle.txHash, {
      ...t,
      created: t.created.map((o) => (o.owner === rake ? { ...o, owner: STRANGER } : o)),
    });
    const { code, report } = await verifyQuietly(recordOf(game.groups, txs, final));
    assert.equal(code, 1, report);
    assert.match(report, /only for addresses the table recorded/);
  });

  it('fails a record where the contract quietly holds one atom less than its ledger', async () => {
    const mid = Math.floor(game.groups.length / 2);
    const groups = game.groups.map((gr, j) =>
      j === mid ? { ...gr, balance: gr.balance - 1n } : gr,
    );
    const { code, report } = await verifyQuietly(recordOf(groups, game.txs, final));
    assert.equal(code, 1, report);
    assert.match(report, /holds exactly what its ledger records/);
  });

  it('fails a redeem that paid one atom short, to the right address', async () => {
    const redeem = game.groups.find((gr) => gr.entryPoints[0] === 'redeem')!;
    const txs = new Map(game.txs);
    const t = txs.get(redeem.txHash)!;
    assert.equal(t.created.length, 1, 'the redeem pays one address');
    txs.set(redeem.txHash, {
      ...t,
      created: [{ ...t.created[0]!, value: t.created[0]!.value - 1n }],
    });
    const { code, report } = await verifyQuietly(recordOf(game.groups, txs, final));
    assert.equal(code, 1, report);
  });
});

describe('the verifier on a table that never started: where did the stakes go?', () => {
  // Two slots join a three-seat table; one leaves (paid at once), and the table never fills, so
  // past its deadline the abort refunds the other. Nothing to replay -- but every atom that left
  // is the chain's to account for, and the verifier checks it before saying "not verifiable yet".
  let rec: Recorded;
  before(async () => {
    const g = await GameDriver.open({ seats: 3 });
    rec = recording(g);
    await g.join(0);
    await g.join(1);
    g.sim.asPlayer(g.players[0]!.sk);
    await g.sim.resign(0, 0n, 0n);
    const { q, rem } = perSeatRake(g.config.tier);
    await g.sim.abortTable(q, rem, Number(g.ledger().roundDeadline) + 1);
    g.sim.onRun = undefined;
  });

  it('accounts for the leave and the refund, then says the game is not verifiable yet', async () => {
    const { code, report } = await verifyQuietly(
      recordOf(rec.groups, rec.txs, rec.groups.at(-1)!.led),
    );
    assert.equal(code, 3, report);
    assert.doesNotMatch(report, /FAIL/);
    // join, join, leave, abort: four balance checks, then for the leave and for the abort each
    // the recipients, the amount that left, and the one slot refund -- ten in all, so the
    // refund checks did run.
    assert.match(report, /10 custody checks over 4 transactions/);
  });

  it("fails a leave refund paid to someone else's address", async () => {
    const leave = rec.groups.find((gr) => gr.entryPoints[0] === 'eliminate')!;
    const txs = new Map(rec.txs);
    const t = txs.get(leave.txHash)!;
    txs.set(leave.txHash, {
      ...t,
      created: t.created.map((o) => ({ ...o, owner: '5a'.repeat(32) })),
    });
    const { code, report } = await verifyQuietly(recordOf(rec.groups, txs, rec.groups.at(-1)!.led));
    assert.equal(code, 1, report);
  });
});

describe('the verifier on FAST tables, whose turns land merged', () => {
  it('verifies a whole fast game, every turn one transaction', async () => {
    const g = await GameDriver.open(
      { seats: 2, fastMode: true },
      { strategy: 'bestScore', holds: mixedHolds },
    );
    const rec = recording(g);
    await g.joinAll();
    for (let round = 0; round < 13; round++) await fastRound(rec, round);
    const [q, r] = g.rakeSplit();
    await g.sim.settle(g.config.vrfSecret, q, r);
    g.sim.onRun = undefined;
    const { code, report } = await verifyQuietly(
      recordOf(rec.groups, rec.txs, rec.groups.at(-1)!.led),
    );
    assert.equal(code, 0, report);
  });

  it('verifies a fast walkover that ended before any seat revealed its secret', async () => {
    // Devnet d00fb583 (2026-11-23): one fast turn landed, the other seat was eliminated in the
    // same round, and the walkover settled. No seat reached its final score, so no secret was
    // revealed and no die can be re-derived -- and the verifier used to FAIL the game for it.
    const g = await GameDriver.open(
      { seats: 2, fastMode: true },
      { strategy: 'bestScore', holds: mixedHolds },
    );
    const rec = recording(g);
    await g.joinAll();
    const from = rec.groups.length;
    await g.playTurn(1, 0);
    merge(rec, from);
    await g.eliminate(0, 0);
    const [q, r] = g.rakeSplit();
    await g.sim.settle(g.config.vrfSecret, q, r);
    g.sim.onRun = undefined;
    const { code, report } = await verifyQuietly(
      recordOf(rec.groups, rec.txs, rec.groups.at(-1)!.led),
    );
    assert.equal(code, 0, report);
    assert.match(report, /never reached a final score/);
  });
});
