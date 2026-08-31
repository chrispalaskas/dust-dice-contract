import { describe, expect, it } from 'vitest';
import type { Dice, Die } from './rules.js';
import { HoldPolicy, holdMask, PolicyError, resolveTurnDice, validatePolicy } from './policies.js';

const d = (...v: number[]) => v as unknown as Dice;
const p = (policy: HoldPolicy, param = 0) => ({ policy, param });

describe('validatePolicy', () => {
  it('KeepFace requires 1–6, others require 0', () => {
    expect(() => validatePolicy(p(HoldPolicy.KeepFace, 0))).toThrow(PolicyError);
    expect(() => validatePolicy(p(HoldPolicy.KeepFace, 7))).toThrow(PolicyError);
    expect(() => validatePolicy(p(HoldPolicy.KeepModal, 3))).toThrow(PolicyError);
    expect(() => validatePolicy(p(HoldPolicy.KeepFace, 4))).not.toThrow();
    expect(() => validatePolicy(p(HoldPolicy.Stand))).not.toThrow();
  });
});

describe('holdMask', () => {
  it('Stand keeps all, RerollAll keeps none', () => {
    expect(holdMask(p(HoldPolicy.Stand), d(1, 2, 3, 4, 5))).toEqual([true, true, true, true, true]);
    expect(holdMask(p(HoldPolicy.RerollAll), d(1, 2, 3, 4, 5))).toEqual([
      false,
      false,
      false,
      false,
      false,
    ]);
  });

  it('KeepModal keeps the modal face, count tie broken toward the higher face', () => {
    expect(holdMask(p(HoldPolicy.KeepModal), d(3, 3, 5, 2, 3))).toEqual([
      true,
      true,
      false,
      false,
      true,
    ]);
    // 2 twos vs 2 fives → higher face (5) wins the tie
    expect(holdMask(p(HoldPolicy.KeepModal), d(2, 2, 5, 5, 1))).toEqual([
      false,
      false,
      true,
      true,
      false,
    ]);
    // all distinct → every count is 1 → modal resolves to 6-ward: highest present face...
    // all faces count 1 except missing ones count 0; tie among present → highest present face
    expect(holdMask(p(HoldPolicy.KeepModal), d(1, 2, 3, 4, 6))).toEqual([
      false,
      false,
      false,
      false,
      true,
    ]);
  });

  it('KeepFace keeps exactly that face', () => {
    expect(holdMask(p(HoldPolicy.KeepFace, 4), d(4, 1, 4, 6, 4))).toEqual([
      true,
      false,
      true,
      false,
      true,
    ]);
  });

  it('ChaseStraight keeps first die of each distinct face', () => {
    expect(holdMask(p(HoldPolicy.ChaseStraight), d(3, 3, 4, 5, 5))).toEqual([
      true,
      false,
      true,
      true,
      false,
    ]);
  });

  it('KeepPairsPlus keeps faces appearing at least twice', () => {
    expect(holdMask(p(HoldPolicy.KeepPairsPlus), d(2, 2, 6, 6, 1))).toEqual([
      true,
      true,
      true,
      true,
      false,
    ]);
  });
});

describe('resolveTurnDice', () => {
  const streamOf = (...values: number[]) => {
    let i = 0;
    return () => {
      if (i >= values.length) throw new Error('stream exhausted');
      return values[i++] as Die;
    };
  };

  it('Stand consumes exactly 5 dice and stops', () => {
    const { rolls, final } = resolveTurnDice(p(HoldPolicy.Stand), streamOf(1, 2, 3, 4, 5));
    expect(rolls).toHaveLength(1);
    expect(final).toEqual([1, 2, 3, 4, 5]);
  });

  it('RerollAll consumes 15 dice, final = last five', () => {
    const stream = streamOf(
      ...Array(15)
        .fill(0)
        .map((_, i) => (i % 6) + 1),
    );
    const { rolls, final } = resolveTurnDice(p(HoldPolicy.RerollAll), stream);
    expect(rolls).toHaveLength(3);
    expect(final).toEqual([5, 6, 1, 2, 3]); // dice 11..15 of the stream
  });

  it('hold mask is latched from roll 1: a chased face rolled in roll 2 is still rerolled in roll 3', () => {
    // roll1: 4,4,1,2,4 → KeepFace(4) latches mask [T,T,F,F,T].
    // roll2 rerolls idx 2,3 with (4,4) → 4,4,4,4,4 — but idx 2,3 are NOT re-held:
    // roll3 rerolls them again with (5,6).
    const { rolls, final } = resolveTurnDice(
      p(HoldPolicy.KeepFace, 4),
      streamOf(4, 4, 1, 2, 4, /* roll2 rerolls idx 2,3: */ 4, 4, /* roll3 rerolls idx 2,3: */ 5, 6),
    );
    expect(rolls[1]).toEqual([4, 4, 4, 4, 4]);
    expect(final).toEqual([4, 4, 5, 6, 4]);
    expect(rolls).toHaveLength(3);
  });

  it('held dice survive rerolls, non-held are replaced in index order', () => {
    const { rolls, final } = resolveTurnDice(
      p(HoldPolicy.KeepModal),
      // roll1: 5,5,1,2,3 → modal 5, mask [T,T,F,F,F]; roll2 rerolls idx 2,3,4; roll3 again
      streamOf(5, 5, 1, 2, 3, /* roll2: */ 5, 5, 5, /* roll3: */ 1, 2, 6),
    );
    expect(rolls[1]).toEqual([5, 5, 5, 5, 5]);
    expect(final).toEqual([5, 5, 1, 2, 6]);
    expect(rolls).toHaveLength(3);
  });
});
