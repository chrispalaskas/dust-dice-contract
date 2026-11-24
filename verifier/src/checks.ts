// Copyright (C) Shielded Technologies
// SPDX-License-Identifier: Apache-2.0

/**
 * The command line's `Report` (report.ts): checks printed as they are made -- every failure,
 * and every pass with `--verbose` -- headings and notes as plain lines, the tally at the end.
 */

import type { Report, ReportAt } from './report.ts';

export class Checks implements Report {
  private failures: string[] = [];
  passed = 0;
  private where = '';
  private readonly verbose: boolean;

  constructor(verbose: boolean) {
    this.verbose = verbose;
  }

  ok(what: string, condition: boolean, detail = ''): void {
    if (condition) {
      this.passed += 1;
      if (this.verbose) console.log(`  PASS ${what}`);
    } else {
      const line = `${what}${detail ? ` -- ${detail}` : ''}${this.where}`;
      this.failures.push(line);
      console.log(`  FAIL ${line}`);
    }
  }

  note(text: string): void {
    console.log(`  ${text}`);
  }

  section(title: string): void {
    console.log(`\n── ${title} ──`);
  }

  at(where: ReportAt): void {
    this.where =
      where === undefined || where === 'summary'
        ? ''
        : ` [block ${where.blockHeight}, tx ${where.txHash.replace(/^0x/, '').slice(0, 10)}…]`;
  }

  progress(): void {}

  get failed(): number {
    return this.failures.length;
  }

  get count(): number {
    return this.passed + this.failures.length;
  }

  summary(): void {
    console.log(
      `\n${this.failures.length === 0 ? 'VERIFIED' : 'VERIFICATION FAILED'}: ` +
        `${this.passed} checks passed, ${this.failures.length} failed`,
    );
    for (const f of this.failures) console.log(`  - ${f}`);
    console.log(`\n(${this.count} checks in total)`);
  }
}
