// Copyright (C) Shielded Technologies
// SPDX-License-Identifier: Apache-2.0

/**
 * A driver for playing whole games of Yahtzee through `TableSimulator`, and an INDEPENDENT
 * replay of every game it plays.
 *
 * The point of the replay is that the assertions in src/test/table.test.ts are differential,
 * not self-referential. As the driver plays, it maintains -- from the TypeScript mirrors and
 * api/src/rules.ts alone, never from the ledger -- the game digest, the mixed entropy, the
 * three rolls of every turn, and each seat's reference scorecard and grand total. Every one is
 * compared against what the chain says. A circuit that agrees with itself proves nothing; a
 * circuit that agrees with a reference written from the same design by different means is
 * evidence.
 *
 * That is also why the replay uses api/src/rules.ts for scoring rather than the contract's own
 * `pureCircuits`. api/src/rules.ts is contract-canonical: if the two disagree, the circuit is
 * wrong.
 *
 * The driver deliberately does NOT try to play well. Category choice is "the lowest-indexed
 * category the reference rules will accept", which is both deterministic and, because
 * api/src/rules.ts throws `RuleViolation` on an illegal placement, automatically correct about
 * forced-joker placement -- the hardest rule to get right and the one no fixed schedule of
 * categories would exercise.
 */

import assert from 'node:assert/strict';
import {
  applyScore as refApplyScore,
  CATEGORY_COUNT,
  type Category,
  type Dice as RefDice,
  emptyScorecard as refEmptyScorecard,
  grandTotal as refGrandTotal,
  isYahtzee as refIsYahtzee,
  RuleViolation,
  type Scorecard as RefScorecard,
  // Relative rather than '@yahtzee/api/src/rules.ts': api's package.json `exports` map
  // publishes only '.' and './node', so the package specifier does not resolve and the file
  // fails to load. Same reason and same note as src/test/scoring.test.ts.
} from '../../../api/src/rules.ts';
import {
  entropyKeyCommitmentTs,
  forcedEntropyTs,
  mixEntropyTs,
  Policy,
  resolveDiceTs,
  seedCommitmentTs,
} from '../policy-mirror.ts';
import { genesisDigestTs, joinDigestTs, resolveDigestTs } from '../table-mirror.ts';
import {
  DEFAULT_BLOCK_TIME,
  diceToArray,
  TableSimulator,
  userAddress,
  type TableConfig,
  type UserAddress,
} from './simulator.ts';
import { POLICY_NONE } from '../policy-mirror.ts';

/** Rounds per seat: 0..13. Round 13 scores and does not roll. */
export const ROUND_COUNT = 14;

/** The last round -- score-only. */
export const LAST_ROUND = 13;

/** Seconds the harness advances the clock per transaction. Well inside every timeout used. */
export const TICK = 10;

/** One seated player: the secret that authorises its turns, and where it gets paid. */
export type Player = {
  sk: Uint8Array;
  addr: UserAddress;
};

/** A 32-byte value from a single repeated byte. Readable, distinct test material. */
export function bytes32(fill: number): Uint8Array {
  return new Uint8Array(32).fill(fill);
}

/** `n` players with distinguishable secrets and payout addresses. */
export function makePlayers(n: number): Player[] {
  return Array.from({ length: n }, (_, i) => ({
    sk: bytes32(0x40 + i),
    addr: userAddress(0x80 + i),
  }));
}

export type TableOptions = {
  seats: number;
  tier?: bigint;
  tableId?: Uint8Array;
  seed?: Uint8Array;
  /** Override the committed hash to make `resolveTurn`/`settle` unopenable. */
  seedCommitment?: Uint8Array;
  turnTimeoutSecs?: bigint;
  tableTimeoutSecs?: bigint;
  rakeAddress?: UserAddress;
};

export function tableConfig(opts: TableOptions): TableConfig {
  const seed = opts.seed ?? bytes32(0x11);
  return {
    tableId: opts.tableId ?? bytes32(0x22),
    // 1_000_000 is divisible by 100, so `r == 0`; the remainder-to-winner path is exercised
    // separately with a tier that is not.
    tier: opts.tier ?? 1_000_000n,
    seats: BigInt(opts.seats),
    rakeAddress: opts.rakeAddress ?? userAddress(0xee),
    seed,
    seedCommitment: opts.seedCommitment ?? seedCommitmentTs(seed),
    turnTimeoutSecs: opts.turnTimeoutSecs ?? 300n,
    tableTimeoutSecs: opts.tableTimeoutSecs ?? 3_600n,
  };
}

