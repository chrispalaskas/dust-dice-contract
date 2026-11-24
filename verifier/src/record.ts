// Copyright (C) Shielded Technologies
// SPDX-License-Identifier: Apache-2.0

/**
 * A TABLE'S PUBLIC RECORD, as the verifier reads it: the final state, every transaction with the
 * state it produced and the contract's balance at that point, and each transaction's unshielded
 * outputs.
 *
 * The checks (yacht.ts, backgammon.ts) take a record and do not care where it came from. A record
 * is built here from a `ChainReader` -- the few reads it needs from an indexer -- and the reader
 * is the only part that differs by where the verifier runs: node-reader.ts for the command line,
 * the website's own for the /verify page. The Yacht test suite builds a record straight from a
 * simulator game (yacht.test.ts), which is how the verifier is tested without a chain -- and how
 * a forged record is shown to fail it.
 *
 * Pure: nothing here touches Node, so the page runs it as it is.
 */

import { bgHeldSlots } from '@dust-dice/contract';

import { Backgammon, hex, type BackgammonLedger, type TableLedger } from './game.ts';

// --------------------------------------------------------------------------------- the reader

/** One call the indexer lists for a contract. */
export interface ChainAction {
  txHash: string;
  blockHeight: number;
  entryPoint?: string;
  /** 'ContractDeploy' | 'ContractCall' | 'ContractUpdate'. */
  kind: string;
  /** Undefined on an indexer too old to say; read as SUCCESS. */
  txStatus?: string;
}

/** A contract's state, decoded, and the native (NIGHT) balance it held in that state. */
export interface StateAt<L> {
  led: L;
  balance: bigint;
}

/** The reads a record is built from. The command line's goes through Node; the page's, fetch. */
export interface ChainReader {
  actions(address: string): Promise<ChainAction[]>;
  /** Which of a PARTIAL success's calls the chain applied. */
  outcomes(address: string, txHash: string): Promise<{ entryPoint: string; applied: boolean }[]>;
  /** The state a transaction left (`at`), or the latest. */
  yacht(address: string, at?: { txHash: string }): Promise<StateAt<TableLedger>>;
  backgammon(address: string, at?: { txHash: string }): Promise<StateAt<BackgammonLedger>>;
  tx(hash: string): Promise<TxRecord>;
}

/** How far the (slow: one round trip per transaction) history read has got. */
export type OnProgress = (phase: string, current: number, total: number) => void;

// ------------------------------------------------------------------------- what the checks read

/**
 * One TRANSACTION of the public log: the calls it carried, and the state it produced.
 *
 * Grouped by transaction rather than by call because a FAST turn is ONE transaction carrying the
 * whole turn -- open, resolve, hold, resolve, hold, resolve, score, up to seven calls -- and the
 * chain never held a state between them for anyone to read. Such a turn is verified against the
 * state the transaction produced instead (`verifyMergedTurn`), which needs no "before" state at
 * all and is therefore sound however many seats settle in the same block.
 */
export interface LogGroup {
  blockHeight: number;
  txHash: string;
  /** Entry points this one transaction carried, in whatever order the indexer returned them. */
  entryPoints: string[];
  /** Contract state after this transaction. */
  led: TableLedger;
  /** The native (NIGHT) balance the contract held in that same state. */
  balance: bigint;
  /** Another transaction touched this table in the same block. */
  sharesBlock: boolean;
}

/** One unshielded output, its owner decoded to the 32 address bytes the ledger records. */
export interface Output {
  /** Hex of the owner's address bytes, or `?<raw owner>` when this build cannot decode it. */
  owner: string;
  value: bigint;
}

/** What a transaction did to unshielded NIGHT: the outputs it created and the ones it spent. */
export interface TxRecord {
  hash: string;
  blockHeight: number;
  created: Output[];
  spent: Output[];
}

