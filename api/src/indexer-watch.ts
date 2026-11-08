// Copyright (C) Shielded Technologies
// SPDX-License-Identifier: Apache-2.0

/**
 * TOLD WHEN A TABLE CHANGES, INSTEAD OF ASKING EVERY FEW SECONDS.
 *
 * Since 2026-10-28 the indexer is Blockfrost's, and Blockfrost bills every HTTP request against a
 * daily quota (Starter: 50,000). The operator asked each table "what do you look like now?" every
 * 3-15 s and the chain clock every 3-5 s; nearly every answer was "the same", and idle that came
 * to ~30 requests a minute from the operator alone -- most of a day's quota before anyone played.
 *
 * WebSocket traffic is not billed per message. Measured the same day: four wallets cold-syncing
 * for 75 minutes over twelve sockets (1.7M+ events each, a keep-alive ping every 15 s) cost ~200
 * requests. So each socket here carries:
 *
 *   * `blocks` -- every new block, ~6 s apart. It is the CLOCK (the tip's timestamp, which is
 *     what `chainNowSecs` used to fetch) and the socket's HEARTBEAT: no block for `STALE_MS` means
 *     the socket is dead whatever it claims, and it is replaced.
 *   * `contractActions(address)` per watched table -- one message per transaction that touches it.
 *
 * SEVERAL SOCKETS: Blockfrost refuses an eleventh subscription on one connection ("per-connection
 * limit exceeded (10)", measured 2026-10-28 with the operator's thirteen addresses). So tables are
 * spread over shards of `TABLES_PER_SOCKET`, each socket with its own heartbeat.
 *
 * A PUSH IS A NUDGE, NEVER THE STATE. A message only records "this table changed at T"; the
 * reader still reads the table with its usual one-shot query (verifier `readContractState`).
 * Pushed state is exactly what bugs-found.md §0 #10 warns about -- the SDK's observable missed
 * rapid successive updates -- and a missed or late nudge here costs latency, not correctness:
 * readers keep a slow safety re-read, and fall back to their old timed reads whenever a table is
 * not `watching`.
 *
 * Measured against Blockfrost preprod, 2026-10-28: `blocks` with no offset starts at the tip and
 * arrives ~14 s after each block's own timestamp (the indexer's lag -- polling saw the same), and
 * its tip matched the HTTP query's to the second. `contractActions` replays from its `offset` --
 * the contract's WHOLE history without one -- so a shard subscribes its tables only once its first
 * block has said where the tip is, from `REPLAY_BLOCKS` before it: anything that lands while the
 * subscription warms up (its first message took 15-25 s) is replayed rather than missed.
 */

/** The slice of a WebSocket this needs; Node's global one (22+) and tests' fakes both fit. */
export interface WatchSocket {
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code?: number; reason?: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  send(data: string): void;
  close(): void;
}

export interface IndexerWatchOptions {
  /** The indexer's GraphQL WebSocket URL, token included (`?project_id=` for Blockfrost). */
  readonly url: string;
  readonly log: (msg: string) => void;
  readonly connect?: (url: string) => WatchSocket;
  readonly now?: () => number;
}

export interface IndexerWatchStats {
  /** The clock's socket is up and blocks are arriving. */
  readonly healthy: boolean;
  readonly sockets: number;
  /** Tables whose pushes are being delivered right now. */
  readonly watched: number;
  readonly pushes: number;
  readonly reconnects: number;
  /** Milliseconds since the clock's socket last saw a block; null before the first. */
  readonly lastBlockAgeMs: number | null;
}

/** No block for this long and a socket is presumed dead: blocks are ~6 s apart. */
export const STALE_MS = 60_000;
/** Subscribe this many blocks behind the tip, so nothing landing during the warm-up is missed. */
export const REPLAY_BLOCKS = 5;
/**
 * After a push, a reader reads the table once at once and once more this long later. Blockfrost
 * may answer the read from a replica a moment behind the one that pushed; the second read is the
 * one that sees the change if the first did not.
 */
export const PUSH_SETTLE_MS = 3_000;
/** Blockfrost's limit is ten subscriptions per connection, and one is the heartbeat. */
export const TABLES_PER_SOCKET = 9;
/** A table subscription the indexer ended is asked for again after this long. */
const RESUBSCRIBE_MS = 30_000;
const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

const BLOCKS_ID = 'blocks';
const BLOCKS_QUERY = 'subscription { blocks { height timestamp } }';
const ACTIONS_QUERY = `subscription ($address: HexEncoded!, $offset: BlockOffset) {
  contractActions(address: $address, offset: $offset) { __typename }
}`;

