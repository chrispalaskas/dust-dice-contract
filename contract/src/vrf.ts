// Copyright (C) Shielded Technologies
// SPDX-License-Identifier: Apache-2.0

/**
 * The off-chain halves of the blind VRF: what the operator computes, and what the player does
 * before and after it.
 *
 * EVERY CURVE OPERATION GOES THROUGH THE CONTRACT'S OWN PURE CIRCUITS. Not a TypeScript Jubjub
 * implementation — that is how this class of protocol usually dies, with one curve detail
 * differing and the failure surfacing as "invalid proof" with nothing pointing at the
 * arithmetic. The only thing computed here that the circuits do not provide is the modular
 * inverse used to unblind, and that is checked by the contract anyway (`S == rho*Gamma`).
 *
 * The protocol is docs/vrf-dice.md. In one line: the player asks `B = rho*P` for a point `P`
 * only it can form, the operator answers `S = x*B` with a proof that the `x` behind the sealed
 * public key produced it, and the player unblinds to `Gamma = x*P`, from which the dice fall
 * out. The operator never sees `P` and so never learns the roll.
 */

import { pureCircuits } from './managed/table/contract/index.js';
import type { JubjubPoint } from '@midnight-ntwrk/compact-runtime';

/**
 * Jubjub's prime-order subgroup.
 *
 * Verified rather than assumed: `(r-1)G + G` is the identity, and `r` itself is refused.
 */
export const JUBJUB_ORDER =
  6554484396890773809930967563523245729705921265872317281365359162392183254199n;

const mod = (a: bigint, m = JUBJUB_ORDER): bigint => ((a % m) + m) % m;

/** A scalar drawn well above the order, so the reduction leaves no usable bias. */
export function randomScalar(bytes: Uint8Array): bigint {
  if (bytes.length < 48) throw new Error('randomScalar needs at least 48 bytes of entropy');
  let acc = 0n;
  for (const b of bytes) acc = (acc << 8n) | BigInt(b);
  return mod(acc);
}

/** Modular inverse by the extended Euclidean algorithm. */
export function inverse(a: bigint, m = JUBJUB_ORDER): bigint {
  let [oldR, r] = [mod(a, m), m];
  let [oldS, s] = [1n, 0n];
  while (r !== 0n) {
    const q = oldR / r;
    [oldR, r] = [r, oldR - q * r];
    [oldS, s] = [s, oldS - q * s];
  }
  if (oldR !== 1n) throw new Error('scalar is not invertible');
  return mod(oldS, m);
}

export const samePoint = (a: JubjubPoint, b: JubjubPoint): boolean => a.x === b.x && a.y === b.y;

/** The table's public key, `PK = x*G`, sealed into the contract at deploy. */
export const vrfPublicKeyOf = (secret: bigint): JubjubPoint => pureCircuits.vrfGeneratorMul(secret);

/**
 * The player, step one: the point only this seat can form, and the blinded version of it.
 *
 * `holdMask` is the hold the roll is taken UNDER — empty for roll 1. The contract rebuilds this
 * same point at reveal time from its own ledger state, so a query built on anything else is
 * refused.
 */
export function blindQuery(args: {
  tableId: Uint8Array;
  round: bigint;
  rollIndex: bigint;
  holdMask: bigint;
  seatSecret: Uint8Array;
  blinding: bigint;
}): { inputPoint: JubjubPoint; blinded: JubjubPoint } {
  const inputPoint = pureCircuits.vrfInputPoint(
    args.tableId,
    args.round,
    args.rollIndex,
    args.holdMask,
    args.seatSecret,
  );
  return { inputPoint, blinded: pureCircuits.vrfScalarMul(inputPoint, args.blinding) };
}

/** A Chaum-Pedersen proof, in the shape `resolveRoll1`/`resolveReroll` take it. */
export interface DleqProof {
  readonly a1: JubjubPoint;
  readonly a2: JubjubPoint;
  readonly z: bigint;
}

/**
 * The operator: apply the table key to a point it cannot interpret, and prove it used that key.
 *
 * `c` is NOT part of the proof. It is a function of the transcript, so shipping it would let a
 * verifier that trusted it accept anything; the contract recomputes it, and so does `verifyDleq`
 * below. `nonce` must be fresh per answer — reusing one across two answers leaks `x`.
 */
export function evaluate(
  secret: bigint,
  blinded: JubjubPoint,
  nonce: bigint,
): {
  response: JubjubPoint;
  proof: DleqProof;
} {
  const response = pureCircuits.vrfScalarMul(blinded, secret);
  const a1 = pureCircuits.vrfGeneratorMul(nonce);
  const a2 = pureCircuits.vrfScalarMul(blinded, nonce);
  const pk = pureCircuits.vrfGeneratorMul(secret);
  const c = mod(pureCircuits.vrfChallenge(pk, blinded, response, a1, a2));
  return { response, proof: { a1, a2, z: mod(nonce + c * secret) } };
}

/**
 * Anyone: does this response really come from the key behind `pk`?
 *
 * The player runs this BEFORE accepting the dice, so a bad answer is caught in the browser
 * rather than costing a transaction. The contract runs the same check in `vrfDleqHolds`.
 */
export const verifyDleq = (
  pk: JubjubPoint,
  blinded: JubjubPoint,
  response: JubjubPoint,
  proof: DleqProof,
): boolean => pureCircuits.vrfDleqHolds(pk, blinded, response, proof.a1, proof.a2, proof.z);

/** The player, step two: `Gamma = rho^-1 * S`. */
export const unblind = (response: JubjubPoint, blinding: bigint): JubjubPoint =>
  pureCircuits.vrfScalarMul(response, inverse(blinding));

/** The 32 bytes this roll's dice are derived from. */
export const rollDigest = (gamma: JubjubPoint): Uint8Array => pureCircuits.vrfRollDigest(gamma);
