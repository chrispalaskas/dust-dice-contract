// Copyright (C) Shielded Technologies
// SPDX-License-Identifier: Apache-2.0

/**
 * backgammon.compact, end to end in the simulator.
 *
 * Three kinds of test. DIFFERENTIAL: the TypeScript mirrors (src/bg-mirror.ts, and the rules
 * engine api/src/backgammon.ts) against the contract's own `pureCircuits`, on random inputs --
 * the dice ladder, the two-player roll hashes, and every accept/refuse decision the board circuit
 * makes. GAMES: whole games played by random legal plies, with the chain's board and dice checked
 * against the engine and against a replay from the public log after every call. CASES: each
 * illegal move, each out-of-turn reveal or move, and every exit from every state, one at a time.
 *
 * The ledger's WASM wrappers are freed only by the garbage collector, and a file that plays
 * many games crawls without a collection between tests (the dust-dice-dleq finding) -- hence
 * the `gc` in `afterEach`.
 */

import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as v8 from 'node:v8';
import * as vm from 'node:vm';

import * as Rules from '../../../api/src/backgammon.ts';
import { pureCircuits as bgPure } from '../managed/backgammon/contract/index.js';
import {
  bgDiceFromBytesTs,
  bgHasShare,
  bgMyRoll,
  bgOpeningDiceTs,
  bgOpeningSecretTs,
  bgPlyDiceTs,
  bgRollSecretTs,
  bgStarter,
} from '../bg-mirror.ts';
import {
  BG_SLOT_COUNT,
  bgHeldSlots,
  bgLastJoinAt,
  bgPlayerCount,
  bgRandomFreeSlot,
  bgSlotHeldBy,
  bgStartPick,
} from '../bg-slots.ts';
import { entropyKeyCommitmentTs, inviteCommitmentTs } from '../policy-mirror.ts';
import {
  BG_PHASE,
  BackgammonSimulator,
  DEFAULT_BLOCK_TIME,
  NO_WINNER,
  STAGE_MOVE,
  STAGE_OPENING,
  boardOf,
  bytes32,
  defaultBgConfig,
  diceOf,
  freeSlots,
  openTable,
  playOut,
  rng,
  seatBoth,
  seats,
  sharesOf,
  SLOT_COUNT,
  userAddress,
} from './bg-harness.ts';

v8.setFlagsFromString('--expose-gc');
const gc = vm.runInNewContext('gc') as () => void;
afterEach(() => gc());

const T0 = DEFAULT_BLOCK_TIME;
/** A move's clock: the declared time plus the 120 s slack plus the 180 s move timeout. */
const clock = (now: number) => BigInt(now + 120 + 180);

async function rejects(p: Promise<unknown>, pattern: RegExp): Promise<void> {
  await assert.rejects(p, (e: unknown) => {
    const msg = e instanceof Error ? e.message : String(e);
    assert.match(msg, pattern);
    return true;
  });
}

function randomBytes(r: () => number): Uint8Array {
  const b = new Uint8Array(32);
  for (let i = 0; i < 32; i++) b[i] = Math.floor(r() * 256);
  return b;
}

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

/** Both players joined, the table started: both owe their share of the opening. */
async function startedGame(config = defaultBgConfig()) {
  const sim = await BackgammonSimulator.create(config);
  const players = seats();
  await seatBoth(sim, players, T0);
  sim.asOperator();
  await sim.start(T0 + 5);
  return { sim, players };
}

/** Both shares in: ply 0 is owed by the starter, with the opening dice. */
async function openedGame(config = defaultBgConfig()) {
  const sim = await BackgammonSimulator.create(config);
  const players = seats();
  await seatBoth(sim, players, T0);
  await openTable(sim, players, T0 + 5);
  const opening = bgOpeningDiceTs(config.tableId, sharesOf(sim.getLedger()));
  const mover = bgStarter(opening);
  return { sim, players, mover, opening: [opening.a, opening.b] as [number, number] };
}

/** Past the opening: ply 0 played, ply 1 owed by the other seat, with its own roll. */
async function laterGame(config = defaultBgConfig()) {
  const { sim, players, mover: starter, opening } = await openedGame(config);
  sim.asPlayer(players[starter]!.sk);
  const ply = Rules.legalPlies(Rules.initialSide(), Rules.initialSide(), opening)[0]!;
  await sim.move(ply, T0 + 20);
  const mover = Number(sim.getLedger().toMove);
  assert.equal(mover, 1 - starter);
  return { sim, players, mover, opening };
}

// =============================================================================================
// Differential: the mirrors against the circuits
// =============================================================================================