/** The hold-policy choice for one turn. */
export type PolicyChoice = { policy: number; param: number };

/**
 * A schedule that walks every shipped policy, per seat and per round.
 *
 * Rotating rather than random so a failure names a specific (seat, round, policy) triple, and
 * offset by seat so two seats in the same round exercise different masks -- which is the
 * combination that would catch a mask latched from the wrong seat's roll.
 */
export function mixedPolicy(seat: number, round: number): PolicyChoice {
  const cycle = [
    { policy: Policy.Stand, param: 0 },
    { policy: Policy.RerollAll, param: 0 },
    { policy: Policy.KeepModal, param: 0 },
    { policy: Policy.KeepFace, param: ((seat + round) % 6) + 1 },
    { policy: Policy.ChaseStraight, param: 0 },
    { policy: Policy.KeepPairsPlus, param: 0 },
  ];
  return cycle[(seat + round) % cycle.length]!;
}

/** Everything the replay knows about one seat. */
type SeatReplay = {
  card: RefScorecard;
  /** Dice resolved last round, awaiting a category. */
  pendingDice: number[] | undefined;
  /** Turn index at which the 13th category was taken, or undefined. */
  finishedAtTurn: number | undefined;
  forfeited: boolean;
};

/** One resolved turn, as the replay reconstructed it. */
export type TurnRecord = {
  seat: number;
  round: number;
  turnIndex: number;
  policy: number;
  param: number;
  entropy: Uint8Array;
  mixed: Uint8Array;
  /** Digest as it stood BEFORE this resolution -- the one the roll hash consumed. */
  digestBefore: Uint8Array;
  rolls: { roll0: number[]; roll1: number[]; roll2: number[] };
  hold: boolean[];
  modal: number;
  dice: number[];
};

/**
 * Plays a table and replays it at the same time.
 *
 * Every method asserts the chain against the replay as it goes, so a divergence is reported at
 * the turn that caused it rather than at the end of the game.
 */
export class GameDriver {
  sim: TableSimulator;
  config: TableConfig;
  players: Player[];
  clock: number;

  /**
   * The same plan `replayGame` takes, so on-chain play and offline replay are driven by ONE
   * description of the game. If they were configured separately, a divergence between them
   * would be a test bug rather than a contract bug, which is the wrong failure to have.
   */
  plan: GamePlan;

  /** The replay's own digest chain. Never read from the ledger. */
  digest: Uint8Array;
  seats: SeatReplay[];
  turns: TurnRecord[] = [];

  /** Illegal placements the chain refused. Asserted non-zero where a test relies on them. */
  illegalProbes = 0;
  /** Of those, ones in a joker situation -- the forced-placement rule under test. */
  jokerProbes = 0;

  constructor(
    sim: TableSimulator,
    config: TableConfig,
    players: Player[],
    clock: number,
    plan: GamePlan = {},
  ) {
    this.sim = sim;
    this.config = config;
    this.players = players;
    this.clock = clock;
    this.plan = plan;
    this.digest = genesisDigestTs(config.tableId);
    this.seats = players.map(() => ({
      card: refEmptyScorecard(),
      pendingDice: undefined,
      finishedAtTurn: undefined,
      forfeited: false,
    }));
  }

  static async open(
    opts: TableOptions,
    plan: GamePlan = {},
    startAt = DEFAULT_BLOCK_TIME,
  ): Promise<GameDriver> {
    const config = tableConfig(opts);
    const players = makePlayers(opts.seats);
    const sim = await TableSimulator.create(config, startAt);
    return new GameDriver(sim, config, players, startAt, plan);
  }

  /** The offline replay of the game this driver is playing. */
  replay(): ReplayResult {
    return replayGame(this.config, this.players, this.plan);
  }