export interface YachtRecord {
  /** For the report only. */
  address: string;
  final(): Promise<TableLedger>;
  history(): Promise<LogGroup[]>;
  tx(hash: string): Promise<TxRecord>;
}

/** One transaction of a Backgammon table's log, and what it left behind. */
export interface BgStep {
  blockHeight: number;
  txHash: string;
  /** The calls that took effect. */
  entryPoints: string[];
  /** Calls the chain lists for this transaction but did not apply: their segment failed. */
  failed: string[];
  led: BackgammonLedger;
  /** The contract's real native balance after this transaction. */
  balance: bigint;
}

export interface BackgammonRecord {
  address: string;
  final(): Promise<BackgammonLedger>;
  /** Every transaction, in causal order (`causalOrder`). */
  history(): Promise<BgStep[]>;
  tx(hash: string): Promise<TxRecord>;
}

export const sumOut = (outs: readonly Output[]): bigint => outs.reduce((a, o) => a + o.value, 0n);

/** Everything paid to `addr` (raw address bytes) in these outputs. */
export const sumOutFor = (outs: readonly Output[], addr: Uint8Array): bigint =>
  sumOut(outs.filter((o) => o.owner === hex(addr)));

/**
 * Each owner's NET receipt in a transaction: created minus spent. A caller that funded its
 * transaction with its own NIGHT gets change back, and that change is not a payment -- the net
 * is what the contract actually sent it.
 */
export function netByOwner(tx: TxRecord): Map<string, bigint> {
  const net = new Map<string, bigint>();
  for (const o of tx.created) net.set(o.owner, (net.get(o.owner) ?? 0n) + o.value);
  for (const o of tx.spent) net.set(o.owner, (net.get(o.owner) ?? 0n) - o.value);
  return net;
}

/**
 * WHAT THE LEDGER SAYS THE CONTRACT HOLDS (docs/table-interface.md section 6): while filling,
 * `tier` for every held slot, counted by nothing else; from the start on, `pot + SUM(redeemable)`.
 * A contract balance that differs from this after any transaction means some circuit moved a
 * different amount than its own bookkeeping recorded.
 */
export function ledgerHoldings(led: TableLedger, filling: boolean): bigint {
  if (filling) {
    let held = 0n;
    for (let i = 0; i < 6; i++) {
      if (!led.seatIdentity.lookup(BigInt(i)).addr.bytes.every((b) => b === 0)) held += 1n;
    }
    return led.tier * held;
  }
  let redeemable = 0n;
  for (let i = 0; i < 6; i++) redeemable += led.seatRedeemable.lookup(BigInt(i));
  return led.pot + redeemable;
}

// --------------------------------------------------------------------------- the shared read

/** Every transaction that touched `address`, each with the calls that actually took effect. */
async function readLog<L>(
  address: string,
  reader: ChainReader,
  stateAt: (txHash: string) => Promise<StateAt<L>>,
  onProgress: OnProgress,
): Promise<{ tx: ChainAction; applied: string[]; failed: string[]; at: StateAt<L> }[]> {
  onProgress('reading the log', 0, 1);
  const actions = (await reader.actions(address)).filter((a) => a.kind !== 'ContractDeploy');
  const byTx = new Map<string, ChainAction[]>();
  for (const a of actions) byTx.set(a.txHash, [...(byTx.get(a.txHash) ?? []), a]);

  const out = [];
  let n = 0;
  for (const [txHash, calls] of byTx) {
    onProgress('reading every state', ++n, byTx.size);
    // A PARTIAL success lists every call, the ones whose segment failed too, and a failed call
    // changed nothing: replaying it as a move the chain made fails a legitimate table (devnet
    // 2026-11-23: fast settlements whose player segments failed, d00fb583). Read which applied.
    const status = calls[0]!.txStatus;
    const outcomes =
      status === undefined || status === 'SUCCESS'
        ? undefined
        : await reader.outcomes(address, txHash);
    out.push({
      tx: calls[0]!,
      applied: outcomes
        ? outcomes.filter((o) => o.applied).map((o) => o.entryPoint)
        : calls.map((x) => x.entryPoint ?? '?'),
      failed: outcomes ? outcomes.filter((o) => !o.applied).map((o) => o.entryPoint) : [],
      at: await stateAt(txHash),
    });
  }
  return out;
}