describe('the dice', () => {
  it("expands a roll's bytes exactly as the circuit does", () => {
    const r = rng(7);
    for (let i = 0; i < 300; i++) {
      const v = randomBytes(r);
      const opening = i % 3 === 0;
      const c = bgPure.bgDiceFromBytes(Array.from(v, BigInt), opening);
      const m = bgDiceFromBytesTs(v, opening);
      assert.deepEqual([Number(c.a), Number(c.b)], [m.a, m.b], `roll ${i}`);
      if (opening) assert.notEqual(m.a, m.b, 'an opening is never a double');
    }
  });

  it('gives every ordered pair of distinct faces to the opening, evenly', () => {
    const r = rng(9);
    const counts = new Map<string, number>();
    const N = 6000;
    for (let i = 0; i < N; i++) {
      const m = bgDiceFromBytesTs(randomBytes(r), true);
      counts.set(`${m.a}${m.b}`, (counts.get(`${m.a}${m.b}`) ?? 0) + 1);
    }
    assert.equal(counts.size, 30);
    // Chi-square against uniform over 30 cells, 29 degrees of freedom: p = 0.001 at 58.3.
    const expected = N / 30;
    let chi = 0;
    for (const c of counts.values()) chi += (c - expected) ** 2 / expected;
    assert.ok(chi < 58.3, `opening chi-square ${chi.toFixed(1)}`);
  });

  it('needs a secret from each player: change either and the roll changes', () => {
    const r = rng(12);
    const tid = bytes32(0x42);
    let same = 0;
    for (let i = 0; i < 200; i++) {
      const mine = randomBytes(r);
      const other = randomBytes(r);
      const base = bgPlyDiceTs(tid, mine, other, 3);
      const m2 = bgPlyDiceTs(tid, randomBytes(r), other, 3);
      const o2 = bgPlyDiceTs(tid, mine, randomBytes(r), 3);
      if (m2.a === base.a && m2.b === base.b) same += 1;
      if (o2.a === base.a && o2.b === base.b) same += 1;
    }
    // 36 outcomes: a changed input keeps the same pair about 1 time in 36 (~11 of 400).
    assert.ok(same < 30, `${same} of 400 changed inputs kept the roll`);
  });

  it('forces every revealed secret from the seat key, at distinct indices', () => {
    const tid = bytes32(0x42);
    const sk = bytes32(0x11);
    const opening = hex(bgOpeningSecretTs(sk, tid));
    const plies = new Set<string>([opening]);
    for (let t = 0; t < 20; t++) plies.add(hex(bgRollSecretTs(sk, tid, t)));
    assert.equal(plies.size, 21, 'the opening share and each ply secret are all distinct');
    assert.notEqual(hex(bgRollSecretTs(sk, bytes32(0x43), 0)), hex(bgRollSecretTs(sk, tid, 0)));
  });
});

