// Copyright (C) Shielded Technologies
// SPDX-License-Identifier: Apache-2.0

/**
 * HOW A VERIFIER REPORTS, wherever it runs.
 *
 * The game checks (yacht.ts, backgammon.ts) say what they found through `Report` and nothing
 * else. The command line prints it (checks.ts `Checks`); the /verify page collects it as rows
 * (`Recorder`, below). Both run the same checks, so the page and `dust-dice-verify` cannot drift
 * apart: they once did, as two hand-kept copies, and the page lost checks the command line had
 * gained (2026-11-23: 138 checks against 222 on the same Backgammon table).
 */

/** Where the rows recorded from now on belong in the chain's order. */
export type ReportAt = { txHash: string; blockHeight: number } | 'summary' | undefined;

export interface Report {
  /**
   * One check. `what` is `"<group>: <label>"` -- "seat 2 r5: box 7", "custody (settle): ..." --
   * or a bare label, which then belongs to the current section.
   */
  ok(what: string, condition: boolean, detail?: string): void;
  /** A finding that is not a pass or a fail: what was seen, and why it was not checked. */
  note(text: string): void;
  /** A heading: everything until the next one is about this. */
  section(title: string): void;
  /** The transaction the next rows read; 'summary' for a tally over the whole log. */
  at(where: ReportAt): void;
  /** How far a slow read has got (one indexer round trip per transaction). */
  progress(phase: string, current: number, total: number): void;
  readonly passed: number;
  readonly failed: number;
}

/**
 * What a verification concluded. The bin turns it into an exit code (`exitCode`); the page into
 * a banner.
 *
 *   verified      every check passed
 *   failed        a check failed: the chain's record and the replay disagree
 *   findings      verified, and a player broke a rule the chain does not enforce (Backgammon)
 *   unseparable   verified except calls that shared a block and so could not be told apart
 *   unverifiable  settled without a key to replay from (a Yacht table force-settled)
 *   not-settled   not over yet: only custody so far could be checked
 */
export type Verdict =
  'verified' | 'failed' | 'findings' | 'unseparable' | 'unverifiable' | 'not-settled';

/** The command line's exit codes, unchanged since before verdicts had names. */
export function exitCode(v: Verdict): number {
  switch (v) {
    case 'verified':
      return 0;
    case 'findings':
    case 'unseparable':
      return 2;
    case 'not-settled':
      return 3;
    default:
      return 1;
  }
}

export type CheckStatus = 'pass' | 'fail' | 'info';

/** One row of the report as the page shows it. */
export interface CheckEvent {
  status: CheckStatus;
  group: string;
  label: string;
  detail?: string;
  /** The transaction whose on-chain effect this row read, when there is exactly one. */
  txHash?: string;
  /**
   * The block that transaction landed in -- what the page SORTS by. The checks run in dependency
   * order, which is not the chain's: a reader wants the chain's. Absent = a fact about the table
   * itself, shown before the log; `SUMMARY_BLOCK` = a tally over the whole log, shown after it.
   */
  blockHeight?: number;
}

/** Sort key for rows that conclude over the whole log rather than read one transaction. */
export const SUMMARY_BLOCK = Number.MAX_SAFE_INTEGER;

/** `"<group>: <label>"` split at its first ": ", if the part before it is short enough to be one. */
export function splitWhat(what: string, section: string): { group: string; label: string } {
  const i = what.indexOf(': ');
  if (i > 0 && i <= 48) return { group: what.slice(0, i), label: what.slice(i + 2) };
  return { group: section, label: what };
}

/** The page's `Report`: every row kept, and handed to `onEvent` as it is made. */
export class Recorder implements Report {
  readonly events: CheckEvent[] = [];
  passed = 0;
  failed = 0;
  private section_ = 'table';
  private tx: string | undefined;
  private block: number | undefined;

  private readonly onEvent: (e: CheckEvent) => void;
  private readonly onProgress: (phase: string, current: number, total: number) => void;

  constructor(
    onEvent: (e: CheckEvent) => void = () => {},
    onProgress: (phase: string, current: number, total: number) => void = () => {},
  ) {
    this.onEvent = onEvent;
    this.onProgress = onProgress;
  }

  ok(what: string, condition: boolean, detail = ''): void {
    if (condition) this.passed += 1;
    else this.failed += 1;
    this.record({ status: condition ? 'pass' : 'fail', ...splitWhat(what, this.section_), detail });
  }

  note(text: string): void {
    this.record({ status: 'info', group: this.section_, label: text });
  }

  section(title: string): void {
    this.section_ = title;
  }

  at(where: ReportAt): void {
    if (where === 'summary') {
      this.tx = undefined;
      this.block = SUMMARY_BLOCK;
    } else {
      this.tx = where?.txHash;
      this.block = where?.blockHeight;
    }
  }

  progress(phase: string, current: number, total: number): void {
    this.onProgress(phase, current, total);
  }

  private record(e: CheckEvent): void {
    if (!e.detail) delete e.detail;
    if (this.tx) e.txHash = this.tx;
    if (this.block !== undefined) e.blockHeight = this.block;
    this.events.push(e);
    this.onEvent(e);
  }
}