// ----------------------------------------------------------------------------------- Yacht

/**
 * Causal order for two transactions that landed in the same block. Not a guess: the contract's
 * own preconditions force it -- a seat joins before it can move, every live seat must have
 * scored before `closeRound` is accepted, and `settle` precedes the `redeem`s it funds.
 */
const GROUP_RANK: Record<string, number> = {
  join: 0,
  playerMove: 1,
  resolveRoll: 1,
  seatClock: 1,
  eliminate: 2,
  closeRound: 3,
  settle: 4,
  redeem: 5,
  abortTable: 6,
};

/**
 * A Yacht table's record, read through `reader`.
 *
 * One state read per transaction, pinned to that transaction. `contractStateObservable` is not
 * usable for this -- it misses rapid successive updates and its first emission may predate the
 * write being read (bugs-found.md §0 #10).
 */
export function yachtRecord(
  address: string,
  reader: ChainReader,
  onProgress: OnProgress = () => {},
): YachtRecord {
  return {
    address,
    final: async () => (await reader.yacht(address)).led,
    async history() {
      const log = await readLog(
        address,
        reader,
        (h) => reader.yacht(address, { txHash: h }),
        onProgress,
      );
      const groups: LogGroup[] = log
        .filter((t) => t.applied.length > 0) // nothing of it took effect
        .map((t) => ({
          blockHeight: t.tx.blockHeight,
          txHash: t.tx.txHash,
          entryPoints: t.applied,
          led: t.at.led,
          balance: t.at.balance,
          sharesBlock: false,
        }));
      groups.sort((a, b) =>
        a.blockHeight !== b.blockHeight
          ? a.blockHeight - b.blockHeight
          : (GROUP_RANK[a.entryPoints[0] ?? '?'] ?? 9) - (GROUP_RANK[b.entryPoints[0] ?? '?'] ?? 9),
      );
      for (const g of groups) {
        g.sharesBlock = groups.some((o) => o !== g && o.blockHeight === g.blockHeight);
      }
      return groups;
    },
    tx: (hash) => reader.tx(hash),
  };
}

// ------------------------------------------------------------------------------ Backgammon

const STAGE_OPENING = 0n;
export { STAGE_OPENING as BG_STAGE_OPENING };

/** Slots someone holds. While filling nothing else counts the players -- the contract's §6. */
export const occupied = (led: BackgammonLedger): number => bgHeldSlots(led).length;

/** How many of the two opening shares are in. */
export function shareCount(l: BackgammonLedger): number {
  return [0n, 1n].filter((s) => l.openingShare.lookup(s).some((b) => b !== 0)).length;
}

/**
 * Where a state sits in the game, for ordering two transactions that share a block. A
 * Backgammon table is strictly sequential -- every call asserts the stage its predecessor left
 * -- so this is total within one table's log.
 */
function progress(led: BackgammonLedger): number {
  const phaseRank = led.phase >= Backgammon.BgPhase.decided ? 1 : 0;
  return (
    (phaseRank * 1_000_000 + Number(led.turn) * 4 + Number(led.stage) * 2 + occupied(led)) * 10 +
    (led.phase === Backgammon.BgPhase.settled ? 1 : 0)
  );
}

