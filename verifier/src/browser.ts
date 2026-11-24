// Copyright (C) Shielded Technologies
// SPDX-License-Identifier: Apache-2.0

/**
 * The verifier for a browser: the same checks `dust-dice-verify` runs, with no Node in their
 * import graph. Hand `yachtRecord` / `backgammonRecord` a `ChainReader` over your own indexer
 * client and a `Recorder` to collect the rows. The /verify page is built on exactly this.
 */

export { verifyYacht } from './yacht.ts';
export { verifyBackgammon } from './backgammon.ts';
export {
  backgammonRecord,
  yachtRecord,
  type BackgammonRecord,
  type BgStep,
  type ChainAction,
  type ChainReader,
  type LogGroup,
  type OnProgress,
  type Output,
  type StateAt,
  type TxRecord,
  type YachtRecord,
} from './record.ts';
export {
  exitCode,
  Recorder,
  SUMMARY_BLOCK,
  splitWhat,
  type CheckEvent,
  type CheckStatus,
  type Report,
  type ReportAt,
  type Verdict,
} from './report.ts';
export { hex } from './game.ts';
