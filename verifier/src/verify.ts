#!/usr/bin/env node
// Copyright (C) Shielded Technologies
// SPDX-License-Identifier: Apache-2.0

/**
 * The settlement verifier: replay a whole game from the chain and nothing else.
 *
 *   npm run verify -w cli -- <table-address>
 *
 * WHAT IT IS GIVEN: a contract address. Nothing else -- no seeds, no player secrets, no run
 * state, no artefacts from the process that played the game. It talks to a public indexer.
 * Anyone can run it against anyone's table.
 *
 * WHAT IT PROVES. Once `settle` has revealed the seed, every die of every roll is a
 * deterministic function of public data, so the whole game can be recomputed and compared:
 *
 *   1. the revealed seed opens the commitment the table was deployed with -- which was made
 *      before any player existed, so the operator could not have chosen it to suit the dice;
 *   2. every roll of every turn, re-derived from (tableId, seed, mixed entropy, round, roll
 *      index) through the same byte ladder the circuit uses, matches the dice the chain
 *      published -- and every REROLL is re-derived under the hold mask the player actually sent,
 *      merged left to right over the rerolled positions;
 *   3. the ROUND DIGEST CHAIN reproduces exactly, from the genesis digest through every join and
 *      every round close. This is the part that makes 2 worth anything: every seat in round r
 *      hashes the digest as it stood when round r OPENED, so no roll can be checked without
 *      having replayed every earlier round in order;
 *   4. every score, recomputed from the dice with api/src/rules.ts -- the contract-canonical
 *      rules engine, not the circuit -- matches the scorecard the chain holds, box by box,
 *      including the upper bonus and the five-of-a-kind bonuses;
 *   5. the winner the tie-break selects, among SURVIVORS, is the seat the chain paid;
 *   6. the settle transaction spent ZERO user inputs and created exactly the two expected
 *      outputs, to the addresses recorded at join and at construction.
 *
 * WHAT IT CANNOT PROVE, stated honestly: that each seat's published entropy really is
 * `H(sk_s, tableId, round)` for the secret committed at join. That binding is what the
 * `playerMove` circuit asserts in zero knowledge, and it is unverifiable from public data by
 * construction -- if it were verifiable, `sk_s` would be public. The verifier confirms that the
 * chain accepted a proof of it, which is the whole point of the proof existing.
 *
 * -------------------------------------------------------------------------------------------
 * HOW IT READS A GAME THAT HAS NO CURSOR
 * -------------------------------------------------------------------------------------------
 *
 * The indexer gives the table's whole action list -- one entry per transaction, with an entry
 * point and a block height -- and the contract's public state can be read at any block. So the
 * verifier walks the actions in order and reads the state each one produced.
 *
 * TWO THINGS ARE HARDER THAN THEY WERE, and both are solved by diffing state rather than by
 * being told:
 *
 *   - `playerMove` is ONE entry point for THREE moves. Which one it was is recovered from the
 *     seat's stage transition: idle -> awaitRoll1 is an open, rolled{1,2} -> awaitRoll{2,3} is a
 *     hold, rolled{1,2,3} -> idle is a score. The verifier also has to work out WHICH SEAT
 *     moved, which it does by finding the one seat whose entry changed.
 *   - the CATEGORY a player chose is not stored in the ledger (it is a circuit argument), so it
 *     is recovered by diffing the seat's scorecard across the score. That is a stronger check
 *     than being told: the verifier finds the box that changed AND recomputes what belongs in
 *     it.
 *
 * The HOLD MASKS, by contrast, are readable: `seatTurn.hold1` and `hold2` are ledger state, so
 * the verifier reads the mask the player sent and re-derives the reroll under it. A mask that
 * did not produce the published dice fails check 2.
 */

import {
  applyScore,
  CATEGORY_COUNT,
  emptyScorecard,
  grandTotal,
  type Category,
  type Dice as RefDice,
  type Scorecard,
} from '@dust-dice/api';
import {
  emptyRoundResult,
  firstRollTs,
  genesisDigestTs,
  joinDigestTs,
  mixEntropyTs,
  rerollUnderMaskTs,
  roundDigestTs,
  seedCommitmentTs,
  type RoundResultTs,
} from '@dust-dice/contract';

import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import { userAddressBytes } from '@dust-dice/api/node';

import { NETWORK } from './config.ts';
import {
  diceToArray,
  FINAL_ROUND,
  readTableLedger,
  ROUND_COUNT,
  STAGE,
  Table,
  type TableLedger,
} from './contracts.ts';
import {
  contractActions,
  sumNative,
  sumNativeFor,
  transactionByHash,
  type ContractAction,
} from './indexer.ts';

const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex');
const same = (a: Uint8Array, b: Uint8Array): boolean => hex(a) === hex(b);
const MAX_SEATS = 6;

class Checks {
  private failures: string[] = [];
  private passes = 0;
  private readonly verbose: boolean;

  constructor(verbose: boolean) {
    this.verbose = verbose;
  }

  ok(what: string, condition: boolean, detail = ''): void {
    if (condition) {
      this.passes += 1;
      if (this.verbose) console.log(`  PASS ${what}`);
    } else {
      this.failures.push(`${what}${detail ? ` -- ${detail}` : ''}`);
      console.log(`  FAIL ${what}${detail ? ` -- ${detail}` : ''}`);
    }
  }

  get failed(): string[] {
    return this.failures;
  }

  get count(): number {
    return this.passes + this.failures.length;
  }

  summary(): void {
    console.log(
      `\n${this.failures.length === 0 ? 'VERIFIED' : 'VERIFICATION FAILED'}: ` +
        `${this.passes} checks passed, ${this.failures.length} failed`,
    );
    for (const f of this.failures) console.log(`  - ${f}`);
  }
}