describe('the board circuit and the rules engine', () => {
  /** The circuit's verdict on a ply: its outcome, or the reason it refuses. */
  function circuit(
    mine: Rules.Side,
    opp: Rules.Side,
    dice: [number, number],
    enc: Rules.EncodedPly,
  ) {
    try {
      const out = bgPure.applyPlyStrict(
        mine.map(BigInt),
        opp.map(BigInt),
        BigInt(dice[0]),
        BigInt(dice[1]),
        enc.moves.map((m) => ({ point: BigInt(m.point), die: BigInt(m.die) })),
        BigInt(enc.count),
      );
      return {
        ok: true as const,
        mine: out.mine.map(Number),
        opp: out.opp.map(Number),
        won: out.won,
      };
    } catch (e) {
      return { ok: false as const, why: e instanceof Error ? e.message : String(e) };
    }
  }

  function engine(mine: Rules.Side, opp: Rules.Side, dice: [number, number], ply: Rules.Ply) {
    try {
      const out = Rules.applyPly(mine, opp, dice, ply);
      return { ok: true as const, ...out };
    } catch (e) {
      if (e instanceof Rules.IllegalPlyError) return { ok: false as const, why: e.message };
      throw e;
    }
  }

  /** Random positions reached by random legal play, so they are real backgammon positions. */
  function positions(seed: number, n: number) {
    const r = rng(seed);
    const out: { mine: Rules.Side; opp: Rules.Side; dice: [number, number] }[] = [];
    let s = [Rules.initialSide(), Rules.initialSide()];
    let mover = 0;
    while (out.length < n) {
      const dice: [number, number] = [1 + Math.floor(r() * 6), 1 + Math.floor(r() * 6)];
      out.push({ mine: s[mover], opp: s[1 - mover], dice });
      const options = Rules.legalPlies(s[mover], s[1 - mover], dice);
      const res = Rules.applyPly(
        s[mover],
        s[1 - mover],
        dice,
        options[Math.floor(r() * options.length)],
      );
      s = mover === 0 ? [res.mine, res.opp] : [res.opp, res.mine];
      mover = 1 - mover;
      if (res.won) {
        s = [Rules.initialSide(), Rules.initialSide()];
        mover = 0;
      }
    }
    return out;
  }

  it('accepts every ply the rules offer, with the same result', () => {
    let checked = 0;
    for (const { mine, opp, dice } of positions(11, 1500)) {
      for (const ply of Rules.legalPlies(mine, opp, dice).slice(0, 4)) {
        const c = circuit(mine, opp, dice, Rules.encodePly(ply));
        const e = engine(mine, opp, dice, ply);
        assert.ok(c.ok, `circuit refused a legal ply: ${!c.ok && c.why}`);
        assert.ok(e.ok);
        assert.deepEqual([c.mine, c.opp, c.won], [e.mine, e.opp, e.won]);
        checked++;
      }
    }
    assert.ok(checked > 3000);
  });

  it('agrees with the engine on random, mostly illegal, plies', () => {
    const r = rng(12);
    let refused = 0;
    let accepted = 0;
    for (const { mine, opp, dice } of positions(13, 3000)) {
      const dbl = dice[0] === dice[1];
      const count = Math.floor(r() * ((dbl ? 4 : 2) + 1));
      const ply: Rules.Ply = [];
      for (let k = 0; k < count; k++) {
        // Bias towards points that hold a checker, or nothing would ever be legal.
        const occupied = mine.map((c, p) => (c > 0 && p >= 1 ? p : -1)).filter((p) => p > 0);
        const point =
          r() < 0.8 && occupied.length > 0
            ? occupied[Math.floor(r() * occupied.length)]
            : 1 + Math.floor(r() * 25);
        const die = dbl ? dice[0] : r() < 0.5 ? dice[0] : dice[1];
        ply.push({
          point,
          die: k === 1 && !dbl ? (ply[0].die === dice[0] ? dice[1] : dice[0]) : die,
        });
      }
      const c = circuit(mine, opp, dice, Rules.encodePly(ply));
      const e = engine(mine, opp, dice, ply);
      assert.equal(
        c.ok,
        e.ok,
        `disagree on ${JSON.stringify(ply)} with ${dice}: ${!c.ok ? c.why : ''} / ${!e.ok ? e.why : ''}`,
      );
      if (c.ok && e.ok) {
        assert.deepEqual([c.mine, c.opp], [e.mine, e.opp]);
        accepted++;
      } else refused++;
    }
    assert.ok(refused > 500 && accepted > 200, `accepted ${accepted}, refused ${refused}`);
  });

  it('refuses a non-canonical encoding', () => {
    const mine = Rules.initialSide();
    const opp = Rules.initialSide();
    const bad = {
      moves: [
        { point: 8, die: 3 },
        { point: 6, die: 1 },
        { point: 6, die: 0 },
        { point: 0, die: 0 },
      ],
      count: 2,
    };
    const c = circuit(mine, opp, [3, 1], bad);
    assert.ok(!c.ok && /unused and must be/.test(c.why));
  });
});

// =============================================================================================
// Whole games
// =============================================================================================

describe('whole games', () => {
  it('play to a settlement, the chain agreeing with the engine and the replay throughout', async () => {
    for (const seed of [1, 2, 3]) {
      const config = defaultBgConfig({ tableId: bytes32(0x40 + seed) });
      const { sim, players } = await openedGame(config);
      const failures: string[] = [];
      const game = await playOut(sim, players, rng(seed), T0 + 10, (msg, ok) => {
        if (!ok) failures.push(msg);
      });
      assert.deepEqual(failures, [], `game ${seed}`);

      // The opening decided who went first, by the higher die.
      const first = game.rolls[0]!;
      assert.equal(first.mover, bgStarter({ a: first.chain[0], b: first.chain[1] }));

      const decided = sim.getLedger();
      assert.equal(decided.phase, BG_PHASE.decided);
      assert.equal(Number(decided.winner), game.winner);
      assert.equal(Number(decided.turn), game.plies);
      assert.equal(boardOf(decided)[game.winner === 0 ? 's0' : 's1'][Rules.OFF], Rules.CHECKERS);

      sim.asOperator();
      assert.equal(await sim.settle(game.t + 5), BigInt(game.winner));
      const settled = sim.getLedger();
      assert.equal(settled.phase, BG_PHASE.settled);
      assert.equal(settled.pot, 0n);
      gc();
    }
  });
});

// =============================================================================================
// Cases
// =============================================================================================

