// Copyright (C) Shielded Technologies
// SPDX-License-Identifier: Apache-2.0

/**
 * A driver for playing whole games of Yahtzee through `TableSimulator`, and an INDEPENDENT
 * replay of every game it plays.
 *
 * The point of the replay is that the assertions in src/test/table.test.ts are differential,
 * not self-referential. As the driver plays, it maintains -- from the TypeScript mirrors and
 * api/src/rules.ts alone, never from the ledger -- the round digest, each seat's mixed entropy,
 * every roll of every turn, and each seat's reference scorecard and grand total. Every one is
 * compared against what the chain says. A circuit that agrees with itself proves nothing; a
 * circuit that agrees with a reference written from the same design by different means is
 * evidence.
 *
 * That is also why the replay uses api/src/rules.ts for scoring rather than the contract's own
 * `pureCircuits`. api/src/rules.ts is contract-canonical: if the two disagree, the circuit is
 * wrong.
 *
 * -------------------------------------------------------------------------------------------
 * WHAT THE TWO REDESIGNS CHANGED HERE
 * -------------------------------------------------------------------------------------------
 *
 * SIMULTANEOUS ROUNDS removed the cursor. The old driver read `currentSeat` off the ledger,
 * played that seat, and repeated. A round is now "every seat that can move, moves, in whatever
 * order, then somebody calls `closeRound`", so the driver takes a SUBMISSION ORDER per round
 * and the replay takes none -- because the digest fold is by seat index, the two must agree
 * whatever order the driver used. `GamePlan.orderFor` exists so a test can shuffle that order
 * and assert exactly that.
 *
 * INTERACTIVE HOLDS removed the policy schedule and made turns different LENGTHS. A turn is
 * open, roll 1, and then either a score or a hold and another roll, twice over. `GamePlan.holds`
 * is a dice-aware chooser that decides, after each roll, whether to keep some dice and roll
 * again or to stop and score -- and that alone decides how many transactions the turn takes.
 *
 * The clock is per round rather than per move. `closeRound` stamps the deadline every seat in
 * the NEXT round is judged against, and nothing else stamps anything, so the harness ticks
 * freely inside a round and only jumps the clock when a test wants an elimination.
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
  // Relative rather than '@dust-dice/api/src/rules.ts': api's package.json `exports` map
  // publishes only '.' and './node', so the package specifier does not resolve and the file
  // fails to load. Same reason and same note as src/test/scoring.test.ts.
} from '../../../api/src/rules.ts';
import {
  entropyKeyCommitmentTs,
  firstRollTs,
  forcedEntropyTs,
  mixEntropyTs,
  modalFace,
  rerollUnderMaskTs,
  seedCommitmentTs,
} from '../policy-mirror.ts';
import {
  emptyRoundResult,
  genesisDigestTs,
  joinDigestTs,
  roundDigestTs,
  type RoundResultTs,
} from '../table-mirror.ts';
import {
  DEFAULT_BLOCK_TIME,
  diceToArray,
  TableSimulator,
  userAddress,
  type TableConfig,
  type UserAddress,
} from './simulator.ts';

/** Rounds per seat: 0..12, thirteen in total, one category each. */
export const ROUND_COUNT = 13;

/** The last round a seat plays. Completing it completes the scorecard. */
export const FINAL_ROUND = 12;

/** The penalty denominator: `stake * (round + 1) / 13`. */
export const PENALTY_DENOM = 13n;

/** Maximum seats. Every round digest folds all six slots, occupied or not. */
export const MAX_SEATS = 6;

/** Seconds the harness advances the clock per transaction. Well inside every timeout used. */
export const TICK = 10;

/**
 * `seatTurn.stage`, as table.compact numbers it.
 *
 * Even stages are owed by the PLAYER and odd stages by the OPERATOR, which is the split
 * `eliminate` and `abortTable` divide on.
 */
export const STAGE = {
  idle: 0,
  awaitRoll1: 1,
  rolled1: 2,
  awaitRoll2: 3,
  rolled2: 4,
  awaitRoll3: 5,
  rolled3: 6,
} as const;

/**
 * `Phase` as the contract numbers it.
 *
 * Compare with `===` against a plain number, NOT a bigint: the generated bindings represent a
 * Compact `enum` with `CompactTypeEnum`, whose TypeScript type is `number`, while every
 * `Uint<N>` ledger field comes back as a `bigint`. A `phase !== BigInt(PHASE.playing)` reads
 * perfectly and is always true.
 */
export const PHASE = {
  filling: 0,
  playing: 1,
  settled: 2,
  aborted: 3,
  abandoned: 4,
} as const;