  /** Advance the harness clock by one tick and return the new time. */
  tick(): number {
    this.clock += TICK;
    return this.clock;
  }

  ledger() {
    return this.sim.getLedger();
  }

  /** Seat every player, asserting the phase flip and the digest chain as it goes. */
  async joinAll(): Promise<void> {
    for (let seat = 0; seat < this.players.length; seat++) {
      await this.join(seat);
    }
  }

  async join(seat: number): Promise<void> {
    const player = this.players[seat]!;
    this.sim.asPlayer(player.sk);
    const at = this.tick();
    const returned = await this.sim.join(player.addr, at);
    assert.equal(returned, BigInt(seat), `join returned the wrong seat index`);

    this.digest = joinDigestTs(
      this.digest,
      seat,
      player.addr.bytes,
      entropyKeyCommitmentTs(player.sk),
    );
    const led = this.ledger();
    assert.deepEqual(led.gameDigest, this.digest, `gameDigest diverged after seat ${seat} joined`);
    assert.equal(led.seatCount, BigInt(seat + 1));
    assert.equal(led.pot, this.config.tier * BigInt(seat + 1), 'pot must be tier x seatCount');
  }

  /** Seats the REPLAY believes can still move. The ledger's cursor is the authority. */
  activeSeats(): number[] {
    return this.seats.flatMap((s, i) => (s.forfeited ? [] : [i]));
  }

  /**
   * The category this seat should take for `dice`: the lowest-indexed one the reference rules
   * accept.
   *
   * Delegating legality to `refApplyScore`'s exceptions is what makes the driver exercise
   * forced-joker placement without knowing the rule: in a joker situation the reference throws
   * on every category but the legal ones, so the first survivor IS the forced box.
   */
  chooseCategory(seat: number, dice: number[]): number {
    return chooseCategoryFor(this.seats[seat]!.card, dice, this.plan.strategy ?? 'firstLegal');
  }

  /**
   * A category the reference rules REFUSE for these dice, or undefined if every box is legal.
   *
   * On an empty card with ordinary dice there is no such category, so this returns undefined
   * and nothing is probed; once one box is filled -- or the moment a joker forces a placement
   * -- there always is one.
   */
  firstIllegalCategory(seat: number, dice: number[]): number | undefined {
    const card = this.seats[seat]!.card;
    for (let cat = 0; cat < CATEGORY_COUNT; cat++) {
      try {
        refApplyScore(card, cat as Category, dice as unknown as RefDice);
      } catch (e) {
        if (!(e instanceof RuleViolation)) throw e;
        return cat;
      }
    }
    return undefined;
  }

  /** Ask the chain to accept a placement the reference rules forbid, and require a refusal. */
  async probeIllegalPlacement(
    seat: number,
    round: number,
    dice: number[],
    entropy: Uint8Array,
    choice: PolicyChoice,
  ): Promise<void> {
    const illegal = this.firstIllegalCategory(seat, dice);
    if (illegal === undefined) return;
    const when = this.clock + 1;
    await assert.rejects(
      () => this.sim.takeTurn(entropy, choice.policy, choice.param, illegal, when),
      /illegal placement/,
      `chain accepted category ${illegal} which api/src/rules.ts refuses ` +
        `(seat ${seat}, round ${round}, dice ${dice.join(',')})`,
    );
    this.illegalProbes += 1;
    if (refIsYahtzee(dice as unknown as RefDice) && this.seats[seat]!.card.scores[11] !== null) {
      this.jokerProbes += 1;
    }
  }