const norm = (address: string): string => address.replace(/^0x/, '').toLowerCase();

/** What a shard reports to its watch. */
interface ShardHost {
  readonly url: string;
  readonly log: (msg: string) => void;
  readonly connect: (url: string) => WatchSocket;
  readonly now: () => number;
  changed(address: string): void;
  reconnected(): void;
}

/** One socket: a block heartbeat and up to `TABLES_PER_SOCKET` table subscriptions. */
class Shard {
  readonly #h: ShardHost;
  readonly #name: string;
  #ws: WatchSocket | null = null;
  #acked = false;
  #stopped = true;
  #backoff = RECONNECT_MIN_MS;
  #retry: ReturnType<typeof setTimeout> | null = null;
  #tip: { height: number; timestamp: number; at: number } | null = null;
  /** Each table this socket carries, and whether its subscription is live right now. */
  readonly tables = new Map<string, { live: boolean }>();

  constructor(host: ShardHost, name: string) {
    this.#h = host;
    this.#name = name;
  }

  start(): void {
    if (!this.#stopped) return;
    this.#stopped = false;
    this.#open();
  }

  stop(): void {
    this.#stopped = true;
    if (this.#retry) clearTimeout(this.#retry);
    this.#retry = null;
    this.#drop(false);
  }

  get healthy(): boolean {
    return this.#acked && this.#tip !== null && this.#h.now() - this.#tip.at < STALE_MS;
  }

  get tip(): { height: number; timestamp: number; at: number } | null {
    return this.healthy ? this.#tip : null;
  }

  get lastBlockAt(): number | null {
    return this.#tip?.at ?? null;
  }

  live(address: string): boolean {
    return this.healthy && this.tables.get(address)?.live === true;
  }

  add(address: string): void {
    if (this.tables.has(address)) return;
    this.tables.set(address, { live: false });
    // Before the first block there is no tip to subscribe from; the first block does it.
    if (this.#acked && this.#tip) this.#subscribe(address);
  }

  remove(address: string): void {
    const t = this.tables.get(address);
    if (!t) return;
    this.tables.delete(address);
    if (t.live && this.#acked) this.#send({ id: `c:${address}`, type: 'complete' });
  }

  /** Called by the watch's stale timer. */
  checkStale(): void {
    if (this.#stopped || !this.#ws || !this.#acked || !this.#tip) return;
    if (this.#h.now() - this.#tip.at < STALE_MS) return;
    this.#h.log(`indexer watch ${this.#name}: no block for ${STALE_MS / 1000} s; new socket`);
    this.#drop(true);
    this.#scheduleReconnect();
  }

  #open(): void {
    let ws: WatchSocket;
    try {
      ws = this.#h.connect(this.#h.url);
    } catch (err) {
      this.#h.log(`indexer watch ${this.#name}: cannot open the socket: ${String(err)}`);
      this.#scheduleReconnect();
      return;
    }
    this.#ws = ws;
    ws.onopen = () => ws.send(JSON.stringify({ type: 'connection_init' }));
    ws.onmessage = (ev) => {
      if (this.#ws === ws) this.#onMessage(String(ev.data));
    };
    // `onclose` follows an error; reconnecting there keeps one path.
    ws.onerror = () => {};
    ws.onclose = (ev) => {
      if (this.#ws !== ws) return;
      const why = `${ev.code ?? '?'} ${ev.reason ?? ''}`.trim();
      this.#h.log(`indexer watch ${this.#name}: socket closed (${why})`);
      this.#drop(true);
      this.#scheduleReconnect();
    };
  }

  #onMessage(raw: string): void {
    let m: { type: string; id?: string; payload?: unknown };
    try {
      m = JSON.parse(raw) as typeof m;
    } catch {
      return;
    }
    switch (m.type) {
      case 'connection_ack':
        this.#acked = true;
        this.#backoff = RECONNECT_MIN_MS;
        this.#send({ id: BLOCKS_ID, type: 'subscribe', payload: { query: BLOCKS_QUERY } });
        return;
      case 'ping':
        this.#send({ type: 'pong' });
        return;
      case 'next':
        this.#onNext(m.id ?? '', m.payload);
        return;
      case 'error':
        this.#ended(m.id ?? '', `refused: ${errorText(m.payload)}`);
        return;
      case 'complete':
        this.#ended(m.id ?? '', 'completed by the indexer');
        return;
    }
  }

  #onNext(id: string, payload: unknown): void {
    const p = payload as { data?: Record<string, unknown>; errors?: { message: string }[] };
    if (p.errors?.length) {
      this.#ended(id, p.errors.map((e) => e.message).join('; '));
      return;
    }
    if (id === BLOCKS_ID) {
      const b = p.data?.blocks as { height: number; timestamp: number | string } | undefined;
      if (!b) return;
      const first = this.#tip === null;
      this.#tip = { height: b.height, timestamp: Number(b.timestamp), at: this.#h.now() };
      if (first) for (const a of this.tables.keys()) this.#subscribe(a);
      return;
    }
    if (id.startsWith('c:') && this.tables.get(id.slice(2))?.live) this.#h.changed(id.slice(2));
  }

  /**
   * A subscription the indexer refused or ended. A table stops counting as watched -- its reader
   * reads it now and is back on its timers -- and is asked for again later. The indexer follows
   * an `error` with a `complete` for the same id; only the first is acted on. The heartbeat
   * ending is the socket's end.
   */
  #ended(id: string, why: string): void {
    if (id === BLOCKS_ID) {
      this.#h.log(`indexer watch ${this.#name}: block stream ended (${why}); new socket`);
      this.#drop(true);
      this.#scheduleReconnect();
      return;
    }
    if (!id.startsWith('c:')) return;
    const a = id.slice(2);
    const t = this.tables.get(a);
    if (!t?.live) return;
    t.live = false;
    this.#h.changed(a);
    this.#h.log(`indexer watch: ${a.slice(0, 12)}…: ${why}; again in ${RESUBSCRIBE_MS / 1000} s`);
    const again = setTimeout(() => {
      if (this.#acked && this.#tip && this.tables.get(a) === t && !t.live) this.#subscribe(a);
    }, RESUBSCRIBE_MS);
    again.unref?.();
  }

  #subscribe(a: string): void {
    const t = this.tables.get(a);
    if (!t || !this.#tip) return;
    this.#send({
      id: `c:${a}`,
      type: 'subscribe',
      payload: {
        query: ACTIONS_QUERY,
        variables: {
          address: a,
          offset: { height: Math.max(0, this.#tip.height - REPLAY_BLOCKS) },
        },
      },
    });
    t.live = true;
  }

  #send(msg: unknown): void {
    try {
      this.#ws?.send(JSON.stringify(msg));
    } catch (err) {
      this.#h.log(`indexer watch ${this.#name}: send failed: ${String(err)}`);
    }
  }

  /**
   * Forget the socket. `presume`: every table it carried is presumed changed -- whatever landed
   * while nobody listened was never pushed, so each reader reads its tables once more.
   */
  #drop(presume: boolean): void {
    const ws = this.#ws;
    this.#ws = null;
    const wasUp = this.#acked;
    this.#acked = false;
    this.#tip = null;
    for (const t of this.tables.values()) t.live = false;
    if (presume && wasUp) for (const a of this.tables.keys()) this.#h.changed(a);
    if (ws) {
      ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
      try {
        ws.close();
      } catch {
        // Already closing.
      }
    }
  }

  #scheduleReconnect(): void {
    if (this.#stopped || this.#retry) return;
    const delay = this.#backoff;
    this.#backoff = Math.min(RECONNECT_MAX_MS, this.#backoff * 2);
    this.#h.reconnected();
    this.#retry = setTimeout(() => {
      this.#retry = null;
      if (!this.#stopped) this.#open();
    }, delay);
    this.#retry.unref?.();
  }
}

const errorText = (payload: unknown): string => {
  const list = Array.isArray(payload) ? payload : [payload];
  return list
    .map((e) => (e as { message?: string })?.message ?? JSON.stringify(e))
    .join('; ')
    .slice(0, 200);
};

export class IndexerWatch {
  readonly #host: ShardHost;
  readonly #now: () => number;
  /** Shard 0 always exists: its heartbeat is the clock, watched tables or not. */
  readonly #shards: Shard[] = [];
  #started = false;
  #staleTimer: ReturnType<typeof setInterval> | null = null;
  #nextShard = 0;

  readonly #changedAt = new Map<string, number>();
  readonly #waiters = new Map<string, Set<() => void>>();
  #pushes = 0;
  #reconnects = 0;

  constructor(o: IndexerWatchOptions) {
    this.#now = o.now ?? Date.now;
    this.#host = {
      url: o.url,
      log: o.log,
      connect: o.connect ?? ((url) => new WebSocket(url, 'graphql-transport-ws') as never),
      now: this.#now,
      changed: (a) => this.#changed(a),
      reconnected: () => void (this.#reconnects += 1),
    };
    this.#shards.push(this.#newShard());
  }

  start(): void {
    if (this.#started) return;
    this.#started = true;
    for (const s of this.#shards) s.start();
    this.#staleTimer = setInterval(() => {
      for (const s of this.#shards) s.checkStale();
    }, 5_000);
    this.#staleTimer.unref?.();
  }

  stop(): void {
    this.#started = false;
    if (this.#staleTimer) clearInterval(this.#staleTimer);
    for (const s of this.#shards) s.stop();
  }

  /** The clock's socket is up and blocks are arriving. */
  get healthy(): boolean {
    return this.#shards[0]!.healthy;
  }

  /** Is a push for this address being delivered right now? */
  watching(address: string): boolean {
    const a = norm(address);
    return this.#shardOf(a)?.live(a) === true;
  }

  /** When this table was last pushed (or presumed changed after a gap); undefined if never. */
  changedAt(address: string): number | undefined {
    return this.#changedAt.get(norm(address));
  }

  /** The latest block any healthy socket has seen, or null when none can vouch for one. */
  tip(): { height: number; timestamp: number } | null {
    let best: { height: number; timestamp: number } | null = null;
    for (const s of this.#shards) {
      const t = s.tip;
      if (t && (!best || t.height > best.height))
        best = { height: t.height, timestamp: t.timestamp };
    }
    return best;
  }

  /** `chainNowSecs` from the pushed tip, or null (the caller then asks the indexer). */
  nowSecs(): bigint | null {
    const t = this.tip();
    return t === null ? null : BigInt(Math.floor(t.timestamp / 1000));
  }

  get stats(): IndexerWatchStats {
    const last = this.#shards[0]!.lastBlockAt;
    let watched = 0;
    for (const s of this.#shards) for (const a of s.tables.keys()) if (s.live(a)) watched += 1;
    return {
      healthy: this.healthy,
      sockets: this.#shards.length,
      watched,
      pushes: this.#pushes,
      reconnects: this.#reconnects,
      lastBlockAgeMs: last === null ? null : this.#now() - last,
    };
  }

  watch(address: string): void {
    const a = norm(address);
    if (this.#shardOf(a)) return;
    let shard = this.#shards.find((s) => s.tables.size < TABLES_PER_SOCKET);
    if (!shard) {
      shard = this.#newShard();
      this.#shards.push(shard);
      if (this.#started) shard.start();
    }
    shard.add(a);
  }

  unwatch(address: string): void {
    const a = norm(address);
    const shard = this.#shardOf(a);
    if (!shard) return;
    shard.remove(a);
    this.#changedAt.delete(a);
    // An emptied extra socket is closed; the first one stays, for the clock.
    const i = this.#shards.indexOf(shard);
    if (i > 0 && shard.tables.size === 0) {
      shard.stop();
      this.#shards.splice(i, 1);
    }
  }

  /** Watch exactly these addresses: new ones subscribed, the rest released. */
  reconcile(addresses: Iterable<string>): void {
    const keep = new Set([...addresses].map(norm));
    for (const s of [...this.#shards]) {
      for (const a of [...s.tables.keys()]) if (!keep.has(a)) this.unwatch(a);
    }
    for (const a of keep) this.watch(a);
  }

  /**
   * Resolve on the next push for `address`, or after `ms` -- whichever is first. A loop that used
   * to sleep a fixed poll between reads awaits this instead; when the table is not watched it
   * just sleeps `ms`, so the caller's own interval still bounds it.
   */
  waitForChange(address: string, ms: number): Promise<void> {
    const a = norm(address);
    return new Promise((resolve) => {
      const set = this.#waiters.get(a) ?? new Set();
      const done = (): void => {
        clearTimeout(timer);
        set.delete(done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      set.add(done);
      this.#waiters.set(a, set);
    });
  }

  #newShard(): Shard {
    return new Shard(this.#host, `#${this.#nextShard++}`);
  }

  #shardOf(a: string): Shard | undefined {
    return this.#shards.find((s) => s.tables.has(a));
  }

  #changed(a: string): void {
    this.#pushes += 1;
    this.#changedAt.set(a, this.#now());
    const waiting = this.#waiters.get(a);
    if (waiting) for (const done of [...waiting]) done();
  }
}