/** One seated player: the secret that authorises its moves, and where it gets paid. */
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
  /** Override the committed hash to make the resolves and `settle` unopenable. */
  seedCommitment?: Uint8Array;
  turnTimeoutSecs?: bigint;
  tableTimeoutSecs?: bigint;
  rakeAddress?: UserAddress;
  /** Deploy the table in fast mode (defaults to the on-chain interactive mode). */
  fastMode?: boolean;
  /** Early-start wait after the last join. Defaults to 0 = disabled, so existing tests hold. */
  startAfterSecs?: bigint;
  /** Seal an invite commitment to make the table private. Defaults to public. */
  inviteHash?: Uint8Array;
};

export function tableConfig(opts: TableOptions): TableConfig {
  const seed = opts.seed ?? bytes32(0x11);
  const tableId = opts.tableId ?? bytes32(0x22);
  return {
    tableId,
    // 1_000_000 is divisible by 100, so the rake remainder is 0; the remainder-to-winner path is
    // exercised separately with a tier that is not.
    tier: opts.tier ?? 1_000_000n,
    seats: BigInt(opts.seats),
    rakeAddress: opts.rakeAddress ?? userAddress(0xee),
    seed,
    seedCommitment: opts.seedCommitment ?? seedCommitmentTs(tableId, seed),
    // Both defaults must clear the constructor's floor of `timeSlackSecs() * 2` = 240 s, and
    // must also cover a whole round: six seats x up to seven transactions each, at TICK apart.
    // Anything at or below the floor is refused at construction, which is itself covered by a
    // test.
    turnTimeoutSecs: opts.turnTimeoutSecs ?? 3_600n,
    tableTimeoutSecs: opts.tableTimeoutSecs ?? 7_200n,
    fastMode: opts.fastMode ?? false,
    startAfterSecs: opts.startAfterSecs ?? 0n,
    inviteHash: opts.inviteHash ?? new Uint8Array(32),
  };
}

/** A hold mask: true = keep this die, false = reroll it. */
export type Mask = boolean[];

/** Keep nothing. The canonical "reroll everything". */
export const REROLL_ALL = (): Mask => [false, false, false, false, false];

/** Keep everything. A legal but pointless hold -- the player would score instead. */
export const KEEP_ALL = (): Mask => [true, true, true, true, true];

/**
 * The masks a schedule walks.
 *
 * The NON-PREFIX entries are the load-bearing ones. Under the old positional merge every mask
 * behaved the same way; under the left-to-right stream merge, a mask whose held positions are
 * not a prefix is exactly where the two models diverge. `[true,false,true,false,true]` and
 * `[false,true,true,false,false]` are there to make a positional regression fail loudly.
 */
const MASKS: readonly Mask[] = [
  [false, false, false, false, false],
  [true, true, true, true, true],
  [true, false, true, false, true],
  [false, true, true, false, false],
  [true, true, false, false, false],
  [false, false, false, false, true],
];

/**
 * A player's decision after seeing a roll: keep these dice and roll again, or stop and score.
 *
 * DICE-AWARE, and it has to be. Under pre-declared policies a schedule could be a pure function
 * of (seat, round), because the player committed before any dice existed. An interactive turn is
 * the opposite -- the whole feature is that the choice is made after looking -- so a test plan
 * that could not see the dice could not express any realistic player at all, including the
 * modal-chasing one the joker tests need.
 *
 * `step` is 0 after roll 1 and 1 after roll 2. There is no chooser call after roll 3: the player
 * has no rolls left and must score.
 */
export type HoldChooser = (ctx: {
  seat: number;
  round: number;
  step: 0 | 1;
  dice: number[];
}) => Mask | 'score';

/**
 * The default schedule: rotate the turn LENGTH and the masks by (seat, round).
 *
 * Rotating rather than random so a failure names a specific (seat, round) pair, and offset by
 * seat so two seats in the same round exercise different masks -- the combination that would
 * catch a mask read from the wrong seat's cell, which under six live pipelines is a real
 * possibility rather than a structural impossibility.
 *
 * The turn length cycles 0, 1, 2 holds, so a third of all turns stop after roll 1 and the early
 * scoring path is exercised continuously rather than in one dedicated test.
 */
export const mixedHolds: HoldChooser = ({ seat, round, step }) => {
  const count = (seat + round) % 3;
  if (step >= count) return 'score';
  return [...MASKS[(seat + round + step) % MASKS.length]!];
};

/** Every turn goes the full distance. Used where a test needs all three rolls to happen. */
export const alwaysThreeRolls: HoldChooser = ({ seat, round, step }) => [
  ...MASKS[(seat + round + step) % MASKS.length]!,
];