  /**
   * One `takeTurn`: score last round's dice, declare this round's entropy and policy.
   *
   * `policyOverride` lets a test pin a specific policy; by default the schedule walks all six.
   */
  async takeTurn(seat: number, round: number, policyOverride?: PolicyChoice): Promise<void> {
    const player = this.players[seat]!;
    const replay = this.seats[seat]!;
    const led = this.ledger();
    assert.equal(led.currentSeat, BigInt(seat), `expected seat ${seat} to be on turn`);
    assert.equal(led.round, BigInt(round), `expected round ${round}`);

    const rolling = round < LAST_ROUND;
    const schedule = this.plan.policyFor ?? mixedPolicy;
    const choice = rolling
      ? (policyOverride ?? schedule(seat, round))
      : { policy: POLICY_NONE, param: 0 };
    const entropy = forcedEntropyTs(player.sk, this.config.tableId, round);

    // Category for the PREVIOUS round's dice. Round 0 has none, and its canonical encoding is
    // 0 -- which the circuit checks, so passing anything else must fail.
    let category = 0;
    if (round > 0) {
      const dice = replay.pendingDice;
      assert.ok(dice !== undefined, `seat ${seat} has no pending dice at round ${round}`);
      category = this.chooseCategory(seat, dice);
    }

    const turnIndexBefore = Number(led.turnIndex);
    this.sim.asPlayer(player.sk);
    if (round > 0 && this.plan.probeIllegal === true) {
      await this.probeIllegalPlacement(seat, round, replay.pendingDice!, entropy, choice);
    }
    await this.sim.takeTurn(entropy, choice.policy, choice.param, category, this.tick());

    if (round > 0) {
      const dice = replay.pendingDice!;
      replay.card = refApplyScore(replay.card, category as Category, dice as unknown as RefDice);
      replay.pendingDice = undefined;
      const after = this.ledger();
      const prog = after.seatProgress.lookup(BigInt(seat));
      assert.equal(
        prog.total,
        BigInt(refGrandTotal(replay.card)),
        `seat ${seat} total diverged from api/src/rules.ts at round ${round}`,
      );
      assert.equal(prog.hasDice, false, 'scored dice must be consumed');
      // The scorecard the chain holds must match the reference box for box, with the
      // circuit's filled/score split standing in for the reference's `number | null`.
      const card = after.seatCard.lookup(BigInt(seat));
      for (let cat = 0; cat < CATEGORY_COUNT; cat++) {
        const ref = replay.card.scores[cat];
        assert.equal(card.filled[cat], ref !== null, `seat ${seat} filled[${cat}] diverged`);
        assert.equal(card.scores[cat], BigInt(ref ?? 0), `seat ${seat} scores[${cat}] diverged`);
      }
      if (!rolling) {
        replay.finishedAtTurn = turnIndexBefore;
        assert.equal(
          prog.finishedAtTurn,
          BigInt(turnIndexBefore),
          `seat ${seat} finishedAtTurn must be the turn that completed the card`,
        );
      }
    }

    if (rolling) {
      const after = this.ledger();
      assert.equal(after.turnState, 1, 'a rolling round must hand over to the operator');
      assert.deepEqual(after.pendingEntropy, entropy);
      assert.equal(after.pendingPolicy, BigInt(choice.policy));
      assert.equal(after.pendingParam, BigInt(choice.param));
    }
  }

  /**
   * One `resolveTurn`: derive the dice and check every intermediate against the replay.
   *
   * The digest folded into the roll hash is the one from BEFORE this call, which is exactly
   * what a verifier replaying the log has at this point. Getting that ordering wrong is the
   * easiest way to produce an unverifiable game, so it is asserted rather than assumed.
   */
  async resolveTurn(seat: number, round: number): Promise<number[]> {
    const before = this.ledger();
    assert.equal(before.turnState, 1, 'resolveTurn needs WaitResolve');
    assert.equal(before.currentSeat, BigInt(seat));
    assert.equal(before.round, BigInt(round));

    const player = this.players[seat]!;
    const entropy = forcedEntropyTs(player.sk, this.config.tableId, round);
    const digestBefore = this.digest;
    const mixed = mixEntropyTs(entropy, digestBefore);
    const policy = Number(before.pendingPolicy);
    const param = Number(before.pendingParam);
    const turnIndex = Number(before.turnIndex);

    const expected = resolveDiceTs(
      this.config.tableId,
      this.config.seed,
      mixed,
      round,
      policy,
      param,
    );

    this.sim.asOperator();
    const dice = diceToArray(await this.sim.resolveTurn(this.tick()));

    assert.deepEqual(
      dice,
      expected.roll2,
      `dice diverged from the mirror at seat ${seat} round ${round} policy ${policy}/${param}`,
    );
    for (const d of dice) assert.ok(d >= 1 && d <= 6, `die out of range: ${d}`);

    this.digest = resolveDigestTs(
      digestBefore,
      turnIndex,
      seat,
      round,
      policy,
      param,
      entropy,
      dice,
    );
    const after = this.ledger();
    assert.deepEqual(
      after.gameDigest,
      this.digest,
      `gameDigest diverged after seat ${seat} round ${round}`,
    );
    assert.equal(after.turnState, 0, 'resolveTurn must hand back to a player');
    assert.deepEqual(diceToArray(after.seatProgress.lookup(BigInt(seat)).dice), dice);
    assert.equal(after.seatProgress.lookup(BigInt(seat)).hasDice, true);

    this.seats[seat]!.pendingDice = dice;
    this.turns.push({
      seat,
      round,
      turnIndex,
      policy,
      param,
      entropy,
      mixed,
      digestBefore,
      rolls: { roll0: expected.roll0, roll1: expected.roll1, roll2: expected.roll2 },
      hold: expected.hold,
      modal: expected.modal,
      dice,
    });
    return dice;
  }