/**
 * One TRANSACTION of the public log: the calls it carried, and the state it produced.
 *
 * Grouped by transaction rather than by call because a FAST turn is ONE transaction carrying the
 * whole turn -- open, resolve, hold, resolve, hold, resolve, score, up to seven calls -- and the
 * chain never held a state between them for anyone to read. Such a turn is verified against the
 * state the transaction produced instead (`verifyMergedTurn` below), which needs no "before"
 * state at all and is therefore sound however many seats settle in the same block.
 */
interface LogGroup {
  blockHeight: number;
  txHash: string;
  /** Entry points this one transaction carried, in whatever order the indexer returned them. */
  entryPoints: string[];
  /** Contract state after the block this transaction landed in. */
  led: TableLedger;
  /** Another transaction touched this table in the same block. */
  sharesBlock: boolean;
}

/** The calls a turn is made of, merged into one transaction or spread over several. */
const TURN_CALLS = new Set([
  'playerMove',
  'resolveRoll1',
  'resolveRoll2',
  'resolveRoll3',
  'resolveReroll',
]);

/**
 * Causal order for two transactions that landed in the same block. Not a guess: the contract's
 * own preconditions force it -- a seat joins before it can move, every live seat must have
 * scored before `closeRound` is accepted, and `settle` precedes the `redeem`s it funds.
 */
const GROUP_RANK: Record<string, number> = {
  join: 0,
  playerMove: 1,
  resolveRoll1: 1,
  resolveRoll2: 1,
  resolveRoll3: 1,
  resolveReroll: 1,
  eliminate: 2,
  closeRound: 3,
  settle: 4,
  redeem: 5,
  abortTable: 6,
};

/**
 * Read the table's whole history: every transaction, and the state it left behind.
 *
 * One state read per transaction, pinned to that transaction. `contractStateObservable` is not
 * usable for this -- it misses rapid successive updates and its first emission may predate the
 * write being read (bugs-found.md §0 #10).
 */
async function readHistory(address: string): Promise<LogGroup[]> {
  const actions = (await contractActions(address)).filter((a) => a.kind !== 'ContractDeploy');
  const byTx = new Map<string, ContractAction[]>();
  for (const a of actions) byTx.set(a.txHash, [...(byTx.get(a.txHash) ?? []), a]);

  const groups: LogGroup[] = [];
  for (const [txHash, calls] of byTx) {
    groups.push({
      blockHeight: calls[0]!.blockHeight,
      txHash,
      entryPoints: calls.map((x) => x.entryPoint ?? '?'),
      led: await readTableLedger(address, { txHash }),
      sharesBlock: false,
    });
  }
  groups.sort((a, b) =>
    a.blockHeight !== b.blockHeight
      ? a.blockHeight - b.blockHeight
      : (GROUP_RANK[a.entryPoints[0] ?? '?'] ?? 9) - (GROUP_RANK[b.entryPoints[0] ?? '?'] ?? 9),
  );
  for (const g of groups) {
    g.sharesBlock = groups.some((o) => o !== g && o.blockHeight === g.blockHeight);
  }
  return groups;
}

/** The seat whose `seatTurn` entry changed between two states, or -1. */
function movedSeat(prev: TableLedger, led: TableLedger): number {
  for (let s = 0; s < Number(led.seatCount); s++) {
    const a = prev.seatTurn.lookup(BigInt(s));
    const b = led.seatTurn.lookup(BigInt(s));
    if (a.stage !== b.stage) return s;
  }
  // A score returns the stage to idle from a non-idle value, so it is caught above. A move that
  // changed nothing at all is not a move.
  return -1;
}

function seatCard(led: TableLedger, seat: number): Scorecard {
  const c = led.seatCard.lookup(BigInt(seat));
  return {
    scores: c.filled.map((f, i) => (f ? Number(c.scores[i]) : null)),
    fiveOfAKindBonuses: Number(c.fiveOfAKindBonuses),
  };
}

