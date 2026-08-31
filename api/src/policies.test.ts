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

  it('held dice survive rerolls, non-held are replaced in index order', () => {
    // roll1: 4,4,1,2,4 → KeepFace(4) holds idx 0,1,4; reroll idx 2,3 with (4,4) → all fours after roll 2
    const { rolls, final } = resolveTurnDice(
      p(HoldPolicy.KeepFace, 4),
      streamOf(4, 4, 1, 2, 4, /* roll2 rerolls: */ 4, 4, /* roll3 rerolls: */ ...[]),
    );
    expect(rolls[1]).toEqual([4, 4, 4, 4, 4]);
    expect(final).toEqual([4, 4, 4, 4, 4]); // roll 3 holds everything, consumes nothing
    expect(rolls).toHaveLength(3);
  });
});
