/** Scratch: what does each circuit of a turn cost the on-chain VM? Run, do not commit. */
import { TableSimulator, userAddress, ZERO_BYTES32 } from './simulator.ts';
import * as vrf from '../vrf.ts';
import { pureCircuits } from '../managed/table/contract/index.js';

const SECRET = 0x5eedn * 1_000_003n + 7n;
const b32 = (f: number) => new Uint8Array(32).fill(f);
const sim = await TableSimulator.create({
  tableId: b32(0x11),
  tier: 1_000_000n,
  seats: 2n,
  rakeAddress: userAddress(0xee),
  vrfSecret: SECRET,
  vrfPublicKey: vrf.vrfPublicKeyOf(SECRET),
  turnTimeoutSecs: 600n,
  tableTimeoutSecs: 3_600n,
  fastMode: false,
  startAfterSecs: 0n,
  inviteHash: ZERO_BYTES32(),
});
const skA = b32(0xa1);
sim.asPlayer(skA);
await sim.join(userAddress(0x01), 1_000);
sim.asPlayer(b32(0xb2));
await sim.join(userAddress(0x02), 1_010);
sim.asPlayer(skA);
await sim.openTurn(0, pureCircuits.forcedEntropy(skA, b32(0x11), sim.getLedger().openRound));
sim.asOperator();
await sim.resolveRoll(0);
sim.asPlayer(skA);
await sim.hold(0, [true, false, true, false, false]);
const show = (v: unknown): string =>
  JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x));
for (const [id, cost] of sim.gasCost) console.log(`${id.padEnd(13)} ${show(cost)}`);
process.exit(0);