/** Every turn stops after roll 1. The cheapest possible game: 2 player + 1 operator per turn. */
export const alwaysStopEarly: HoldChooser = () => 'score';

/**
 * Keep every die showing the modal face, and stop once the hand is five of a kind.
 *
 * The interactive equivalent of the old `KeepModal` policy, and the schedule the joker tests
 * need: chasing the modal face is what actually rolls five of a kind often enough for the
 * Yahtzee bonus and forced placement to be reached in a game of ordinary length.
 */
export const keepModal: HoldChooser = ({ dice }) => {
  if (new Set(dice).size === 1) return 'score';
  const m = modalFace(dice);
  return dice.map((d) => d === m);
};

/**
 * Walk a chooser to its conclusion against the MIRROR's dice, returning the whole turn.
 *
 * One description of a turn, used by both halves of every differential test: `GameDriver`
 * plans the turn here and then plays exactly that plan on chain, asserting each roll matches;
 * `replayGame` plans it here and never touches a chain at all. If the two planned separately, a
 * divergence between them would be a test bug rather than a contract bug.
 */
export function planTurn(
  config: TableConfig,
  mixed: Uint8Array,
  seat: number,
  round: number,
  chooser: HoldChooser,
): { holds: Mask[]; rolls: number[][]; final: number[] } {
  const holds: Mask[] = [];
  const rolls: number[][] = [firstRollTs(config.tableId, config.seed, mixed, round)];
  for (let step = 0; step < 2; step++) {
    const decision = chooser({ seat, round, step: step as 0 | 1, dice: rolls[step]! });
    if (decision === 'score') break;
    holds.push([...decision]);
    rolls.push(
      rerollUnderMaskTs(
        config.tableId,
        config.seed,
        mixed,
        round,
        step + 1,
        decision,
        rolls[step]!,
      ),
    );
  }
  return { holds, rolls, final: rolls[rolls.length - 1]! };
}

/** "Eliminate this seat at this round" -- the round it fails to move in. */
export type EliminateAt = { seat: number; round: number };

/**
 * The penalty split for a seat eliminated at `round`, as `eliminate` requires it.
 *
 * `round + 1` reconciles two numbering schemes: docs/simultaneous-rounds.md numbers the penalty
 * over rounds 1..13 and the contract numbers its thirteen rounds 0..12. A seat that never moves
 * at all forfeits a thirteenth; one that quits in the last round forfeits everything.
 */
export function penaltySplit(tier: bigint, round: number): { q: bigint; rem: bigint } {
  const numer = tier * BigInt(round + 1);
  return { q: numer / PENALTY_DENOM, rem: numer % PENALTY_DENOM };
}

/** The per-seat 1% rake on `tier`, as `abortTable` requires it. */
export function perSeatRake(tier: bigint): { q: bigint; rem: bigint } {
  return { q: tier / 100n, rem: tier % 100n };
}

/** Everything the replay knows about one seat. */
type SeatReplay = {
  card: RefScorecard;
  /** The dice the seat scored in its most recent turn -- what the round digest folds. */
  dice: number[];
  /** The round at which the 13th category was taken, or undefined. */
  finishedAtRound: number | undefined;
  eliminated: boolean;
  /** What the seat may withdraw once the table is terminal. */
  redeemable: bigint;
};

/** One turn, as the replay reconstructed it. */
export type TurnRecord = {
  seat: number;
  round: number;
  entropy: Uint8Array;
  mixed: Uint8Array;
  /** The round digest the roll hashes consumed -- frozen for every seat in the round. */
  digestBefore: Uint8Array;
  /** The masks the player sent, in order. Its length is how many rerolls the turn took. */
  holds: Mask[];
  /** Every roll the turn actually resolved: 1, 2 or 3 of them. */
  rolls: number[][];
  /** The dice the turn ended on. */
  dice: number[];
  category: number;
};

export type Strategy = 'firstLegal' | 'bestScore';

export type GamePlan = {
  strategy?: Strategy;
  /** Seats to knock out, and the round they fail to move in. */
  eliminations?: EliminateAt[];
  /** What the player does after each roll. Defaults to `mixedHolds`. */
  holds?: HoldChooser;
  /**
   * The order seats submit their moves in, within a round.
   *
   * Defaults to seat order. A test that wants to prove the digest is order-independent passes a
   * permutation here and compares the resulting ledger against a game played in seat order.
   * `replayGame` ignores it entirely, which is the point: the offline verifier does not know and
   * must not need to know what order the chain saw.
   */
  orderFor?: (round: number, seats: readonly number[]) => number[];
  /**
   * Before each real scoring move, attempt an ILLEGAL category and require the chain to reject
   * it.
   *
   * Turns the happy path into continuous negative testing at no extra design cost: the reference
   * rules already know which categories are illegal, and in a joker situation the illegal set is
   * exactly what forced placement forbids. A rejected circuit call leaves the simulator
   * untouched -- `run` commits state only on success -- so probing is free of side effects.
   */
  probeIllegal?: boolean;
};