/** Could this transaction's calls have taken the table from `p` to `s`? */
function produces(eps: readonly string[], p: BackgammonLedger, s: BackgammonLedger): boolean {
  const P = Backgammon.BgPhase;
  if (eps.includes('move') || eps.includes('openingMove')) return s.turn === p.turn + 1n;
  if (eps.includes('start')) return p.phase === P.filling && s.phase === P.playing;
  if (eps.includes('reveal')) return shareCount(s) === shareCount(p) + 1;
  if (eps.includes('join')) return occupied(s) === occupied(p) + 1;
  if (eps.includes('eliminate')) {
    return (
      (p.phase === P.filling && occupied(s) === occupied(p) - 1) ||
      (p.phase === P.playing && s.phase === P.decided && s.turn === p.turn)
    );
  }
  if (eps.includes('settle')) return p.phase === P.decided && s.phase === P.settled;
  if (eps.includes('abortTable')) return s.phase === P.aborted;
  return false;
}

/** Everything a call can change. Equal before and after = the call had no effect. */
export function stateKey(l: BackgammonLedger): string {
  return [
    l.phase,
    l.seatCount,
    l.stage,
    l.toMove,
    l.turn,
    l.dice.a,
    l.dice.b,
    l.pot,
    occupied(l),
    l.winner,
    l.deadline,
    shareCount(l),
    l.board.s0.join(','),
    l.board.s1.join(','),
  ].join('|');
}

/**
 * Order each block's transactions by CAUSE, not by listing: at every point take the transaction
 * whose calls explain the step from the current state; one that left the state exactly as it was
 * is a call that landed without effect (it lost a race in the same block) and goes where it
 * changed nothing. Sorting by progress alone cannot tell a winning move from the timeout claim
 * it beat -- both leave the same state behind.
 */
function causalOrder(sorted: BgStep[]): BgStep[] {
  const out: BgStep[] = [];
  let cur: BackgammonLedger | undefined;
  for (let i = 0; i < sorted.length;) {
    const block = sorted.filter((st) => st.blockHeight === sorted[i]!.blockHeight);
    i += block.length;
    const pending = [...block];
    while (pending.length > 0) {
      let k = pending.findIndex((st) =>
        cur === undefined ? st.entryPoints.includes('join') : produces(st.entryPoints, cur, st.led),
      );
      if (k < 0 && cur) {
        const key = stateKey(cur);
        k = pending.findIndex((st) => stateKey(st.led) === key);
      }
      if (k < 0) k = 0; // unexplained: keep its place, and let the checks say what is wrong
      const [st] = pending.splice(k, 1);
      out.push(st!);
      cur = st!.led;
    }
  }
  return out;
}

/**
 * Whether step `i` is a join whose block gained a slot for every join in it: the block's state
 * before it is the after-state of the last step of the block before.
 */
export function everyJoinSeated(steps: readonly BgStep[], i: number): boolean {
  const s = steps[i]!;
  if (!s.entryPoints.includes('join')) return false;
  const first = steps.findIndex((x) => x.blockHeight === s.blockHeight);
  const before = first > 0 ? occupied(steps[first - 1]!.led) : 0;
  const joins = steps.filter(
    (x) => x.blockHeight === s.blockHeight && x.entryPoints.includes('join'),
  ).length;
  return occupied(s.led) - before >= joins;
}

/** A Backgammon table's record, read through `reader`, its log in causal order. */
export function backgammonRecord(
  address: string,
  reader: ChainReader,
  onProgress: OnProgress = () => {},
): BackgammonRecord {
  return {
    address,
    final: async () => (await reader.backgammon(address)).led,
    async history() {
      const log = await readLog(
        address,
        reader,
        (h) => reader.backgammon(address, { txHash: h }),
        onProgress,
      );
      const steps: BgStep[] = log.map((t) => ({
        blockHeight: t.tx.blockHeight,
        txHash: t.tx.txHash,
        entryPoints: t.applied,
        failed: t.failed,
        led: t.at.led,
        balance: t.at.balance,
      }));
      steps.sort((a, b) => a.blockHeight - b.blockHeight || progress(a.led) - progress(b.led));
      return causalOrder(steps);
    },
    tx: (hash) => reader.tx(hash),
  };
}
