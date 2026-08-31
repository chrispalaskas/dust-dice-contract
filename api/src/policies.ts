/**
 * Hold policies — the pre-declared, deterministic hold rules that resolve a turn's
 * three rolls inside one circuit (see docs/table-contract.md).
 *
 * A player declares one policy for the whole turn; it is applied identically after
 * roll 1 and roll 2 to decide which dice are kept. Category choice stays manual
 * (pipelined into the next takeTurn), so policies only encode roll strategy.
 *
 * Every rule here must stay cheap to express in-circuit: per-die predicates and
 * face counts only. The final shipped set is pruned by circuit measurements; the
 * enum values are contract-canonical once shipped — never reorder.
 */

import type { Dice, Die } from './rules.js';

export enum HoldPolicy {
  /** Take roll 1 as final (rolls 2 and 3 are skipped). */
  Stand = 0,
  /** Reroll everything, both times: final dice are roll 3 in full. */
  RerollAll = 1,
  /** Keep every die showing the modal face (tie between counts → higher face). */
  KeepModal = 2,
  /** Keep every die showing `param` (1–6). Chases an upper category or n-of-a-kind. */
  KeepFace = 3,
  /** Keep one die per distinct face (lowest die index per face); reroll duplicates. Chases straights. */
  ChaseStraight = 4,
  /** Keep every face that appears at least twice. Chases full house / n-of-a-kind. */
  KeepPairsPlus = 5,
}

export interface PolicyChoice {
  readonly policy: HoldPolicy;
  /** Face 1–6 for KeepFace; must be 0 otherwise (canonical encoding for the circuit). */
  readonly param: number;
}

export class PolicyError extends Error {}

export function validatePolicy(choice: PolicyChoice): void {
  if (choice.policy === HoldPolicy.KeepFace) {
    if (choice.param < 1 || choice.param > 6 || !Number.isInteger(choice.param)) {
      throw new PolicyError(`KeepFace needs param 1–6, got ${choice.param}`);
    }
  } else if (choice.param !== 0) {
    throw new PolicyError(`policy ${HoldPolicy[choice.policy]} takes no param`);
  }
}

/**
 * The hold mask for `dice` under `choice`: true = kept, false = rerolled.
 * Deterministic and index-stable — the circuit computes the identical mask.
 */
export function holdMask(choice: PolicyChoice, dice: Dice): boolean[] {
  validatePolicy(choice);
  const counts = [0, 0, 0, 0, 0, 0, 0];
  for (const d of dice) counts[d]++;

  switch (choice.policy) {
    case HoldPolicy.Stand:
      return [true, true, true, true, true];
    case HoldPolicy.RerollAll:
      return [false, false, false, false, false];
    case HoldPolicy.KeepModal: {
      let modal = 1;
      for (let f = 2; f <= 6; f++) if (counts[f] >= counts[modal]) modal = f;
      return dice.map((d) => d === modal);
    }
    case HoldPolicy.KeepFace:
      return dice.map((d) => d === choice.param);
    case HoldPolicy.ChaseStraight: {
      const seen = [false, false, false, false, false, false, false];
      return dice.map((d) => {
        if (seen[d]) return false;
        seen[d] = true;
        return true;
      });
    }
    case HoldPolicy.KeepPairsPlus:
      return dice.map((d) => counts[d] >= 2);
  }
}

/**
 * Resolve a full turn: roll 1 in full, then up to two rerolls of the non-held
 * dice. `nextDie` is the deterministic dice stream (the rejection-ladder mirror
 * seeded from the roll hash); dice are consumed strictly left-to-right per
 * reroll so the circuit and this mirror agree.
 *
 * **The hold mask is latched from roll 1** and reused verbatim for the roll-3
 * reroll — it is NOT re-evaluated on roll 2's dice. This is a compiler-imposed
 * constraint (re-evaluating the policy per roll makes compactc 0.34.0's compile
 * time explode — docs/bugs-found.md #1), consistent with "pre-declared hold
 * policy": a die your roll-1 mask did not hold is rerolled in both rerolls even
 * if roll 2 turned it into the face you are chasing. The circuit, this mirror,
 * and the site rules text must all say the same thing.
 *
 * Returns the final dice plus each intermediate roll for the game log.
 */
export function resolveTurnDice(
  choice: PolicyChoice,
  nextDie: () => Die,
): { rolls: Dice[]; final: Dice } {
  const rollAll = (): Dice =>
    [nextDie(), nextDie(), nextDie(), nextDie(), nextDie()] as unknown as Dice;

  const r1 = rollAll();
  if (choice.policy === HoldPolicy.Stand) return { rolls: [r1], final: r1 };

  const held = holdMask(choice, r1); // latched — see doc comment
  const reroll = (prev: Dice): Dice =>
    prev.map((die, i) => (held[i] ? die : nextDie())) as unknown as Dice;

  const r2 = reroll(r1);
  const r3 = reroll(r2);
  return { rolls: [r1, r2, r3], final: r3 };
}