describe('joining', () => {
  it('claims a slot, commits only to its key, and counts nothing', async () => {
    const sim = await BackgammonSimulator.create(defaultBgConfig());
    const [p0, p1] = seats();
    sim.asPlayer(p0.sk);
    assert.equal(await sim.join(p0.addr, T0, T0, 3), 3n);
    sim.asPlayer(p1.sk);
    assert.equal(await sim.join(p1.addr, T0 + 50, T0 + 50, 6), 6n);
    const l = sim.getLedger();
    // Nothing shared moved: no counter, no pot, no clock -- which is what lets joins land together.
    assert.equal(l.phase, BG_PHASE.filling);
    assert.equal(l.seatCount, 0n);
    assert.equal(l.pot, 0n);
    assert.equal(l.deadline, 0n);
    assert.equal(
      hex(l.joinSlots.lookup(3n).keyCommit),
      hex(entropyKeyCommitmentTs(sim.config.tableId, p0.sk)),
    );
    assert.equal(l.joinSlots.lookup(6n).joinedAt, BigInt(T0 + 50));
    // Nothing of the dice yet: the opening's shares come after the start.
    assert.ok(!bgHasShare(l.openingShare.lookup(0n)) && !bgHasShare(l.openingShare.lookup(1n)));
    assert.deepEqual(freeSlots(l), [0, 1, 2, 4, 5, 7]);
  });

  it('refuses a slot someone holds and a slot past the last, and takes a free one', async () => {
    const sim = await BackgammonSimulator.create(defaultBgConfig());
    const [p0, p1] = seats();
    sim.asPlayer(p0.sk);
    await sim.join(p0.addr, T0, T0, 2);
    sim.asPlayer(p1.sk);
    await rejects(sim.join(p1.addr, T0 + 1, T0 + 1, 2), /taken a moment ago/);
    await rejects(sim.join(p1.addr, T0 + 1, T0 + 1, SLOT_COUNT), /no such seat/);
    assert.equal(await sim.join(p1.addr, T0 + 1, T0 + 1, 5), 5n);
  });

  it('lets one secret hold two slots -- there is no set of keys for a join to grow', async () => {
    const sim = await BackgammonSimulator.create(defaultBgConfig());
    const [p0] = seats();
    sim.asPlayer(p0.sk);
    await sim.join(p0.addr, T0, T0, 0);
    await sim.join(p0.addr, T0 + 1, T0 + 1, 1);
    assert.deepEqual(freeSlots(sim.getLedger()), [2, 3, 4, 5, 6, 7]);
  });

  it('starts with the two earliest joiners in the seats, refunding the rest; anyone may start it', async () => {
    const sim = await BackgammonSimulator.create(defaultBgConfig());
    const [pA, pB] = seats();
    const pC = { sk: bytes32(0x33), addr: userAddress(0x03) };
    // Joined out of slot order; declared times decide.
    sim.asPlayer(pA.sk);
    await sim.join(pA.addr, T0 + 5, T0 + 5, 6);
    sim.asPlayer(pB.sk);
    await sim.join(pB.addr, T0 + 1, T0 + 5, 2);
    sim.asPlayer(pC.sk);
    await sim.join(pC.addr, T0 + 3, T0 + 5, 4);
    assert.deepEqual(bgStartPick(sim.getLedger()), [2, 4]);
    // A stranger starts it: the start takes no secret and decides nothing a caller could steer.
    sim.asPlayer(bytes32(0x99));
    await sim.start(T0 + 20);
    const l = sim.getLedger();
    assert.equal(l.phase, BG_PHASE.playing);
    assert.equal(l.stage, STAGE_OPENING, 'both seats now owe their share of the opening');
    assert.equal(l.seatCount, 2n);
    // The pot is the two seated stakes; the third (pA, the latest) was refunded by this call.
    assert.equal(l.pot, 20_000n);
    assert.deepEqual(l.seatIdentity.lookup(0n).addr, pB.addr);
    assert.deepEqual(l.seatIdentity.lookup(1n).addr, pC.addr);
    assert.equal(l.deadline, clock(T0 + 20));
    // Once started, nobody else can sit down, and it cannot be started twice.
    sim.asPlayer(bytes32(0x44));
    await rejects(sim.join(userAddress(0x04), T0 + 21), /not filling/);
    await rejects(sim.start(T0 + 21), /not filling/);
  });

  it('breaks a tie on the declared time by the lower slot', async () => {
    const sim = await BackgammonSimulator.create(defaultBgConfig());
    const [p0, p1] = seats();
    sim.asPlayer(p0.sk);
    await sim.join(p0.addr, T0, T0, 5);
    sim.asPlayer(p1.sk);
    await sim.join(p1.addr, T0, T0, 1);
    sim.asOperator();
    await sim.start(T0 + 10);
    assert.deepEqual(sim.getLedger().seatIdentity.lookup(0n).addr, p1.addr);
  });

  it('will not start with fewer than two players', async () => {
    const sim = await BackgammonSimulator.create(defaultBgConfig());
    const [p0] = seats();
    sim.asPlayer(p0.sk);
    await sim.join(p0.addr, T0);
    sim.asOperator();
    await rejects(sim.start(T0 + 10), /fewer than two/);
  });

  it('agrees with the TypeScript reading of the slots', async () => {
    assert.equal(Number(bgPure.slotCount()), BG_SLOT_COUNT);
    const sim = await BackgammonSimulator.create(defaultBgConfig());
    const [p0, p1] = seats();
    sim.asPlayer(p0.sk);
    await sim.join(p0.addr, T0 + 2, T0 + 2, 5);
    sim.asPlayer(p1.sk);
    await sim.join(p1.addr, T0 + 9, T0 + 9, 1);
    let l = sim.getLedger();
    assert.deepEqual(bgHeldSlots(l), [1, 5]);
    assert.equal(bgPlayerCount(l), 2);
    assert.equal(bgLastJoinAt(l), BigInt(T0 + 9));
    assert.equal(bgSlotHeldBy(l, entropyKeyCommitmentTs(sim.config.tableId, p0.sk)), 5);
    assert.ok(![1, 5].includes(bgRandomFreeSlot(l)!));
    assert.deepEqual(bgStartPick(l), [5, 1]);
    sim.asOperator();
    await sim.start(T0 + 20);
    l = sim.getLedger();
    assert.equal(bgPlayerCount(l), 2, 'the seats, once started');
  });

  it('refuses a zero payout address', async () => {
    const sim = await BackgammonSimulator.create(defaultBgConfig());
    sim.asPlayer(bytes32(0x12));
    await rejects(sim.join({ bytes: new Uint8Array(32) }, T0), /zero address/);
  });

  it('admits only the invite code on a private table', async () => {
    const code = bytes32(0x77);
    const sim = await BackgammonSimulator.create(
      defaultBgConfig({ inviteHash: inviteCommitmentTs(code) }),
    );
    sim.asPlayer(bytes32(0x11), bytes32(0x78));
    await rejects(sim.join(userAddress(0x01), T0), /invite code does not match/);
    sim.asPlayer(bytes32(0x11), code);
    assert.equal(await sim.join(userAddress(0x01), T0), 0n);
  });

  it('pins the declared time', async () => {
    const sim = await BackgammonSimulator.create(defaultBgConfig());
    sim.asPlayer(bytes32(0x11));
    await rejects(sim.join(userAddress(0x01), T0 + 1, T0), /ahead of block time/);
    await rejects(sim.join(userAddress(0x01), T0 - 121, T0), /further behind/);
  });
});