/**
 * Plays a table and replays it at the same time.
 *
 * Every method asserts the chain against the replay as it goes, so a divergence is reported at
 * the move that caused it rather than at the end of the game.
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

  /** Player transactions sent, and operator transactions sent. The cost model, measured. */
  playerTx = 0;
  operatorTx = 0;

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
      dice: [1, 1, 1, 1, 1],
      finishedAtRound: undefined,
      eliminated: false,
      redeemable: 0n,
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

  /** The forced entropy for one seat at one round -- what an `open` must carry. */
  entropyFor(seat: number, round: number): Uint8Array {
    return forcedEntropyTs(this.players[seat]!.sk, this.config.tableId, round);
  }

  /** The chooser this game plays with. */
  chooser(): HoldChooser {
    return this.plan.holds ?? mixedHolds;
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
    const before = this.ledger();
    const at = this.tick();
    const returned = await this.sim.join(player.addr, at);
    this.playerTx += 1;
    assert.equal(returned, BigInt(seat), `join returned the wrong seat index`);

    this.digest = joinDigestTs(
      this.digest,
      seat,
      player.addr.bytes,
      entropyKeyCommitmentTs(this.config.tableId, player.sk),
    );
    const led = this.ledger();
    assert.deepEqual(
      led.roundDigest,
      this.digest,
      `roundDigest diverged after seat ${seat} joined`,
    );
    // Slots and active seats move by one each; they differ once a seat has left while filling.
    assert.equal(led.seatCount, before.seatCount + 1n);
    assert.equal(led.activeSeats, before.activeSeats + 1n);
    // The pot holds the ACTIVE players' stakes: a pre-start leaver took its own back.
    assert.equal(led.pot, before.pot + this.config.tier, 'a join adds exactly one stake');
    this.assertCustody();
  }

  /**
   * The custody invariant, read off the ledger.
   *
   * WHILE THE TABLE HOLDS THE MONEY -- filling, playing, or abandoned -- every atom it ever
   * received is still accounted for: `pot + SUM(redeemable) == tier * seatCount`. That is the
   * line the contract itself asserts in-circuit at `eliminate`, `settle` and `abortTable`.
   *
   * ONCE A TERMINAL CIRCUIT HAS RUN the equation no longer applies, because money has left: the
   * pot went to the winner and the rake, or was converted into per-seat refunds and then
   * withdrawn. What survives is the half that matters -- `pot` is zero, so everything the
   * contract still owes is somebody's own `redeemable` and nothing can be paid to the wrong
   * party. `assertFullyDrained` is the end-state check.
   *
   * The harness asserts this after EVERY move, which is the half a circuit cannot do for itself.
   * What neither can do is compare it against the contract's real unshielded balance --
   * `unshieldedBalance` is inert under the simulator (docs/bugs-found.md #11) -- so that half
   * lives in the E2E devnet run.
   */
  assertCustody(): void {
    const led = this.ledger();
    let owed = 0n;
    let paid = 0n;
    for (let s = 0; s < MAX_SEATS; s++) {
      owed += led.seatRedeemable.lookup(BigInt(s));
      paid += led.seatPaid.lookup(BigInt(s));
    }
    if (led.phase === PHASE.settled || led.phase === PHASE.aborted) {
      assert.equal(led.pot, 0n, 'a terminal table must hold no pot');
      return;
    }
    // `paidOut` is what `redeem` has already sent -- pre-start leavers may withdraw while the
    // table is still live, and their atoms are then neither in the pot nor owed.
    assert.equal(
      led.pot + owed + paid,
      this.config.tier * led.seatCount,
      'custody invariant: pot + redeemable + paid must equal tier x seatCount',
    );
  }

  /** Every obligation discharged: no pot, and nothing left for any seat to withdraw. */
  assertFullyDrained(): void {
    const led = this.ledger();
    assert.equal(led.pot, 0n, 'the pot must be empty');
    for (let s = 0; s < MAX_SEATS; s++) {
      assert.equal(led.seatRedeemable.lookup(BigInt(s)), 0n, `seat ${s} still has money to redeem`);
    }
  }

  /** Seats the REPLAY believes can still move, in seat order. */
  liveSeats(): number[] {
    return this.seats.flatMap((s, i) => (s.eliminated ? [] : [i]));
  }

  /**
   * The category this seat should take for `dice`: whatever the plan's strategy picks among the
   * ones the reference rules accept.
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
   * On an empty card with ordinary dice there is no such category, so this returns undefined and
   * nothing is probed; once one box is filled -- or the moment a joker forces a placement --
   * there always is one.
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
  async probeIllegalPlacement(seat: number, round: number, dice: number[]): Promise<void> {
    const illegal = this.firstIllegalCategory(seat, dice);
    if (illegal === undefined) return;
    this.sim.asPlayer(this.players[seat]!.sk);
    await assert.rejects(
      () => this.sim.score(seat, illegal, this.clock),
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
   * One whole turn for one seat: open, roll, hold and roll again as the plan says, then score.
   *
   * Both parties' transactions are here, in the order the chain sees them, because with
   * interactive holds they interleave -- the player cannot choose a hold before seeing the roll,
   * and the operator cannot roll before seeing the hold. Every intermediate is checked against
   * the mirror as it is produced.
   *
   * The digest folded into every roll hash is the OPEN ROUND's, frozen when the round opened.
   * Asserting the mirror against the chain here is what proves the freeze actually happened: if
   * the contract had kept folding per resolve, the second seat to be resolved in a round would
   * already disagree.
   */
  async playTurn(seat: number, round: number, chooserOverride?: HoldChooser): Promise<number[]> {
    const player = this.players[seat]!;
    const replay = this.seats[seat]!;

    const led = this.ledger();
    assert.equal(led.openRound, BigInt(round), `expected the table to be at round ${round}`);
    assert.equal(
      led.seatProgress.lookup(BigInt(seat)).round,
      BigInt(round),
      `expected seat ${seat} to still owe round ${round}`,
    );
    assert.equal(led.seatTurn.lookup(BigInt(seat)).stage, BigInt(STAGE.idle));

    const entropy = this.entropyFor(seat, round);
    const digestBefore = this.digest;
    const mixed = mixEntropyTs(entropy, digestBefore);
    // Plan the whole turn against the MIRROR first, then play exactly that plan on chain and
    // assert every roll matches. One description of the turn, two independent executions.
    const expected = planTurn(this.config, mixed, seat, round, chooserOverride ?? this.chooser());
    const holds = expected.holds;

    // ---- open ---------------------------------------------------------------------------
    this.sim.asPlayer(player.sk);
    assert.equal(await this.sim.openTurn(seat, entropy, this.tick()), BigInt(STAGE.awaitRoll1));
    this.playerTx += 1;
    let after = this.ledger();
    assert.equal(after.seatTurn.lookup(BigInt(seat)).round, BigInt(round));
    assert.deepEqual(after.seatTurn.lookup(BigInt(seat)).entropy, entropy);
    assert.equal(
      after.seatProgress.lookup(BigInt(seat)).round,
      BigInt(round),
      'opening a turn must NOT advance the round cursor -- only scoring does',
    );

    // ---- roll 1 -------------------------------------------------------------------------
    this.sim.asOperator();
    const rolls: number[][] = [];
    const roll0 = diceToArray(await this.sim.resolveRoll1(seat, this.tick()));
    this.operatorTx += 1;
    rolls.push(roll0);
    assert.deepEqual(roll0, expected.rolls[0], `roll 1 diverged at seat ${seat} round ${round}`);
    assert.deepEqual(
      this.ledger().seatTurn.lookup(BigInt(seat)).mixed,
      mixed,
      'resolveRoll1 must latch the mirror-computed mixed entropy',
    );
    assert.deepEqual(
      this.ledger().roundDigest,
      this.digest,
      'no resolve may move the round digest -- only closeRound does',
    );

    // ---- holds and rerolls --------------------------------------------------------------
    for (let i = 0; i < holds.length; i++) {
      this.sim.asPlayer(player.sk);
      const expectStage = i === 0 ? STAGE.awaitRoll2 : STAGE.awaitRoll3;
      assert.equal(await this.sim.hold(seat, holds[i]!, this.tick()), BigInt(expectStage));
      this.playerTx += 1;
      // The mask must land in the cell the NEXT roll reads, and only that one.
      const cell = this.ledger().seatTurn.lookup(BigInt(seat));
      assert.deepEqual(
        i === 0 ? cell.hold1.bits : cell.hold2.bits,
        holds[i],
        `hold ${i + 1} landed in the wrong cell`,
      );

      this.sim.asOperator();
      const rolled =
        i === 0
          ? diceToArray(await this.sim.resolveReroll(seat, this.tick()))
          : diceToArray(await this.sim.resolveReroll(seat, this.tick()));
      this.operatorTx += 1;
      rolls.push(rolled);
      assert.deepEqual(
        rolled,
        expected.rolls[i + 1],
        `roll ${i + 2} diverged at seat ${seat} round ${round}`,
      );
      // A held die must survive the reroll untouched -- the property the mask exists for.
      const previous = rolls[rolls.length - 2]!;
      for (let d = 0; d < 5; d++) {
        if (holds[i]![d] === true) {
          assert.equal(rolled[d], previous[d], `held die ${d} changed on roll ${i + 2}`);
        }
      }
    }

    const dice = rolls[rolls.length - 1]!;
    assert.deepEqual(dice, expected.final, 'the turn ended on the wrong dice');
    for (const d of dice) assert.ok(d >= 1 && d <= 6, `die out of range: ${d}`);

    // ---- score --------------------------------------------------------------------------
    if (this.plan.probeIllegal === true) await this.probeIllegalPlacement(seat, round, dice);

    const category = this.chooseCategory(seat, dice);
    this.sim.asPlayer(player.sk);
    assert.equal(await this.sim.score(seat, category, this.tick()), BigInt(STAGE.idle));
    this.playerTx += 1;

    replay.card = refApplyScore(replay.card, category as Category, dice as unknown as RefDice);
    replay.dice = dice;

    after = this.ledger();
    const prog = after.seatProgress.lookup(BigInt(seat));
    assert.equal(
      prog.total,
      BigInt(refGrandTotal(replay.card)),
      `seat ${seat} total diverged from api/src/rules.ts at round ${round}`,
    );
    assert.equal(prog.round, BigInt(round + 1), 'scoring must advance the seat past the round');
    assert.deepEqual(diceToArray(prog.dice), dice, 'the scored dice are what the digest folds');
    assert.equal(after.seatTurn.lookup(BigInt(seat)).stage, BigInt(STAGE.idle));

    // The scorecard the chain holds must match the reference box for box, with the circuit's
    // filled/score split standing in for the reference's `number | null`.
    const card = after.seatCard.lookup(BigInt(seat));
    for (let cat = 0; cat < CATEGORY_COUNT; cat++) {
      const ref = replay.card.scores[cat];
      assert.equal(card.filled[cat], ref !== null, `seat ${seat} filled[${cat}] diverged`);
      assert.equal(card.scores[cat], BigInt(ref ?? 0), `seat ${seat} scores[${cat}] diverged`);
    }
    if (round === FINAL_ROUND) {
      replay.finishedAtRound = round;
      assert.equal(prog.finishedAtRound, BigInt(round));
    }
    this.assertCustody();

    this.turns.push({
      seat,
      round,
      entropy,
      mixed,
      digestBefore,
      holds: holds.map((h) => [...h]),
      rolls,
      dice,
      category,
    });
    return dice;
  }

  /** Is this seat scheduled to be eliminated instead of playing this round? */
  plannedElimination(seat: number, round: number): boolean {
    return (this.plan.eliminations ?? []).some((f) => f.seat === seat && f.round === round);
  }

  /**
   * Eliminate a seat at the first second past the round deadline.
   *
   * The clock JUMPS to `roundDeadline + 1` rather than ticking, because that is the earliest
   * moment the claim is legal and the tightest test of the predicate: one second earlier must
   * fail, which a separate test checks.
   *
   * Permissionless, so any private state will do -- `eliminate` needs no secret and reads
   * nothing but ledger state.
   */
  async eliminate(seat: number, round: number): Promise<bigint> {
    const led = this.ledger();
    this.clock = Math.max(this.clock, Number(led.roundDeadline) + 1);
    const { q, rem } = penaltySplit(this.config.tier, round);
    const potBefore = led.pot;
    const owedBefore = led.seatRedeemable.lookup(BigInt(seat));

    const refund = await this.sim.eliminate(seat, q, rem, this.clock);
    assert.equal(refund, this.config.tier - q, 'eliminate must return tier - penalty');

    const after = this.ledger();
    const prog = after.seatProgress.lookup(BigInt(seat));
    assert.equal(prog.eliminated, true);
    assert.equal(prog.round, BigInt(ROUND_COUNT), 'an eliminated seat owes no more rounds');
    assert.equal(
      prog.finishedAtRound,
      65535n,
      'an eliminated seat must carry the never-finished sentinel',
    );
    assert.equal(
      after.seatTurn.lookup(BigInt(seat)).stage,
      BigInt(STAGE.idle),
      'elimination must close any half-played turn',
    );
    assert.equal(after.pot, potBefore - refund, 'the refundable share must leave the pot');
    assert.equal(
      after.seatRedeemable.lookup(BigInt(seat)),
      owedBefore + refund,
      'the refundable share must land in the seat’s own redeemable',
    );
    this.assertCustody();

    this.seats[seat]!.eliminated = true;
    this.seats[seat]!.finishedAtRound = undefined;
    this.seats[seat]!.redeemable += refund;
    return refund;
  }

  /** The submission order for a round: the plan's, or seat order. */
  orderFor(round: number, seats: readonly number[]): number[] {
    return this.plan.orderFor ? this.plan.orderFor(round, seats) : [...seats];
  }

  /**
   * Play one whole round: every live seat plays a turn, the stragglers are eliminated, the round
   * closes.
   *
   * Deliberately NOT driven by a ledger cursor -- there is none. The driver knows which seats are
   * live from its own replay and the contract's `closeRound` refuses to advance unless that
   * agrees with the ledger, so a divergence shows up as a failed `closeRound` rather than as a
   * quietly skipped seat.
   */
  async playRound(round: number): Promise<void> {
    const live = this.liveSeats();
    const playing = live.filter((s) => !this.plannedElimination(s, round));
    for (const seat of this.orderFor(round, playing)) {
      await this.playTurn(seat, round);
    }
    for (const seat of live.filter((s) => this.plannedElimination(s, round))) {
      await this.eliminate(seat, round);
      if (this.ledger().phase === PHASE.abandoned) return;
    }
    await this.closeRound(round);
  }

  /** Close the open round and check the digest fold against the mirror. */
  async closeRound(round: number): Promise<void> {
    const at = this.tick();
    const next = await this.sim.closeRound(at);
    assert.equal(next, BigInt(round + 1));

    this.digest = roundDigestTs(this.digest, round, this.players.length, this.roundResults());
    const led = this.ledger();
    assert.deepEqual(
      led.roundDigest,
      this.digest,
      `roundDigest diverged when round ${round} closed`,
    );
    assert.equal(led.openRound, BigInt(round + 1));
    assert.equal(
      led.roundDeadline,
      BigInt(at) + this.config.turnTimeoutSecs,
      'closeRound must stamp the next round’s deadline',
    );
    this.assertCustody();
  }

  /** All six slots' contributions to the round digest, in seat order. */
  roundResults(): RoundResultTs[] {
    return Array.from({ length: MAX_SEATS }, (_, s) => {
      const seat = this.seats[s];
      if (seat === undefined) return emptyRoundResult();
      return { dice: seat.dice, out: seat.eliminated };
    });
  }

  /** Play to the end of the game, or until the table is abandoned. */
  async playToEnd(): Promise<void> {
    for (;;) {
      const led = this.ledger();
      if (led.phase !== PHASE.playing) return;
      if (Number(led.openRound) >= ROUND_COUNT) return;
      await this.playRound(Number(led.openRound));
    }
  }

  /** The reference grand total per seat. Eliminated seats keep what they scored. */
  totals(): number[] {
    return this.seats.map((s) => refGrandTotal(s.card));
  }

  /**
   * The winner the reference tie-break picks among SURVIVORS: highest total, then earliest
   * finisher, then lowest seat.
   *
   * Eliminated seats are excluded outright, which is the change simultaneous rounds brought:
   * elimination is economic and permanent, the seat has already been handed back
   * `tier - penalty`, and letting it also take the pot would pay it twice.
   */
  expectedWinner(): number {
    const totals = this.totals();
    const finished = this.seats.map((s) => s.finishedAtRound ?? Number.POSITIVE_INFINITY);
    const live = this.liveSeats();
    let win = live[0]!;
    for (const seat of live.slice(1)) {
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

  /** `[q, rem]` for the per-seat rake `abortTable` requires. */
  abortRake(): [bigint, bigint] {
    const { q, rem } = perSeatRake(this.config.tier);
    return [q, rem];
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

export type ReplayResult = {
  totals: number[];
  /** `undefined` where the seat never completed its card -- the ledger's `noFinish()`. */
  finishedAtRound: (number | undefined)[];
  eliminated: boolean[];
  /** What each seat is personally owed after its eliminations. */
  redeemable: bigint[];
  cards: RefScorecard[];
  digest: Uint8Array;
  /** The round the table stopped at: `ROUND_COUNT` for a completed game. */
  round: number;
  /** True where every seat was eliminated, so the table reached `abandoned`. */
  abandoned: boolean;
  turns: TurnRecord[];
  /** Player and operator transactions the game would take. The honest cost model. */
  playerTx: number;
  operatorTx: number;
};

/**
 * Replay a whole game from public data alone -- THE thing a settlement verifier does.
 *
 * Given the table's constructor arguments, the seats' secrets (equivalently, the entropies they
 * published), the hold masks they sent and the operator's revealed seed, this reproduces every
 * roll, every digest and every score with no chain access and no proof server.
 *
 * IT DOES NOT MODEL SUBMISSION ORDER, and that is the guarantee rather than a limitation. Under
 * the cursor model a verifier had to know the exact sequence of turns; under simultaneous rounds
 * a round's digest is a fold over the six slots BY INDEX, so the replay walks seats in seat order
 * and gets the same answer whatever order the chain saw.
 *
 * It is also how tie-break scenarios are found: a tie between two seats cannot be arranged by
 * hand because every die comes out of a hash, so the tie tests search here -- in milliseconds per
 * game -- and then play the single game that ties through the real circuits.
 */
export function replayGame(
  config: TableConfig,
  players: Player[],
  plan: GamePlan = {},
): ReplayResult {
  const strategy = plan.strategy ?? 'firstLegal';
  const chooser = plan.holds ?? mixedHolds;
  const seatCount = players.length;
  const eliminateKeys = new Set((plan.eliminations ?? []).map((f) => `${f.seat}:${f.round}`));

  let digest = genesisDigestTs(config.tableId);
  for (let seat = 0; seat < seatCount; seat++) {
    digest = joinDigestTs(
      digest,
      seat,
      players[seat]!.addr.bytes,
      entropyKeyCommitmentTs(config.tableId, players[seat]!.sk),
    );
  }

  const cards = players.map(() => refEmptyScorecard());
  const dice: number[][] = players.map(() => [1, 1, 1, 1, 1]);
  const finishedAtRound: (number | undefined)[] = players.map(() => undefined);
  const eliminated = players.map(() => false);
  const redeemable = players.map(() => 0n);
  const turns: TurnRecord[] = [];

  let round = 0;
  let active = seatCount;
  let abandoned = false;
  // One join each, plus per turn: open + score, one hold per reroll. Operator: one per roll.
  let playerTx = seatCount;
  let operatorTx = 0;

  for (; round < ROUND_COUNT && !abandoned;) {
    // Every live seat that is not scheduled to walk away plays, in SEAT ORDER. The chain may have
    // seen any order at all; the digest cannot tell, which is the property under test.
    for (let seat = 0; seat < seatCount; seat++) {
      if (eliminated[seat] === true) continue;
      if (eliminateKeys.has(`${seat}:${round}`)) continue;

      const player = players[seat]!;
      const entropy = forcedEntropyTs(player.sk, config.tableId, round);
      const mixed = mixEntropyTs(entropy, digest);
      const { holds, rolls, final } = planTurn(config, mixed, seat, round, chooser);

      const category = chooseCategoryFor(cards[seat]!, final, strategy);
      cards[seat] = refApplyScore(cards[seat]!, category as Category, final as unknown as RefDice);
      dice[seat] = final;
      if (round === FINAL_ROUND) finishedAtRound[seat] = round;

      playerTx += 2 + holds.length;
      operatorTx += 1 + holds.length;
      turns.push({
        seat,
        round,
        entropy,
        mixed,
        digestBefore: digest,
        holds: holds.map((h) => [...h]),
        rolls,
        dice: final,
        category,
      });
    }

    // Then the stragglers are knocked out, at the round they failed in.
    for (let seat = 0; seat < seatCount; seat++) {
      if (eliminated[seat] === true) continue;
      if (!eliminateKeys.has(`${seat}:${round}`)) continue;
      eliminated[seat] = true;
      finishedAtRound[seat] = undefined;
      const { q } = penaltySplit(config.tier, round);
      redeemable[seat] += config.tier - q;
      active -= 1;
    }
    if (active === 0) {
      abandoned = true;
      break;
    }

    // And the round closes: one fold over all six slots, in seat order.
    const results: RoundResultTs[] = Array.from({ length: MAX_SEATS }, (_, s) =>
      s < seatCount ? { dice: dice[s]!, out: eliminated[s]! } : emptyRoundResult(),
    );
    digest = roundDigestTs(digest, round, seatCount, results);
    round += 1;
  }

  return {
    totals: cards.map((c) => refGrandTotal(c)),
    finishedAtRound,
    eliminated,
    redeemable,
    cards,
    digest,
    round,
    abandoned,
    turns,
    playerTx,
    operatorTx,
  };
}

/** Every one of the 32 hold masks, in a stable order. Used by the merge cross-check. */
export function allMasks(): Mask[] {
  return Array.from({ length: 32 }, (_, bits) =>
    Array.from({ length: 5 }, (_, i) => ((bits >> i) & 1) === 1),
  );
}

/** Keep just these positions. */
export function maskOf(...positions: number[]): Mask {
  const m = REROLL_ALL();
  for (const p of positions) m[p] = true;
  return m;
}