function arrayEq(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/** All six slots' contributions to a round digest, read at the block the round closed. */
function roundResults(led: TableLedger): RoundResultTs[] {
  return Array.from({ length: MAX_SEATS }, (_, s) => {
    if (s >= Number(led.seatCount)) return emptyRoundResult();
    const p = led.seatProgress.lookup(BigInt(s));
    return { dice: diceToArray(p.dice), out: p.eliminated };
  });
}

/** What the verifier is tracking for one seat as it replays. */
interface SeatReplay {
  card: Scorecard;
  /** The mixed entropy of the turn in progress, latched at roll 1. */
  mixed?: Uint8Array;
  /** The dice as the replay believes them, after each resolved roll. */
  roll: number[];
  /** How many rolls the current turn has resolved. */
  rolls: number;
  eliminated: boolean;
  finishedAtRound: number;
}

async function verify(address: string, verbose: boolean): Promise<number> {
  // `userAddressBytes` decodes bech32m, which is network-tagged; nothing here builds a wallet,
  // so the network id has to be set explicitly.
  setNetworkId(NETWORK.networkId);
  const c = new Checks(verbose);
  console.log(`Verifying table ${address}\n`);

  const final = await readTableLedger(address);
  const seatCount = Number(final.seatCount);
  const tableId = final.tableId;

  console.log('── table, as deployed ──');
  console.log(`  tableId        ${hex(tableId)}`);
  console.log(`  tier           ${final.tier}   seats ${final.seatLimit}`);
  console.log(`  seedCommitment ${hex(final.seedCommitment)}`);
  console.log(`  phase          ${Table.Phase[final.phase]}`);
  // The mode changes what "verified" covers (docs/fast-turn-design.md): dice and payouts verify
  // identically in both, but hold-before-reveal ORDERING is chain-proven only on an on-chain-mode
  // table — a fast table's turn lands as one composed transaction, so its ordering is the
  // operator's attestation.
  console.log(
    `  mode           ${final.fastMode ? 'FAST (turn ordering operator-attested)' : 'on-chain (ordering chain-proven)'}`,
  );

  // A table that never settled is NOT a failed verification: an aborted or still-playing table
  // has not revealed its seed, so there is nothing to replay yet. Saying "FAILED" here would
  // read as an accusation about a game that simply is not over.
  if (final.phase !== Table.Phase.settled) {
    console.log(
      `\nNOT VERIFIABLE YET: this table is ${Table.Phase[final.phase]}. Only a settled table ` +
        'reveals the seed,\nand without the seed no roll can be re-derived. Nothing here says ' +
        'the game was dishonest.',
    );
    return 3;
  }

  // ---------------------------------------------------------------- 1. the seed opens the commit
  console.log('\n── the revealed seed ──');
  const seed = final.revealedSeed;
  console.log(`  seed ${hex(seed)}`);

  // An all-zero `revealedSeed` on a SETTLED table is not a missing field -- it is the contract's
  // marker for a game that was force-settled past the table deadline with no valid seed. The
  // payout was still fully determined by public state and every roll was proven in its own
  // transaction while the game was live, but the game cannot be REPLAYED offline, which is
  // exactly what this tool does. Say so and stop, rather than reporting a failure that suggests
  // the chain did something wrong.
  if (seed.every((b) => b === 0)) {
    console.log(
      '\n  This table was FORCE-SETTLED: the operator never revealed a valid seed before the\n' +
        '  table deadline, so `settle` paid the winner computed from public state and left\n' +
        '  `revealedSeed` at zero. The rolls cannot be re-derived offline. Nothing here is\n' +
        '  wrong; this game is simply unverifiable after the fact.',
    );
    c.summary();
    return 1;
  }

  c.ok(
    'the revealed seed opens the commitment the table was deployed with',
    same(seedCommitmentTs(tableId, seed), final.seedCommitment),
    `H(tableId, seed) = ${hex(seedCommitmentTs(tableId, seed))}`,
  );

  // ------------------------------------------------------------------------- walk the public log
  const groups = await readHistory(address);
  const callCount = groups.reduce((n, g) => n + g.entryPoints.length, 0);
  console.log(`\n── the public log: ${callCount} calls in ${groups.length} transaction(s) ──`);

  let digest = genesisDigestTs(tableId);
  const seats: SeatReplay[] = Array.from({ length: seatCount }, () => ({
    card: emptyScorecard(),
    roll: [1, 1, 1, 1, 1],
    rolls: 0,
    eliminated: false,
    finishedAtRound: Number.POSITIVE_INFINITY,
  }));
  let joins = 0;
  let opens = 0;
  let holds = 0;
  let scores = 0;
  let rollChecks = 0;
  let closes = 0;
  let eliminations = 0;

  /** State immediately before the group being examined -- the previous group's, or the deploy's. */
  const before = (i: number): TableLedger | undefined => (i === 0 ? undefined : groups[i - 1]!.led);
  /** Turn calls this replay could not separate. Non-empty means the verdict is not a clean one. */
  const unseparable: string[] = [];
  /** Seats whose redemption has already been accounted for, so a second one is not double-read. */
  const redeemed = new Set<number>();

  /**
   * A whole turn in ONE transaction -- the fast path, and the shape every fast table has.
   *
   * The chain never stored a state between the calls, so there is no "before" to diff. It does
   * not need one: everything the turn consumed is still on the ledger afterwards -- the seat's
   * entropy, the mixed entropy latched at roll 1, both hold masks, the last roll (`SeatTurn`) --
   * and how many rolls the turn took is the transaction's own call count (one `resolveRoll1`
   * plus N `resolveReroll` is N+1 rolls, against N+2 `playerMove`s: open, N holds, score).
   *
   * The roll chain is a hash chain: roll 2 is derived from roll 1 under the player's mask, roll 3
   * from roll 2. So if roll 1 or roll 2 were not what the operator claimed, the LAST roll could
   * not match the one the chain stored. Checking the end of the chain checks all of it.
   *
   * Reading only this seat's fields is what makes it sound when two seats settle in the same
   * block: their turns touch disjoint cells, and the digest this replay folds is its own.
   */
  const verifyMergedTurn = (g: LogGroup): void => {
    const led = g.led;
    const moves = g.entryPoints.filter((k) => k === 'playerMove').length;
    const firsts = g.entryPoints.filter((k) => k === 'resolveRoll1').length;
    const rerolls = g.entryPoints.filter(
      (k) => k === 'resolveReroll' || k === 'resolveRoll2' || k === 'resolveRoll3',
    ).length;
    const rolls = firsts + rerolls;
    const where = `tx ${g.txHash.slice(0, 10)}… (block ${g.blockHeight})`;
    if (firsts !== 1 || moves !== rolls + 1) {
      c.ok(
        `${where}: reads as one turn`,
        false,
        `${moves} playerMove + ${firsts} resolveRoll1 + ${rerolls} reroll is not ` +
          'open/(hold,resolve)*/score',
      );
      return;
    }

    // WHICH SEAT. The candidates are the seats whose chain card holds a box this replay has not
    // applied yet. With one candidate there is nothing to choose; with two (two seats settling
    // in the same block) the roll derivation itself decides, since a wrong pairing cannot
    // reproduce the stored roll.
    const filled = (card: Scorecard): number => card.scores.filter((x) => x !== null).length;
    const candidates: number[] = [];
    for (let s = 0; s < seatCount; s++) {
      if (filled(seatCard(led, s)) > filled(seats[s]!.card)) candidates.push(s);
    }
    if (candidates.length === 0) {
      c.ok(`${where}: a seat's card gained a box`, false, 'no seat advanced');
      return;
    }

    /** Re-derive the whole roll chain for one candidate; returns the final dice, or null. */
    const deriveFor = (
      seat: number,
    ): { round: number; mixed: Uint8Array; dice: number[] } | null => {
      const turn = led.seatTurn.lookup(BigInt(seat));
      const round = Number(turn.round);
      const mixed = mixEntropyTs(turn.entropy, digest);
      let dice = firstRollTs(tableId, seed, mixed, round);
      for (let step = 1; step <= rerolls; step++) {
        const mask = [...(step === 1 ? turn.hold1 : turn.hold2).bits];
        dice = rerollUnderMaskTs(tableId, seed, mixed, round, step, mask, dice);
      }
      return arrayEq(diceToArray(turn.roll), dice) ? { round, mixed, dice } : null;
    };

    let seat = candidates[0]!;
    let derived = deriveFor(seat);
    if (derived === null && candidates.length > 1) {
      for (const alt of candidates.slice(1)) {
        const d = deriveFor(alt);
        if (d !== null) {
          seat = alt;
          derived = d;
          break;
        }
      }
    }
    const turn = led.seatTurn.lookup(BigInt(seat));
    const round = Number(turn.round);
    const r = seats[seat]!;
    opens += 1;
    holds += rolls - 1;
    rollChecks += rolls;

    c.ok(
      `seat ${seat} r${round}: mixed entropy folds the frozen round digest`,
      same(turn.mixed, mixEntropyTs(turn.entropy, digest)),
      `chain ${hex(turn.mixed)}`,
    );
    c.ok(
      `seat ${seat} r${round}: all ${rolls} roll(s) re-derive, chained under the player's masks`,
      derived !== null,
      derived === null
        ? `chain stored ${diceToArray(turn.roll)} after ${rolls} roll(s); no derivation matches`
        : '',
    );
    if (derived === null) return;
    r.roll = derived.dice;
    r.rolls = rolls;
    r.mixed = derived.mixed;

    // SCORE. The category is whichever box the chain filled that this replay had not, and the
    // placement is recomputed with the contract-canonical rules engine from the DERIVED dice.
    const chainAfter = seatCard(led, seat);
    const category = chainAfter.scores.findIndex((x, k) => x !== null && r.card.scores[k] === null);
    c.ok(
      `seat ${seat} r${round}: score filled exactly one new category`,
      category >= 0 && filled(chainAfter) === filled(r.card) + 1,
      `category index ${category}`,
    );
    if (category >= 0) {
      scores += 1;
      r.card = applyScore(r.card, category as Category, derived.dice as unknown as RefDice);
      for (let k = 0; k < CATEGORY_COUNT; k++) {
        c.ok(
          `seat ${seat} r${round}: box ${k}`,
          r.card.scores[k] === chainAfter.scores[k],
          `replay ${r.card.scores[k]} vs chain ${chainAfter.scores[k]}`,
        );
      }
      c.ok(
        `seat ${seat} r${round}: running total`,
        BigInt(grandTotal(r.card)) === led.seatProgress.lookup(BigInt(seat)).total,
        `replay ${grandTotal(r.card)} vs chain ${led.seatProgress.lookup(BigInt(seat)).total}`,
      );
      c.ok(
        `seat ${seat} r${round}: the dice the chain stored are the ones replayed`,
        arrayEq(diceToArray(led.seatProgress.lookup(BigInt(seat)).dice), derived.dice),
        `chain ${diceToArray(led.seatProgress.lookup(BigInt(seat)).dice)} vs replay ${derived.dice}`,
      );
      c.ok(
        `seat ${seat} r${round}: score advances the seat past the round`,
        Number(led.seatProgress.lookup(BigInt(seat)).round) === round + 1,
      );
      if (round === FINAL_ROUND) r.finishedAtRound = round;
    }
  };

  for (let i = 0; i < groups.length; i++) {
    const g = groups[i]!;
    const led = g.led;
    const prev = before(i);
    const isTurn = g.entryPoints.every((k) => TURN_CALLS.has(k));

    // A turn merged into one transaction: checked against the state it produced.
    if (isTurn && g.entryPoints.length > 1) {
      verifyMergedTurn(g);
      continue;
    }
    // A SINGLE turn call sharing its block with another transaction. The per-call replay below
    // needs the state before the call, and in a shared block the previous group's state is the
    // state after both. Recording that is honest; checking against the wrong state is not.
    if (isTurn && g.sharesBlock) {
      unseparable.push(`${g.entryPoints[0]} in block ${g.blockHeight}`);
      continue;
    }

    switch (g.entryPoints[0]) {
      case 'join': {
        // A CALL THAT LANDED AND DID NOTHING. A transaction whose fallible section fails is
        // still recorded in the public log, so a rejected join appears here with the seat count
        // unmoved. Folding the digest for it would corrupt the chain from that point on (this
        // replay counts joins itself rather than trusting one action to be one seat).
        if (Number(led.seatCount) <= joins) {
          console.log(
            `  (a join in block ${g.blockHeight} left the seat count at ${joins} -- it landed ` +
              'on chain but its fallible section failed; nothing to replay)',
          );
          break;
        }
        // Seat order is join order, so the seat this call took is the one that did not exist
        // before it. The digest binds the seat's payout address and its entropy commitment.
        const seat = Number(led.seatCount) - 1;
        const id = led.seatIdentity.lookup(BigInt(seat));
        digest = joinDigestTs(digest, seat, id.addr.bytes, id.keyCommit);
        joins += 1;
        c.ok(
          `join ${seat}: digest chain`,
          same(led.roundDigest, digest),
          `chain ${hex(led.roundDigest)} vs replay ${hex(digest)}`,
        );
        c.ok(
          `join ${seat}: pot rose by exactly the tier`,
          led.pot === final.tier * BigInt(seat + 1),
          `pot ${led.pot}`,
        );
        break;
      }

      case 'playerMove': {
        if (!prev) break;
        const seat = movedSeat(prev, led);
        if (seat < 0) {
          c.ok('playerMove changed exactly one seat', false, 'no seat changed stage');
          break;
        }
        const round = Number(prev.openRound);
        const wasStage = Number(prev.seatTurn.lookup(BigInt(seat)).stage);
        const nowStage = Number(led.seatTurn.lookup(BigInt(seat)).stage);
        const r = seats[seat]!;

        if (wasStage === STAGE.idle && nowStage === STAGE.awaitRoll1) {
          // OPEN. The turn's mixed entropy is not latched until roll 1, but the entropy the
          // player declared is on chain now, and it is what roll 1 will hash.
          opens += 1;
          r.rolls = 0;
          c.ok(
            `seat ${seat} r${round}: open records the round`,
            Number(led.seatTurn.lookup(BigInt(seat)).round) === round,
          );
          c.ok(
            `seat ${seat} r${round}: open clears both hold masks`,
            led.seatTurn.lookup(BigInt(seat)).hold1.bits.every((b) => !b) &&
              led.seatTurn.lookup(BigInt(seat)).hold2.bits.every((b) => !b),
          );
        } else if (nowStage === STAGE.awaitRoll2 || nowStage === STAGE.awaitRoll3) {
          // HOLD. The mask is ledger state, so it is read rather than guessed -- and the reroll
          // it produces is checked against it when the resolve lands.
          holds += 1;
          const which = nowStage === STAGE.awaitRoll2 ? 'hold1' : 'hold2';
          const mask = led.seatTurn.lookup(BigInt(seat))[which].bits;
          c.ok(
            `seat ${seat} r${round}: ${which} landed in its own cell`,
            mask.length === 5,
            `mask ${mask.map((b) => (b ? 1 : 0)).join('')}`,
          );
        } else if (nowStage === STAGE.idle) {
          // SCORE. The category is recovered by diffing the card, then recomputed.
          scores += 1;
          const chainBefore = seatCard(prev, seat);
          const chainAfter = seatCard(led, seat);
          const category = chainAfter.scores.findIndex(
            (s, k) => s !== null && chainBefore.scores[k] === null,
          );
          c.ok(
            `seat ${seat} r${round}: score filled exactly one new category`,
            category >= 0 &&
              chainAfter.scores.filter((s) => s !== null).length ===
                chainBefore.scores.filter((s) => s !== null).length + 1,
            `category index ${category}`,
          );
          if (category >= 0) {
            // The dice scored are the ones the replay derived for this turn -- NOT read from the
            // chain. That is what makes this a check of the dice rather than of the bookkeeping.
            const dice = r.roll;
            // Recompute the placement with the CONTRACT-CANONICAL rules engine. If the chain and
            // api/src/rules.ts ever disagree about a box, one of them is wrong -- and the rules
            // engine is the specification.
            r.card = applyScore(r.card, category as Category, dice as unknown as RefDice);
            for (let k = 0; k < CATEGORY_COUNT; k++) {
              c.ok(
                `seat ${seat} r${round}: box ${k}`,
                r.card.scores[k] === chainAfter.scores[k],
                `replay ${r.card.scores[k]} vs chain ${chainAfter.scores[k]}`,
              );
            }
            c.ok(
              `seat ${seat} r${round}: running total`,
              BigInt(grandTotal(r.card)) === led.seatProgress.lookup(BigInt(seat)).total,
              `replay ${grandTotal(r.card)} vs chain ${led.seatProgress.lookup(BigInt(seat)).total}`,
            );
            c.ok(
              `seat ${seat} r${round}: the dice the chain stored are the ones replayed`,
              arrayEq(diceToArray(led.seatProgress.lookup(BigInt(seat)).dice), dice),
              `chain ${diceToArray(led.seatProgress.lookup(BigInt(seat)).dice)} vs replay ${dice}`,
            );
          }
          c.ok(
            `seat ${seat} r${round}: score advances the seat past the round`,
            Number(led.seatProgress.lookup(BigInt(seat)).round) === round + 1,
          );
          if (round === FINAL_ROUND) r.finishedAtRound = round;
        } else {
          c.ok(
            `seat ${seat} r${round}: recognised playerMove`,
            false,
            `stage ${wasStage} -> ${nowStage}`,
          );
        }
        break;
      }

      case 'resolveRoll1':
      case 'resolveReroll': {
        if (!prev) break;
        const seat = movedSeat(prev, led);
        if (seat < 0) {
          c.ok('a resolve changed exactly one seat', false, 'no seat changed stage');
          break;
        }
        const round = Number(prev.openRound);
        const r = seats[seat]!;
        const turn = led.seatTurn.lookup(BigInt(seat));
        const chainDice = diceToArray(turn.roll);

        if (g.entryPoints[0] === 'resolveRoll1') {
          // Roll 1 hashes the seat's declared entropy against the digest FROZEN AT ROUND OPEN --
          // which is the digest the replay is holding right now, because it only advances at a
          // closeRound. Getting that ordering wrong is the easiest way to make an unverifiable
          // game, so the latched value is checked too.
          const entropy = prev.seatTurn.lookup(BigInt(seat)).entropy;
          const mixed = mixEntropyTs(entropy, digest);
          r.mixed = mixed;
          c.ok(
            `seat ${seat} r${round}: mixed entropy`,
            same(turn.mixed, mixed),
            `chain ${hex(turn.mixed)} vs replay ${hex(mixed)}`,
          );
          const expected = firstRollTs(tableId, seed, mixed, round);
          c.ok(
            `seat ${seat} r${round}: roll 1`,
            arrayEq(chainDice, expected),
            `chain ${chainDice} vs replay ${expected}`,
          );
          r.roll = expected;
          r.rolls = 1;
        } else {
          // WHICH reroll this is comes from the seat's stage before the call -- the same place
          // the circuit reads it. There is one entry point for both rerolls, so the log does not
          // say, and inferring it from the stage is both necessary and a stronger check.
          const step =
            Number(prev.seatTurn.lookup(BigInt(seat)).stage) === STAGE.awaitRoll2 ? 1 : 2;
          const mask = (
            step === 1
              ? prev.seatTurn.lookup(BigInt(seat)).hold1
              : prev.seatTurn.lookup(BigInt(seat)).hold2
          ).bits;
          if (!r.mixed) {
            c.ok(`seat ${seat} r${round}: roll ${step + 1} has a latched mix`, false);
            break;
          }
          // THE reroll check: the fresh roll is consumed LEFT TO RIGHT over the positions the
          // mask does not keep. A verifier that merged positionally would agree on every mask
          // whose held set is a prefix and diverge on every other one.
          const expected = rerollUnderMaskTs(tableId, seed, r.mixed, round, step, mask, r.roll);
          c.ok(
            `seat ${seat} r${round}: roll ${step + 1} under mask ${mask.map((b) => (b ? 1 : 0)).join('')}`,
            arrayEq(chainDice, expected),
            `chain ${chainDice} vs replay ${expected}`,
          );
          // A held die must be byte-identical across the reroll -- the property the mask exists
          // for, checked independently of the derivation above.
          for (let d = 0; d < 5; d++) {
            if (mask[d] === true) {
              c.ok(
                `seat ${seat} r${round}: held die ${d} survived roll ${step + 1}`,
                chainDice[d] === r.roll[d],
                `${r.roll[d]} -> ${chainDice[d]}`,
              );
            }
          }
          r.roll = expected;
          r.rolls += 1;
        }
        c.ok(
          `seat ${seat} r${round}: dice are all in 1..6`,
          chainDice.every((d) => d >= 1 && d <= 6),
          chainDice.join(','),
        );
        c.ok(
          `seat ${seat} r${round}: no resolve moved the round digest`,
          same(led.roundDigest, digest),
          'only closeRound advances it',
        );
        rollChecks += 1;
        break;
      }

      case 'closeRound': {
        // The round is the replay's own count of closes, so a close that landed without effect
        // cannot shift the chain. `roundResults` is read AFTER the close, which is equivalent:
        // `closeRound` only reads `seatProgress` (it writes the digest, the round and the
        // deadline), so the per-seat cells it folded are unchanged by it.
        const round = closes;
        if (Number(led.openRound) !== round + 1) {
          console.log(
            `  (a closeRound in block ${g.blockHeight} left openRound at ${led.openRound} -- ` +
              'it landed on chain without effect; nothing to replay)',
          );
          break;
        }
        // The ONE place the digest advances. All six slots, in SEAT ORDER, read at this block --
        // which is what makes the replay independent of the order the chain saw the moves in.
        digest = roundDigestTs(digest, round, seatCount, roundResults(led));
        closes += 1;
        c.ok(
          `round ${round}: digest chain`,
          same(led.roundDigest, digest),
          `chain ${hex(led.roundDigest)} vs replay ${hex(digest)}`,
        );
        c.ok(
          `round ${round}: openRound advanced`,
          Number(led.openRound) === round + 1,
          `chain ${led.openRound}`,
        );
        break;
      }

      case 'eliminate': {
        // From the AFTER state, per seat: the seat this call took out is one the chain marks
        // eliminated that the replay has not marked yet. The alternative — diffing against the
        // previous group — is wrong the moment two seats are eliminated in one block, which is
        // exactly what a table nobody is playing does.
        let seat = -1;
        for (let s = 0; s < seatCount; s++) {
          if (!seats[s]!.eliminated && led.seatProgress.lookup(BigInt(s)).eliminated) {
            seat = s;
            break;
          }
        }
        if (seat < 0) {
          console.log(
            `  (an eliminate in block ${g.blockHeight} marked no new seat -- it landed on ` +
              'chain without effect, or the replay had already accounted for it)',
          );
          break;
        }
        // The round the seat owed when it was taken out. NOT `seatProgress.round`, which an
        // elimination sets to `roundCount()` to mean "finished", and not the chain's `openRound`,
        // which a closeRound in the same block would already have advanced. The replay's own
        // count of closed rounds is the open round by construction.
        const round = closes;
        eliminations += 1;
        seats[seat]!.eliminated = true;
        seats[seat]!.finishedAtRound = Number.POSITIVE_INFINITY;

        // The penalty rule, recomputed rather than read. A timeout charges round + 1; a
        // voluntary resignation is charged one round less — the open round does not count
        // (`voluntary` is a public circuit argument, but the cheapest verification is the money
        // itself: exactly one of the two schedules matches the redeemable delta, and which one
        // tells us how the seat left).
        const timeoutPenalty = (final.tier * BigInt(round + 1)) / 13n;
        const resignPenalty = (final.tier * BigInt(round)) / 13n;
        const delta = led.seatRedeemable.lookup(BigInt(seat));
        const penalty = delta === final.tier - resignPenalty ? resignPenalty : timeoutPenalty;
        const how =
          penalty === resignPenalty && resignPenalty !== timeoutPenalty ? 'resigned' : 'timed out';
        const refund = final.tier - penalty;
        c.ok(
          `seat ${seat}: eliminated at round ${round} keeps tier - penalty`,
          delta === refund,
          `expected +${refund} (penalty ${penalty}, ${how})`,
        );
        // The pot delta needs the state before this one call, so it is only checked where that
        // state is readable — one transaction in the block. Where it is not, nothing is lost:
        // the custody invariant below runs after every transaction and already pins the pot to
        // `tier x seats` minus everything owed and paid, which is the claim that matters.
        if (prev !== undefined && !g.sharesBlock) {
          c.ok(
            `seat ${seat}: the penalty stayed in the pot`,
            led.pot === prev.pot - refund,
            `pot ${prev.pot} -> ${led.pot}, expected -${refund}`,
          );
        }
        c.ok(
          `seat ${seat}: carries the never-finished sentinel`,
          led.seatProgress.lookup(BigInt(seat)).finishedAtRound === 65535n,
        );
        console.log(`  (seat ${seat} ${how} at round ${round}: penalty ${penalty})`);
        break;
      }

      case 'settle':
      case 'redeem':
      case 'abortTable':
        // Handled below, against the final state and the transaction.
        break;

      default:
        console.log(`  (unrecognised entry point '${g.entryPoints[0] ?? '?'}' -- ignored)`);
    }

    // The custody invariant, at every single step: while the table holds the money, every atom
    // it ever received is either in the pot or owed to a seat. The contract asserts this
    // in-circuit at three points; this checks it after every transaction, from public state.
    if (led.phase === Table.Phase.filling || led.phase === Table.Phase.playing) {
      let owed = 0n;
      let paid = 0n;
      for (let s = 0; s < MAX_SEATS; s++) {
        owed += led.seatRedeemable.lookup(BigInt(s));
        paid += led.seatPaid.lookup(BigInt(s));
      }
      c.ok(
        `tx ${i} (${g.entryPoints.join('+')}): custody invariant`,
        led.pot + owed + paid === final.tier * led.seatCount,
        `pot ${led.pot} + owed ${owed} + paid ${paid} != tier x ${led.seatCount}`,
      );
    }
  }

  console.log(
    `\n── replayed ${joins} joins, ${opens} opens, ${holds} holds, ${scores} scores, ` +
      `${rollChecks} rolls, ${closes} round closes, ${eliminations} eliminations ──`,
  );
  c.ok('every seat joined', joins === seatCount, `${joins} joins for ${seatCount} seats`);
  // On a walkover the survivor's in-flight turn is legitimately cut off by the settle: opened,
  // dice possibly delivered, never scored. At most ONE such dangling open, and only theirs.
  const danglingAllowed = seats.filter((s) => !s.eliminated).length === 1 ? 1 : 0;
  c.ok(
    'every live seat scored in every round',
    opens - scores <= danglingAllowed && opens >= scores,
    `${opens} turns opened, ${scores} scored (walkover allows ${danglingAllowed} dangling)`,
  );
  // A settled table need not have closed all thirteen rounds any more: the walkover (settle's
  // `activeSeats == 1` disjunct) legitimately ends a game the moment one active seat remains.
  // What must still hold is that the game either ran to the end or ended as a walkover — anything
  // shorter with two or more survivors is a settle the contract should have refused.
  const survivors = seats.filter((s) => !s.eliminated).length;
  c.ok(
    'the game ran to completion or ended as a walkover',
    closes === ROUND_COUNT || survivors === 1,
    `${closes} rounds closed of ${ROUND_COUNT}, ${survivors} non-eliminated seat(s)`,
  );
  c.ok(
    'the final digest matches the chain',
    same(final.roundDigest, digest),
    `chain ${hex(final.roundDigest)} vs replay ${hex(digest)}`,
  );

  // -------------------------------------------------------------------------------- the winner
  console.log('\n── the winner ──');
  const totals = seats.map((s) => grandTotal(s.card));
  for (let seat = 0; seat < seatCount; seat++) {
    const chainTotal = final.seatProgress.lookup(BigInt(seat)).total;
    console.log(
      `  seat ${seat}: replay total ${totals[seat]}, chain total ${chainTotal}` +
        `${seats[seat]!.eliminated ? ' (eliminated)' : ''}`,
    );
    c.ok(
      `seat ${seat}: final total`,
      BigInt(totals[seat]!) === chainTotal,
      `replay ${totals[seat]} vs chain ${chainTotal}`,
    );
  }

  // ELIMINATED SEATS CANNOT WIN. They have already been handed back `tier - penalty`; paying
  // one the pot as well would pay it twice. Among survivors the order is highest total, then a
  // completer over a non-completer, then the lowest seat -- and since every survivor completes
  // at the same round, in practice it is total then seat index.
  let expectedWinner = -1;
  for (let seat = 0; seat < seatCount; seat++) {
    if (seats[seat]!.eliminated) continue;
    if (expectedWinner < 0) {
      expectedWinner = seat;
      continue;
    }
    const better =
      totals[seat]! > totals[expectedWinner]! ||
      (totals[seat] === totals[expectedWinner] &&
        seats[seat]!.finishedAtRound < seats[expectedWinner]!.finishedAtRound);
    if (better) expectedWinner = seat;
  }
  c.ok(
    'the chain paid the seat the tie-break selects among survivors',
    BigInt(expectedWinner) === final.winnerSeatIndex,
    `replay ${expectedWinner} vs chain ${final.winnerSeatIndex}`,
  );

  // -------------------------------------------------------------------------------- the payout
  console.log('\n── the payout ──');
  const settleGroup = groups.find((gr) => gr.entryPoints.includes('settle'));
  if (!settleGroup) {
    c.ok('the settle transaction is in the log', false);
  } else {
    const tx = await transactionByHash(settleGroup.txHash);
    const winnerAddr = final.seatIdentity.lookup(final.winnerSeatIndex).addr.bytes;
    const rakeAddr = final.rakeAddress.bytes;
    // `settle` pays out exactly the POT, which is the stakes minus whatever left it as an
    // eliminated seat's refund. Read from the state just before the settle rather than assumed
    // to be tier x seatCount, because an elimination moves money out of the pot.
    const settleAt = groups.indexOf(settleGroup);
    const potBefore = groups[settleAt - 1]!.led.pot;
    const q = potBefore / 100n;

    const spentByUsers = sumNative(tx.unshieldedSpentOutputs);
    const created = sumNative(tx.unshieldedCreatedOutputs);
    console.log(`  settle tx ${tx.hash} in block ${tx.block.height}`);
    for (const u of tx.unshieldedCreatedOutputs) {
      console.log(`    created ${u.value} to ${u.owner.slice(0, 24)}…`);
    }

    // THE decisive row, and the same one that made Gate 0's `payOut` conclusive: a transaction
    // that spends no user inputs while creating real native NIGHT can only be paying out of the
    // contract's own balance. That is custody, demonstrated rather than asserted.
    c.ok('settle spent ZERO user inputs', spentByUsers === 0n, `${spentByUsers} spent by users`);
    c.ok(
      'settle created exactly the pot',
      created === potBefore,
      `created ${created}, pot ${potBefore}`,
    );
    c.ok(
      'the winner was paid pot - q, at the address recorded at join',
      sumNativeFor(tx.unshieldedCreatedOutputs, addressOf(tx, winnerAddr)) === potBefore - q,
      `expected ${potBefore - q}`,
    );
    c.ok(
      'the rake was paid q, at the address sealed at construction',
      sumNativeFor(tx.unshieldedCreatedOutputs, addressOf(tx, rakeAddr)) === q,
      `expected ${q}`,
    );
    c.ok('the pot is empty afterwards', final.pot === 0n, `pot field ${final.pot}`);
  }

  // ------------------------------------------------------------------------------- redemptions
  const redeems = groups.filter((gr) => gr.entryPoints.includes('redeem'));
  if (redeems.length > 0) {
    console.log(`\n── ${redeems.length} redemption(s) ──`);
    for (const gr of redeems) {
      // The seat and the amount both come from the state AFTER the redeem: `seatPaid` is what
      // the contract recorded paying, and it is per seat. Reading "what it was owed" from the
      // previous group instead would be wrong the moment two seats redeem in one block, which
      // is exactly what an aborted table does.
      let seat = -1;
      for (let s = 0; s < seatCount; s++) {
        if (
          !redeemed.has(s) &&
          gr.led.seatPaid.lookup(BigInt(s)) > 0n &&
          gr.led.seatRedeemable.lookup(BigInt(s)) === 0n
        ) {
          seat = s;
          break;
        }
      }
      if (seat < 0) {
        c.ok('a redeem zeroed exactly one seat', false);
        continue;
      }
      redeemed.add(seat);
      const owed = gr.led.seatPaid.lookup(BigInt(seat));
      const tx = await transactionByHash(gr.txHash);
      const addr = final.seatIdentity.lookup(BigInt(seat)).addr.bytes;
      console.log(`  seat ${seat} redeemed ${owed}`);
      c.ok(
        `redeem seat ${seat}: paid exactly what it was owed, to its join-time address`,
        sumNativeFor(tx.unshieldedCreatedOutputs, addressOf(tx, addr)) === owed,
        `expected ${owed}`,
      );
      // RECORDED, NOT ASSERTED, and the asymmetry with `settle` above is deliberate. The
      // decisive custody claim is the amount and the recipient, which are asserted. Whether the
      // CALLER also spent native inputs depends on how its wallet happened to fund the fee --
      // `settle` was measured at zero in the previous E2E run while `abortTable`, called by the
      // same wallet, was not. Asserting zero here would make the verifier fail for a reason that
      // says nothing about the contract.
      console.log(`    (caller spent ${sumNative(tx.unshieldedSpentOutputs)} of its own inputs)`);
    }
  }

  // Steps this method genuinely could not separate. Not a failure of the game and not a pass
  // either: an on-chain table whose seats moved in the same block leaves those individual calls
  // unattributable, and saying so beats both a false alarm and a false clean bill.
  if (unseparable.length > 0) {
    console.log(
      `\n── ${unseparable.length} call(s) this replay could not separate ──\n` +
        unseparable.map((u) => `  ${u}`).join('\n') +
        '\n  Each shared its block with another transaction, so the state before it is not\n' +
        '  readable. Everything else above was checked. A FAST table never lands here: its\n' +
        '  whole turn is one transaction and is verified as a unit.',
    );
  }
  c.summary();
  console.log(`\n(${c.count} checks in total)`);
  if (c.failed.length > 0) return 1;
  return unseparable.length > 0 ? 2 : 0;
}

/**
 * Match a raw 32-byte payout key against the bech32m owner strings the indexer reports.
 *
 * The contract stores the raw key (a circuit argument cannot be a bech32m string); the indexer
 * reports the encoded address. Rather than re-implement the encoding here, the raw key is
 * matched against whichever created output's owner decodes to it -- and the decoding is the
 * wallet SDK's, via `@dust-dice/api/node`'s `userAddressBytes`, which is pure key math and needs
 * no wallet.
 */
function addressOf(tx: { unshieldedCreatedOutputs: { owner: string }[] }, raw: Uint8Array): string {
  const target = hex(raw);
  for (const u of tx.unshieldedCreatedOutputs) {
    try {
      if (hex(userAddressBytes(u.owner)) === target) return u.owner;
    } catch {
      /* not an address this build can decode; skip */
    }
  }
  return '<no created output belongs to this address>';
}

const address = process.argv[2];
if (!address) {
  console.error(
    'usage: npm run verify -w cli -- <table-address> [--verbose]\n\n' +
      'Replays a settled Dust Dice table from the chain alone: every roll re-derived under the\n' +
      'hold masks the players sent, every score recomputed, the winner and the payout\n' +
      're-confirmed.',
  );
  process.exit(2);
}

process.exitCode = await verify(address, process.argv.includes('--verbose'));
process.exit(process.exitCode);