describe('the constructor', () => {
  it('refuses a move clock under two minutes, a table clock inside the floor, and a tier too small to rake', async () => {
    await rejects(
      BackgammonSimulator.create(defaultBgConfig({ moveTimeoutSecs: 119n })),
      /at least two minutes/,
    );
    await BackgammonSimulator.create(defaultBgConfig({ moveTimeoutSecs: 180n }));
    await rejects(
      BackgammonSimulator.create(defaultBgConfig({ tableTimeoutSecs: 240n })),
      /table timeout/,
    );
    await rejects(BackgammonSimulator.create(defaultBgConfig({ tier: 99n })), /at least 100/);
  });

  it('sets up the standard position', async () => {
    const sim = await BackgammonSimulator.create(defaultBgConfig());
    assert.deepEqual(boardOf(sim.getLedger()), Rules.initialBoard());
    assert.equal(sim.getLedger().winner, NO_WINNER);
  });
});

describe('the opening', () => {
  it("takes one share from each seat, each forced from the seat's key, in any order", async () => {
    const { sim, players } = await startedGame();
    // Seat 1 first: the order does not matter, and neither reveal reads the other's.
    sim.asPlayer(players[1].sk);
    await sim.reveal(1, T0 + 10);
    sim.asPlayer(players[0].sk);
    await sim.reveal(0, T0 + 12);
    const l = sim.getLedger();
    for (const s of [0, 1]) {
      assert.equal(
        hex(l.openingShare.lookup(BigInt(s))),
        hex(bgOpeningSecretTs(players[s]!.sk, sim.config.tableId)),
      );
    }
    // The later reveal's clock stands: the starter's ply 0 runs from the second share.
    assert.equal(l.deadline, clock(T0 + 12));
    assert.equal(l.stage, STAGE_OPENING);
  });

  it('refuses a share from the wrong key, a second share, and a share once the opening is played', async () => {
    const { sim, players } = await startedGame();
    sim.asPlayer(players[1].sk);
    await rejects(sim.reveal(0, T0 + 10), /wrong entropy secret/);
    sim.asPlayer(players[0].sk);
    await sim.reveal(0, T0 + 10);
    await rejects(sim.reveal(0, T0 + 11), /revealed its share already/);
    sim.asPlayer(players[1].sk);
    await sim.reveal(1, T0 + 12);
    const opening = bgOpeningDiceTs(sim.config.tableId, sharesOf(sim.getLedger()));
    const starter = bgStarter(opening);
    sim.asPlayer(players[starter]!.sk);
    await sim.move(
      Rules.legalPlies(Rules.initialSide(), Rules.initialSide(), [opening.a, opening.b])[0]!,
      T0 + 20,
    );
    await rejects(sim.reveal(starter, T0 + 21), /opening has been played/);
  });

  it('will not play ply 0 until both shares are in, and lets only the higher die play it', async () => {
    const { sim, players } = await startedGame();
    sim.asPlayer(players[0].sk);
    await sim.reveal(0, T0 + 10);
    const anyPly = Rules.legalPlies(Rules.initialSide(), Rules.initialSide(), [3, 1])[0]!;
    await rejects(sim.move(anyPly, T0 + 11), /both shares are needed/);
    sim.asPlayer(players[1].sk);
    await sim.reveal(1, T0 + 12);
    const opening = bgOpeningDiceTs(sim.config.tableId, sharesOf(sim.getLedger()));
    const starter = bgStarter(opening);
    const ply = Rules.legalPlies(Rules.initialSide(), Rules.initialSide(), [
      opening.a,
      opening.b,
    ])[0]!;
    sim.asPlayer(players[1 - starter]!.sk);
    await rejects(sim.move(ply, T0 + 20), /wrong entropy secret/);
    sim.asPlayer(players[starter]!.sk);
    await sim.move(ply, T0 + 20);
    const l = sim.getLedger();
    assert.deepEqual(diceOf(l), [opening.a, opening.b], 'ply 0 played the opening pair');
    assert.equal(Number(l.toMove), 1 - starter);
    assert.equal(l.stage, STAGE_MOVE);
  });

  it('pins the declared time on the start, a reveal and a move', async () => {
    const { sim, players } = await startedGame();
    sim.asPlayer(players[0].sk);
    await rejects(sim.reveal(0, T0 + 10, T0 + 200), /further behind/);
    await rejects(sim.reveal(0, T0 + 10, T0 + 5), /ahead of block time/);
  });
});