  /** takeTurn plus, for a rolling round, the operator's resolve. */
  async playTurn(seat: number, round: number, policyOverride?: PolicyChoice): Promise<void> {
    await this.takeTurn(seat, round, policyOverride);
    if (round < LAST_ROUND) await this.resolveTurn(seat, round);
  }

  /** Is this seat scheduled to be timed out instead of playing this round? */
  plannedForfeit(seat: number, round: number): boolean {
    return (this.plan.forfeits ?? []).some((f) => f.seat === seat && f.round === round);
  }

  /**
   * Time out whoever is on turn, at the first second past their deadline.
   *
   * The clock JUMPS to `lastActionAt + turnTimeoutSecs + 1` rather than ticking, because that
   * is the earliest moment the claim is legal and the tightest test of the predicate: one
   * second earlier must fail, which `claimTimeoutTooEarly` checks separately.
   *
   * `now` and the block time are passed equal -- the honest case. Any private state will do:
   * `claimTimeout` is permissionless, needs no secret, and reads nothing but ledger state.
   */
  async claimTimeoutNow(): Promise<bigint> {
    const led = this.ledger();
    const seat = Number(led.currentSeat);
    this.clock = Number(led.lastActionAt + led.turnTimeoutSecs) + 1;
    const remaining = await this.sim.claimTimeout(this.clock);

    this.markForfeited(seat);
    const after = this.ledger();
    assert.equal(after.seatProgress.lookup(BigInt(seat)).forfeited, true);
    assert.equal(
      after.seatProgress.lookup(BigInt(seat)).finishedAtTurn,
      65535n,
      'a forfeited seat must carry the never-finished sentinel',
    );
    assert.equal(after.activeSeats, remaining);
    return remaining;
  }

  /**
   * Play until the round changes, the game ends, or the table is abandoned.
   *
   * Driven from the LEDGER's cursor rather than from a precomputed seat list, so a forfeit
   * mid-round is handled by the contract's own skip logic and the harness cannot paper over a
   * cursor bug by iterating the seats it expected.
   */
  async playRound(round: number): Promise<void> {
    for (;;) {
      const led = this.ledger();
      if (led.phase !== 1) return;
      if (Number(led.round) !== round) return;
      const seat = Number(led.currentSeat);
      if (this.plannedForfeit(seat, round)) await this.claimTimeoutNow();
      else await this.playTurn(seat, round);
    }
  }

  /** Play to the end of the game, or until the table is abandoned. */
  async playToEnd(): Promise<void> {
    for (;;) {
      const led = this.ledger();
      if (led.phase !== 1) return;
      if (Number(led.round) >= ROUND_COUNT) return;
      await this.playRound(Number(led.round));
    }
  }

  /** Mark a seat forfeited in the replay, mirroring what `claimTimeout` did on-chain. */
  markForfeited(seat: number): void {
    this.seats[seat]!.forfeited = true;
    this.seats[seat]!.finishedAtTurn = undefined;
  }

  /** The reference grand total per seat. Forfeited seats keep what they scored. */
  totals(): number[] {
    return this.seats.map((s) => refGrandTotal(s.card));
  }

