/**
 * A minimal bech32m decoder, for turning a wallet's unshielded (NIGHT) address into the raw 32
 * bytes a circuit's `UserAddress { bytes: Bytes<32> }` argument needs.
 *
 * Why this exists rather than an import: the authoritative decoder lives in
 * `@midnight-ntwrk/wallet-sdk` (`MidnightBech32m` + `UnshieldedAddress`), which is Node-only
 * plumbing in this repo's layout and must not reach a browser bundle — but the browser needs
 * exactly this one conversion to build a `join` transaction, because `payoutTo` is a public
 * circuit argument. `midnight-js-utils` only ships parsers for the *shielded* coin/encryption
 * keys, so there is nothing browser-safe to reuse.
 *
 * This is deliberately the smallest thing that can be correct, and it is checked against the
 * real wallet-sdk decoder in `bech32.test.ts` over generated addresses — a hand-rolled bit
 * unpacker is exactly the kind of code that looks right and is subtly wrong, so it is not
 * trusted on inspection.
 *
 * Reference: BIP-350 (bech32m), which Midnight's address encoding follows.
 */

const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const BECH32M_CONST = 0x2bc830a3;
const GENERATOR = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];

export class Bech32Error extends Error {}

const polymod = (values: readonly number[]): number => {
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) {
      if ((top >>> i) & 1) chk ^= GENERATOR[i];
    }
  }
  return chk;
};

const hrpExpand = (hrp: string): number[] => [
  ...[...hrp].map((c) => c.charCodeAt(0) >>> 5),
  0,
  ...[...hrp].map((c) => c.charCodeAt(0) & 31),
];

/** 5-bit groups to 8-bit bytes, rejecting anything that is not a clean byte payload. */
function convertBits(data: readonly number[]): Uint8Array {
  let acc = 0;
  let bits = 0;
  const out: number[] = [];
  for (const value of data) {
    if (value < 0 || value >>> 5 !== 0) throw new Bech32Error('data value out of range');
    acc = (acc << 5) | value;
    bits += 5;
    while (bits >= 8) {
      bits -= 8;
      out.push((acc >>> bits) & 0xff);
    }
  }
  // A valid payload leaves only zero padding behind; anything else means we mis-parsed.
  if (bits >= 5 || ((acc << (8 - bits)) & 0xff) !== 0) {
    throw new Bech32Error('invalid padding in bech32 data');
  }
  return new Uint8Array(out);
}

export interface Bech32Decoded {
  readonly hrp: string;
  readonly bytes: Uint8Array;
}

/**
 * Decodes a bech32m string, verifying the checksum.
 *
 * The checksum check is not optional politeness: a mistyped or truncated address that still
 * decoded would silently record the wrong `payoutTo` on a seat, and the contract pays whatever
 * it was told at join time — a typo would send a won pot into a hole.
 */
export function decodeBech32m(input: string): Bech32Decoded {
  if (input !== input.toLowerCase() && input !== input.toUpperCase()) {
    throw new Bech32Error('mixed-case bech32 string');
  }
  const s = input.toLowerCase();
  const split = s.lastIndexOf('1');
  if (split < 1 || split + 7 > s.length) {
    throw new Bech32Error(`not a bech32m string: ${input.slice(0, 24)}…`);
  }
  const hrp = s.slice(0, split);
  const dataPart = s.slice(split + 1);

  const values: number[] = [];
  for (const c of dataPart) {
    const idx = CHARSET.indexOf(c);
    if (idx === -1) throw new Bech32Error(`invalid bech32 character '${c}'`);
    values.push(idx);
  }
  if (polymod([...hrpExpand(hrp), ...values]) !== BECH32M_CONST) {
    throw new Bech32Error('bech32m checksum mismatch — is the address complete and correct?');
  }

  return { hrp, bytes: convertBits(values.slice(0, -6)) };
}

/**
 * The 32 bytes behind an unshielded (NIGHT) bech32m address, as a plain `Uint8Array` — which is
 * what the compact runtime's argument check requires (not a Buffer, not a subarray view).
 *
 * @param expectedNetworkId When given, the address's network is checked against it. A
 *   well-formed address for the wrong chain is otherwise accepted here and rejected much later,
 *   after a proof has been paid for.
 */
export function unshieldedAddressBytes(bech32: string, expectedNetworkId?: string): Uint8Array {
  const { hrp, bytes } = decodeBech32m(bech32);
  if (bytes.length !== 32) {
    throw new Bech32Error(
      `address decoded to ${bytes.length} bytes, expected 32 — is this an unshielded address? ` +
        `(prefix '${hrp}')`,
    );
  }
  if (expectedNetworkId !== undefined && !hrp.endsWith(expectedNetworkId)) {
    throw new Bech32Error(
      `address '${hrp}…' is not for network '${expectedNetworkId}' — wrong wallet network?`,
    );
  }
  return new Uint8Array(bytes);
}