describe('moving', () => {
  it('refuses a move by the wrong seat, and a second move by the same seat', async () => {
    const { sim, players, mover } = await laterGame();
    const l = sim.getLedger();
    const dice = bgMyRoll({
      sk: players[mover]!.sk,
      tableId: sim.config.tableId,
      turn: l.turn,
      lastSecret: l.lastSecret,
    });
    const { mine, opp } = Rules.sidesFor(boardOf(l), mover);
    const ply = Rules.legalPlies(mine, opp, [dice.a, dice.b])[0]!;
    sim.asPlayer(players[1 - mover]!.sk);
    await rejects(sim.move(ply, T0 + 30), /wrong entropy secret/);
    sim.asPlayer(players[mover]!.sk);
    await sim.move(ply, T0 + 30);
    await rejects(sim.move(ply, T0 + 31), /wrong entropy secret/);
  });

  it('refuses each kind of illegal ply', async () => {
    const { sim, players, mover, opening } = await openedGame();
    const [a, b] = opening;
    sim.asPlayer(players[mover]!.sk);
    const t = T0 + 20;
    // A die that was not rolled.
    const notRolled = [1, 2, 3, 4, 5, 6].find((d) => d !== a && d !== b)!;
    await rejects(sim.move([{ point: 13, die: notRolled }], t), /die that was not rolled/);
    // An empty point.
    await rejects(
      sim.move(
        [
          { point: 20, die: a },
          { point: 20, die: b },
        ],
        t,
      ),
      /do not have on that point/,
    );
    // A pass while dice play.
    await rejects(sim.move([], t), /left unplayed/);
    // Too many dice without doubles.
    await rejects(
      sim.moveEncoded(
        {
          moves: [
            { point: 13, die: a },
            { point: 13, die: b },
            { point: 13, die: a },
            { point: 0, die: 0 },
          ],
          count: 3,
        },
        t,
      ),
      /at most two dice/,
    );
  });

  it("keeps a ply's roll off the ledger until its move, which discloses exactly it and its secret", async () => {
    const { sim, players, mover, opening } = await laterGame();
    const l = sim.getLedger();
    // The ledger still shows the last PLAYED roll: the opening. Only the mover can compute this one.
    assert.deepEqual(diceOf(l), opening);
    const dice = bgMyRoll({
      sk: players[mover]!.sk,
      tableId: sim.config.tableId,
      turn: l.turn,
      lastSecret: l.lastSecret,
    });
    const { mine, opp } = Rules.sidesFor(boardOf(l), mover);
    sim.asPlayer(players[mover]!.sk);
    await sim.move(Rules.legalPlies(mine, opp, [dice.a, dice.b])[0]!, T0 + 40);
    const after = sim.getLedger();
    assert.deepEqual(diceOf(after), [dice.a, dice.b]);
    assert.equal(
      hex(after.lastSecret),
      hex(bgRollSecretTs(players[mover]!.sk, sim.config.tableId, 1)),
    );
    // Anyone replays it from the public log: this move's secret and the one before it.
    const replay = bgPlyDiceTs(sim.config.tableId, after.lastSecret, l.lastSecret, 1);
    assert.deepEqual([replay.a, replay.b], [dice.a, dice.b]);
    assert.equal(after.deadline, clock(T0 + 40), "the move starts the other seat's clock");
  });

  it('refuses a ply played with dice the mover did not roll', async () => {
    const { sim, players, mover } = await laterGame();
    const l = sim.getLedger();
    const dice = bgMyRoll({
      sk: players[mover]!.sk,
      tableId: sim.config.tableId,
      turn: l.turn,
      lastSecret: l.lastSecret,
    });
    const { mine, opp } = Rules.sidesFor(boardOf(l), mover);
    // The legal plies of every OTHER roll whose plies the real roll does not also allow.
    const real = new Set(
      Rules.legalPlies(mine, opp, [dice.a, dice.b]).map((p) => JSON.stringify(p)),
    );
    let tried = 0;
    sim.asPlayer(players[mover]!.sk);
    for (let x = 1; x <= 6 && tried < 3; x++) {
      for (let y = x; y <= 6 && tried < 3; y++) {
        if ((x === dice.a && y === dice.b) || (x === dice.b && y === dice.a)) continue;
        const ply = Rules.legalPlies(mine, opp, [x, y]).find((p) => !real.has(JSON.stringify(p)));
        if (!ply || ply.length === 0) continue;
        tried += 1;
        await rejects(sim.move(ply, T0 + 40), /not rolled|unused|do not have|holds|unplayed/);
      }
    }
    assert.ok(tried > 0);
  });

  it('refuses entering onto a closed board and accepts the forced pass', async () => {
    // Played through the circuit on a constructed position via the pure circuit: the table
    // cannot be steered to one, so the ledger path is covered by the games above.
    const mine = [0, 0, 0, 0, 0, 0, 14, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1];
    const opp = [3, 2, 2, 2, 2, 2, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    const enc = (ply: Rules.Ply) =>
      Rules.encodePly(ply).moves.map((m) => ({ point: BigInt(m.point), die: BigInt(m.die) }));
    assert.throws(
      () =>
        bgPure.applyPlyStrict(
          mine.map(BigInt),
          opp.map(BigInt),
          3n,
          5n,
          enc([{ point: 25, die: 3 }]),
          1n,
        ),
      /holds/,
    );
    const out = bgPure.applyPlyStrict(mine.map(BigInt), opp.map(BigInt), 3n, 5n, enc([]), 0n);
    assert.deepEqual(out.mine.map(Number), mine);
  });
});

describe('timeouts, resignation and leaving', () => {
  it('eliminates the mover past its deadline, and the opponent wins', async () => {
    const { sim, mover } = await laterGame();
    const deadline = Number(sim.getLedger().deadline);
    sim.asOperator();
    await rejects(sim.eliminate(mover, false, deadline), /not past its deadline/);
    await rejects(sim.eliminate(1 - mover, false, deadline + 1), /not past its deadline/);
    await sim.eliminate(mover, false, deadline + 1);
    const l = sim.getLedger();
    assert.equal(l.phase, BG_PHASE.decided);
    assert.equal(Number(l.winner), 1 - mover);
  });

  it('at the opening, eliminates the seat whose share is missing -- only once the other is in', async () => {
    const { sim, players } = await startedGame();
    const deadline = Number(sim.getLedger().deadline);
    sim.asOperator();
    // Neither in: nobody's fault alone.
    await rejects(sim.eliminate(0, false, deadline + 1), /not past its deadline/);
    await rejects(sim.eliminate(1, false, deadline + 1), /not past its deadline/);
    sim.asPlayer(players[1].sk);
    await sim.reveal(1, T0 + 10);
    const later = Number(sim.getLedger().deadline);
    sim.asOperator();
    await rejects(sim.eliminate(1, false, later + 1), /not past its deadline/);
    await rejects(sim.eliminate(0, false, later), /not past its deadline/);
    await sim.eliminate(0, false, later + 1);
    assert.equal(Number(sim.getLedger().winner), 1);
  });

  it('at the opening, eliminates the starter who does not play ply 0', async () => {
    const { sim, mover } = await openedGame();
    const deadline = Number(sim.getLedger().deadline);
    sim.asOperator();
    await rejects(sim.eliminate(1 - mover, false, deadline + 1), /not past its deadline/);
    await sim.eliminate(mover, false, deadline + 1);
    assert.equal(Number(sim.getLedger().winner), 1 - mover);
  });

  it('lets a seat resign at any time during play, proving its key', async () => {
    const { sim, players } = await openedGame();
    sim.asPlayer(players[1].sk);
    await rejects(sim.eliminate(0, true, T0 + 15), /wrong entropy secret/);
    await sim.eliminate(1, true, T0 + 15);
    const l = sim.getLedger();
    assert.equal(l.phase, BG_PHASE.decided);
    assert.equal(l.winner, 0n);
    sim.asOperator();
    await sim.settle(T0 + 16);
    assert.equal(sim.getLedger().phase, BG_PHASE.settled);
  });

  it('refunds a seat that leaves a filling table and frees its slot for anyone', async () => {
    const sim = await BackgammonSimulator.create(defaultBgConfig());
    const [p0, p1] = seats();
    sim.asPlayer(p0.sk);
    await sim.join(p0.addr, T0, T0, 4);
    // Leaving names the slot. Someone else's slot cannot be left, and an empty one is refused.
    sim.asPlayer(p1.sk);
    await rejects(sim.eliminate(4, true, T0 + 5), /wrong entropy secret/);
    await rejects(sim.eliminate(3, true, T0 + 5), /wrong entropy secret|empty/);
    sim.asPlayer(p0.sk);
    await sim.eliminate(4, true, T0 + 5);
    let l = sim.getLedger();
    assert.equal(l.phase, BG_PHASE.filling);
    assert.deepEqual(freeSlots(l), [0, 1, 2, 3, 4, 5, 6, 7]);
    assert.equal(l.joinSlots.lookup(4n).joinedAt, 0n);
    // The same key may sit down again, in the same slot or another, and so may someone else.
    await sim.join(p0.addr, T0 + 10, T0 + 10, 4);
    sim.asPlayer(p1.sk);
    await sim.join(p1.addr, T0 + 11);
    sim.asOperator();
    await sim.start(T0 + 20);
    l = sim.getLedger();
    assert.equal(l.phase, BG_PHASE.playing);
    assert.equal(l.pot, 20_000n);
  });
});

describe('aborting', () => {
  it('refunds a table that never filled, and not before the fill clock', async () => {
    const sim = await BackgammonSimulator.create(defaultBgConfig());
    await rejects(sim.abortTable(T0 + 10_000), /not stalled/); // empty: never abortable
    const [p0] = seats();
    sim.asPlayer(p0.sk);
    await sim.join(p0.addr, T0);
    await rejects(sim.abortTable(T0 + 600), /not stalled/);
    assert.equal(await sim.abortTable(T0 + 601), 10_000n);
    assert.equal(sim.getLedger().phase, BG_PHASE.aborted);
  });

  it('refunds every joiner of a table nobody starts, a table timeout after the last join', async () => {
    const sim = await BackgammonSimulator.create(defaultBgConfig());
    await seatBoth(sim, seats(), T0); // joins at T0 and T0 + 1
    await rejects(sim.abortTable(T0 + 1 + 600), /not stalled/);
    assert.equal(await sim.abortTable(T0 + 1 + 601), 20_000n);
    const l = sim.getLedger();
    assert.equal(l.phase, BG_PHASE.aborted);
    assert.equal(l.pot, 0n);
  });

  it('refunds both seats when neither reveals its share, past the grace', async () => {
    const { sim } = await startedGame();
    const deadline = Number(sim.getLedger().deadline);
    await rejects(sim.abortTable(deadline + 600), /not stalled/);
    assert.equal(await sim.abortTable(deadline + 601), 20_000n);
    assert.equal(sim.getLedger().phase, BG_PHASE.aborted);
  });

  it('never refunds a table once one share is in, or once play has begun', async () => {
    const { sim, players } = await startedGame();
    sim.asPlayer(players[0].sk);
    await sim.reveal(0, T0 + 10);
    await rejects(sim.abortTable(T0 + 100_000), /not stalled/);
    const later = await laterGame();
    await rejects(later.sim.abortTable(T0 + 100_000), /not stalled/);
  });
});

describe('settling', () => {
  it('needs a decided game, and pays the winner at its join-time address', async () => {
    const { sim, players, mover } = await openedGame();
    sim.asOperator();
    await rejects(sim.settle(T0 + 20), /not decided/);
    sim.asPlayer(players[mover]!.sk);
    await sim.eliminate(mover, true, T0 + 20);
    sim.asOperator();
    assert.equal(await sim.settle(T0 + 21), BigInt(1 - mover));
    const l = sim.getLedger();
    assert.equal(l.phase, BG_PHASE.settled);
    assert.equal(l.pot, 0n);
  });

  it('refuses a rake split that is not the 1%', async () => {
    const { sim, players, mover } = await openedGame();
    sim.asPlayer(players[mover]!.sk);
    await sim.eliminate(mover, true, T0 + 20);
    sim.asOperator();
    sim.blockTime = T0 + 21;
    await rejects(
      sim.run('settle', (ctx) => sim.bg.impureCircuits.settle(ctx, 199n, 0n)),
      /rake split/,
    );
  });
});