  /**
   * The winner the reference tie-break picks: highest total, then earliest finisher, then
   * lowest seat.
   *
   * Written out here rather than calling api's `winnerSeat` because the harness has to model
   * the never-finished sentinel the same way the ledger does, and doing that conversion at the
   * call site is where an off-by-one would hide.
   */
  expectedWinner(): number {
    const totals = this.totals();
    const finished = this.seats.map((s) => s.finishedAtTurn ?? Number.POSITIVE_INFINITY);
    let win = 0;
    for (let seat = 1; seat < totals.length; seat++) {
      if (
        totals[seat]! > totals[win]! ||
        (totals[seat] === totals[win] && finished[seat]! < finished[win]!)
      ) {
        win = seat;
      }
    }
    return win;
  }

  /** `[q, r]` for the current pot, as `splitPot` requires them. */
  rakeSplit(): [bigint, bigint] {
    const pot = this.ledger().pot;
    return [pot / 100n, pot % 100n];
  }
}

// ---------------------------------------------------------------------------------------
// Offline replay -- the settlement verifier
// ---------------------------------------------------------------------------------------

/**
 * Category strategies. Both are deterministic; neither consults the ledger.
 *
 * `firstLegal` takes the lowest-indexed category the reference rules accept. `bestScore` takes
 * the legal category that maximises the resulting grand total, which produces realistic
 * scorecards -- upper bonuses, Yahtzee bonuses, the occasional scratch -- and so exercises
 * `totalAfterPlacing`'s bonus arithmetic far harder.
 */
export type Strategy = 'firstLegal' | 'bestScore';

/** The category `strategy` picks for `dice` against `card`, or throws if none is legal. */
export function chooseCategoryFor(card: RefScorecard, dice: number[], strategy: Strategy): number {
  let best = -1;
  let bestTotal = -1;
  for (let cat = 0; cat < CATEGORY_COUNT; cat++) {
    let after: RefScorecard;
    try {
      after = refApplyScore(card, cat as Category, dice as unknown as RefDice);
    } catch (e) {
      if (!(e instanceof RuleViolation)) throw e;
      continue;
    }
    if (strategy === 'firstLegal') return cat;
    const total = refGrandTotal(after);
    if (total > bestTotal) {
      bestTotal = total;
      best = cat;
    }
  }
  if (best < 0) throw new Error(`no legal category for ${dice.join(',')}`);
  return best;
}

/** "Forfeit this seat when it is its turn at this round" -- what `claimTimeout` does. */
export type ForfeitAt = { seat: number; round: number };

export type GamePlan = {
  strategy?: Strategy;
  forfeits?: ForfeitAt[];
  policyFor?: (seat: number, round: number) => PolicyChoice;
  /**
   * Before each real scoring move, attempt an ILLEGAL category and require the chain to
   * reject it.
   *
   * Turns the happy path into continuous negative testing at no extra design cost: the
   * reference rules already know which categories are illegal, and in a joker situation the
   * illegal set is exactly what forced placement forbids. A rejected circuit call leaves the
   * simulator untouched -- `run` commits state only on success -- so probing is free of
   * side effects. Ignored by `replayGame`, which has no chain to reject anything.
   */
  probeIllegal?: boolean;
};

export type ReplayResult = {
  totals: number[];
  /** `undefined` where the seat never completed its card -- the ledger's `noFinish()`. */
  finishedAtTurn: (number | undefined)[];
  forfeited: boolean[];
  cards: RefScorecard[];
  digest: Uint8Array;
  turnIndex: number;
  round: number;
  /** True where every seat forfeited, so the table reached `abandoned`. */
  abandoned: boolean;
  turns: TurnRecord[];
};

/**
 * Mirror of `nextCursor` in table.compact: one position forward, then skip forfeited seats.
 *
 * Written as a loop where the circuit writes six unrolled steps, because the circuit has no
 * loops and this has no reason not to. They agree because the circuit's six steps cover six
 * candidate positions, which is every seat of a full table.
 */
function nextCursorTs(
  seat: number,
  round: number,
  seatCount: number,
  forfeited: boolean[],
): { seat: number; round: number } {
  let s = seat;
  let r = round;
  for (let step = 0; step < seatCount + 1; step++) {
    const n = s + 1;
    if (n >= seatCount) {
      s = 0;
      r += 1;
    } else {
      s = n;
    }
    if (s < seatCount && !forfeited[s]) return { seat: s, round: r };
  }
  return { seat: s, round: r };
}

/**
 * Replay a whole game from public data alone -- THE thing a settlement verifier does.
 *
 * Given the table's constructor arguments, the seats' secrets (equivalently, the entropies
 * they published) and the operator's revealed seed, this reproduces every roll, every digest
 * and every score with no chain access and no proof server. src/test/table.test.ts asserts it
 * matches the chain move for move over a full game, which is the property the whole
 * "verify this game" panel rests on.
 *
 * It is also how tie-break scenarios are found: a tie between two seats cannot be arranged by
 * hand because every die comes out of a hash, so the tie tests search here -- in milliseconds
 * per game -- and then play the single game that ties through the real circuits.
 */
export function replayGame(
  config: TableConfig,
  players: Player[],
  plan: GamePlan = {},
): ReplayResult {
  const strategy = plan.strategy ?? 'firstLegal';
  const policyFor = plan.policyFor ?? mixedPolicy;
  const seatCount = players.length;
  const forfeitKeys = new Set((plan.forfeits ?? []).map((f) => `${f.seat}:${f.round}`));

  let digest = genesisDigestTs(config.tableId);
  for (let seat = 0; seat < seatCount; seat++) {
    digest = joinDigestTs(
      digest,
      seat,
      players[seat]!.addr.bytes,
      entropyKeyCommitmentTs(players[seat]!.sk),
    );
  }

  const cards = players.map(() => refEmptyScorecard());
  const pending: (number[] | undefined)[] = players.map(() => undefined);
  const finishedAtTurn: (number | undefined)[] = players.map(() => undefined);
  const forfeited = players.map(() => false);
  const turns: TurnRecord[] = [];

  let seat = 0;
  let round = 0;
  let turnIndex = 0;
  let active = seatCount;
  let abandoned = false;

  const advance = (): void => {
    const c = nextCursorTs(seat, round, seatCount, forfeited);
    seat = c.seat;
    round = c.round;
    turnIndex += 1;
  };

  while (round < ROUND_COUNT && !abandoned) {
    if (forfeitKeys.has(`${seat}:${round}`)) {
      forfeited[seat] = true;
      finishedAtTurn[seat] = undefined;
      active -= 1;
      if (active === 0) {
        abandoned = true;
        break;
      }
      advance();
      continue;
    }

    if (round > 0) {
      const dice = pending[seat];
      if (dice === undefined) throw new Error(`seat ${seat} has no dice at round ${round}`);
      const category = chooseCategoryFor(cards[seat]!, dice, strategy);
      cards[seat] = refApplyScore(cards[seat]!, category as Category, dice as unknown as RefDice);
      pending[seat] = undefined;
    }

    if (round === LAST_ROUND) {
      finishedAtTurn[seat] = turnIndex;
      advance();
      continue;
    }

    const player = players[seat]!;
    const entropy = forcedEntropyTs(player.sk, config.tableId, round);
    const mixed = mixEntropyTs(entropy, digest);
    const choice = policyFor(seat, round);
    const resolved = resolveDiceTs(
      config.tableId,
      config.seed,
      mixed,
      round,
      choice.policy,
      choice.param,
    );
    turns.push({
      seat,
      round,
      turnIndex,
      policy: choice.policy,
      param: choice.param,
      entropy,
      mixed,
      digestBefore: digest,
      rolls: { roll0: resolved.roll0, roll1: resolved.roll1, roll2: resolved.roll2 },
      hold: resolved.hold,
      modal: resolved.modal,
      dice: resolved.roll2,
    });
    digest = resolveDigestTs(
      digest,
      turnIndex,
      seat,
      round,
      choice.policy,
      choice.param,
      entropy,
      resolved.roll2,
    );
    pending[seat] = resolved.roll2;
    advance();
  }

  return {
    totals: cards.map((c) => refGrandTotal(c)),
    finishedAtTurn,
    forfeited,
    cards,
    digest,
    turnIndex,
    round,
    abandoned,
    turns,
  };
}
