/**
 * Dynamic liquidity graph.
 *
 * Instead of calling getAmountsOut on-chain for every candidate (the
 * current scanner's approach — accurate but RPC-heavy and per-candidate
 * latency stacks up), this maintains an in-process cache of pool reserves
 * for a known set of pools, kept current by subscribing to Sync events
 * over the WS RPC. Quoting against the graph is then pure local math (the
 * same constant-product formula bot/scanner.js already uses in
 * quoteConstantProduct) with zero additional RPC calls per candidate.
 *
 * WHY SYNC ALONE (NOT ALSO SWAP/MINT/BURN): every reserve-changing
 * operation on both a UniswapV2 pair and an Aerodrome volatile pool ends
 * by calling an internal _update() that emits Sync(reserve0, reserve1) —
 * confirmed against Aerodrome's own public Pool.sol source, which mirrors
 * UniswapV2's pattern here. Swap/Mint/Burn carry per-operation deltas
 * (useful for volume/LP analytics) but no reserve information Sync
 * doesn't already give you, post-operation, in one shot. Subscribing to
 * all four per pool would triple log volume for the exact same reserve
 * data this graph actually needs — left out deliberately, not missed.
 *
 * VENUE-SPECIFIC EVENT SHAPES: UniswapV2's Sync encodes reserves as
 * uint112 (`Sync(uint112,uint112)`); Aerodrome's encodes them as uint256
 * (`Sync(uint256,uint256)`, confirmed against Aerodrome's IPool.sol). ABI
 * event topics are keccak256 of the canonical signature string, so these
 * are two genuinely different topics, not just a decoding-width detail —
 * a subscription built from one venue's ABI will never match logs from
 * the other. VENUE_SYNC_EVENTS below keys the correct ABI per venue;
 * addPool() refuses an unrecognized venue rather than guessing.
 *
 * SUBSCRIPTION MODEL: one WS subscription per venue (not per pool),
 * filtered to the specific tracked addresses for that venue via viem's
 * multi-address watchEvent support. This scales to however many pools
 * bootstrapGraph() finds without opening a subscription per pool, and
 * keeps reconnect bookkeeping to "a handful of venue subscriptions plus
 * one block-number subscription" instead of N independent ones.
 *
 * WHAT THIS DOES NOT REPLACE: bot/scanner.js's simulateExecution
 * (an eth_call against the exact final calldata) remains the mandatory
 * last check before submit(), in both the old and new designs. This
 * graph is a candidate-generation speed optimization — it tells you
 * which triangle to try, not that the triangle will definitely succeed.
 * A stale or under-confirmed graph entry means a wasted simulation call
 * at worst, not a bad trade, because nothing here ever calls submit()
 * directly.
 *
 * REORG SAFETY: this module does not blindly trust the latest emitted
 * event. Each reserve update is tagged with the block number it came
 * from and only becomes "confirmed" (usable for quoting) once
 * `cfg.graph.confirmationDepth` further blocks have been observed on top
 * of it. This is a real tradeoff, not a guarantee — see cfg.graph's
 * comment. It bounds the exposure window to a documented, configurable
 * size instead of pretending reorgs can't happen on Base.
 *
 * STALENESS SAFETY: if a pool hasn't emitted an event in
 * cfg.graph.maxReserveAgeMs, its cached reserves are treated as stale
 * (covers a dropped WS connection or a genuinely quiet pool) and a
 * caller should refetch via multicall before trusting it — see
 * `isStale()`.
 *
 * CONNECTION LOSS: a dropped WS connection means events emitted during
 * the outage are gone for good — there is no backfill over a live
 * subscription. This module handles that in two layers rather than
 * hoping the underlying transport's own auto-reconnect (viem's
 * webSocket() transport does retry the socket itself) also transparently
 * restores every eth_subscribe-based watcher and backfills what was
 * missed, which it does not:
 *   1. Any subscription's onError (block-number or a venue's Sync
 *      watcher) triggers _reconnectAndResync(): re-establish every
 *      subscription from current in-memory state, then force a
 *      multicall-batched getReserves() read across every tracked pool —
 *      the only way to know current state again after a gap with no
 *      event backfill.
 *   2. Independently, a block-number GAP (the new block number is more
 *      than one past the last one we saw) is treated as a signal that
 *      Sync events may have been missed even without an explicit onError
 *      firing — e.g. the socket reconnected fast enough that only a
 *      skipped block number, not a visible error, is the tell — and
 *      triggers the same full resync.
 * Both paths converge on the same _resyncAll(), so there's exactly one
 * "we might be behind, go re-read everything" code path to reason about.
 */

const { getAddress, encodeFunctionData, decodeFunctionResult } = require("viem");
const cfg = require("../config");

// UniswapV2 (and every faithful fork's) Sync event shape.
const UNIV2_SYNC_EVENT = {
  type: "event",
  name: "Sync",
  inputs: [
    { name: "reserve0", type: "uint112", indexed: false },
    { name: "reserve1", type: "uint112", indexed: false },
  ],
};

// Aerodrome's Sync event shape — same event NAME, different parameter
// types, therefore a different topic0. See this file's header comment.
const AERODROME_SYNC_EVENT = {
  type: "event",
  name: "Sync",
  inputs: [
    { name: "reserve0", type: "uint256", indexed: false },
    { name: "reserve1", type: "uint256", indexed: false },
  ],
};

// venue string (as passed to addPool's opts.venue) -> that venue's Sync
// event ABI. Extend this when a new venue is wired in — addPool() throws
// rather than silently defaulting an unrecognized venue to either shape.
const VENUE_SYNC_EVENTS = {
  univ2: UNIV2_SYNC_EVENT,
  aerodrome: AERODROME_SYNC_EVENT,
};

const PAIR_READ_ABI = [
  {
    name: "getReserves",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "reserve0", type: "uint112" },
      { name: "reserve1", type: "uint112" },
      { name: "blockTimestampLast", type: "uint32" },
    ],
  },
  {
    name: "token0",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
  {
    name: "token1",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
];

// Multicall3 aggregate3 — same pattern as bot/graph/multicallQuoter.js,
// duplicated locally rather than imported since that module's batchQuote
// is router-quote-shaped (venue/tokenIn/tokenOut) and this needs a plain
// per-pool getReserves() batch; different enough domain to not force a
// shared abstraction over.
const MULTICALL3_ABI = [
  {
    name: "aggregate3",
    type: "function",
    stateMutability: "payable",
    inputs: [
      {
        name: "calls",
        type: "tuple[]",
        components: [
          { name: "target", type: "address" },
          { name: "allowFailure", type: "bool" },
          { name: "callData", type: "bytes" },
        ],
      },
    ],
    outputs: [
      {
        type: "tuple[]",
        components: [
          { name: "success", type: "bool" },
          { name: "returnData", type: "bytes" },
        ],
      },
    ],
  },
];

function quoteConstantProduct(amountIn, reserveIn, reserveOut, feeBps) {
  if (reserveIn === 0n || reserveOut === 0n) return 0n;
  const amountInWithFee = amountIn * BigInt(10000 - feeBps);
  const numerator = amountInWithFee * reserveOut;
  const denominator = reserveIn * 10000n + amountInWithFee;
  return denominator === 0n ? 0n : numerator / denominator;
}

class LiquidityGraph {
  /**
   * @param publicClient viem public client (HTTP) — used for initial
   *   getReserves()/token0()/token1() reads and resync-after-reconnect
   *   multicall reads.
   * @param wsClient viem public client (WebSocket) — used for the live
   *   Sync event subscriptions and the block-number subscription this
   *   graph now owns directly (see start()). Required; this graph is
   *   meaningless without event-driven updates (see maxReserveAgeMs
   *   fallback below for what happens if the WS connection dies mid-run).
   */
  constructor(publicClient, wsClient) {
    this.publicClient = publicClient;
    this.wsClient = wsClient;

    // pairAddress (lowercase) -> { token0, token1, feeBps, venue,
    //   reserve0, reserve1, lastUpdateBlock, lastUpdateMs, pendingUpdates: [] }
    this.pools = new Map();

    // venue -> Set of tracked pool addresses (lowercase) for that venue —
    // the address filter each venue's single Sync subscription is built
    // from. Kept separate from `pools` so resubscribing doesn't require
    // scanning the whole pool map.
    this._venueAddresses = new Map();

    // venue -> unwatch function for that venue's current Sync subscription.
    this._venueWatchers = new Map();

    this._blockUnwatch = null;
    this.latestBlock = 0n;
    this._reconnecting = false;
  }

  /// Begin live updates: subscribes to block numbers (needed for both
  /// confirmationDepth graduation via onNewBlock and block-gap detection,
  /// see this file's header comment). Call once after bootstrapping the
  /// initial pool set — addPool() itself only needs to be told about a
  /// pool, it doesn't require start() to have run first, but no reserve
  /// data will update live until it has.
  start() {
    if (this._blockUnwatch) return; // already started
    this._blockUnwatch = this.wsClient.watchBlockNumber({
      onBlockNumber: (blockNumber) => this._handleBlockNumber(blockNumber),
      onError: (err) => this._handleWsError("block-number subscription", err),
    });
  }

  /// Register a pool to track. Reads current reserves once via
  /// getReserves() to seed the cache, then (re)subscribes to that venue's
  /// Sync events with this address added to the filter. Call this once
  /// per known pool at startup (and again for any pool discovered later,
  /// e.g. via the new-pool listener in bot/base-edges/).
  async addPool(pairAddress, { venue, feeBps }) {
    const key = pairAddress.toLowerCase();
    if (this.pools.has(key)) return;

    if (!VENUE_SYNC_EVENTS[venue]) {
      throw new Error(
        `liquidityGraph: addPool() called with unrecognized venue "${venue}" — no Sync event ABI ` +
        `registered for it in VENUE_SYNC_EVENTS. Add the venue's actual, independently-verified Sync ` +
        `event shape there rather than assuming it matches an existing one (see this file's header ` +
        `comment on why UniswapV2's and Aerodrome's shapes genuinely differ).`
      );
    }

    const [reserves, token0, token1] = await Promise.all([
      this.publicClient.readContract({ address: pairAddress, abi: PAIR_READ_ABI, functionName: "getReserves" }),
      this.publicClient.readContract({ address: pairAddress, abi: PAIR_READ_ABI, functionName: "token0" }),
      this.publicClient.readContract({ address: pairAddress, abi: PAIR_READ_ABI, functionName: "token1" }),
    ]);

    const nowMs = Date.now();
    this.pools.set(key, {
      address: getAddress(pairAddress),
      token0: getAddress(token0),
      token1: getAddress(token1),
      venue,
      feeBps,
      reserve0: reserves[0],
      reserve1: reserves[1],
      lastUpdateBlock: this.latestBlock,
      lastUpdateMs: nowMs,
      // Updates observed but not yet past confirmationDepth — applied to
      // the "confirmed" reserve0/reserve1 fields once old enough.
      pendingUpdates: [],
    });

    if (!this._venueAddresses.has(venue)) this._venueAddresses.set(venue, new Set());
    this._venueAddresses.get(venue).add(key);
    await this._resubscribeVenue(venue);
  }

  /// Unwatch and re-watch a single venue's Sync subscription against its
  /// current full address list. viem's watchEvent address filter is fixed
  /// at subscribe time, so adding a pool to an already-live venue means
  /// tearing down and rebuilding that one subscription — cheap (a single
  /// eth_unsubscribe + eth_subscribe) and scoped to just that venue, not
  /// every tracked pool.
  async _resubscribeVenue(venue) {
    const existing = this._venueWatchers.get(venue);
    if (existing) {
      try {
        existing();
      } catch (_) {
        // best-effort — a failed unsubscribe on a possibly-dead socket
        // shouldn't block establishing the replacement subscription.
      }
    }

    const addresses = Array.from(this._venueAddresses.get(venue) || []);
    if (addresses.length === 0) {
      this._venueWatchers.delete(venue);
      return;
    }

    const unwatch = this.wsClient.watchEvent({
      address: addresses,
      event: VENUE_SYNC_EVENTS[venue],
      onLogs: (logs) => this._onSyncLogs(logs),
      onError: (err) => this._handleWsError(`"${venue}" Sync subscription`, err),
    });
    this._venueWatchers.set(venue, unwatch);
  }

  /// Call once per new block (e.g. from start()'s watchBlockNumber
  /// subscription) so pending updates can graduate to confirmed once
  /// they've cleared confirmationDepth, AND so a skipped block number can
  /// be caught as a possible missed-events signal — see this file's header
  /// comment on connection loss.
  _handleBlockNumber(blockNumber) {
    const previousBlock = this.latestBlock;
    // previousBlock > 0n guards the very first tick after start(), where
    // there's nothing to compare against yet.
    if (previousBlock > 0n && blockNumber > previousBlock + 1n) {
      console.warn(
        `liquidityGraph: block-number gap detected (${previousBlock} -> ${blockNumber}) — Sync events ` +
        `may have been missed in between. Forcing a full multicall resync of all tracked pools.`
      );
      this._resyncAll().catch((err) =>
        console.error("liquidityGraph: resync after block gap failed:", err.message)
      );
    }
    this.onNewBlock(blockNumber);
  }

  onNewBlock(blockNumber) {
    this.latestBlock = blockNumber;
    for (const pool of this.pools.values()) {
      pool.pendingUpdates = pool.pendingUpdates.filter((update) => {
        const confirmations = blockNumber - update.blockNumber;
        if (confirmations >= BigInt(cfg.graph.confirmationDepth)) {
          // Only apply if this update is not older than the currently
          // confirmed state (defends against events arriving out of
          // order across a reorg boundary).
          if (update.blockNumber >= pool.lastUpdateBlock) {
            pool.reserve0 = update.reserve0;
            pool.reserve1 = update.reserve1;
            pool.lastUpdateBlock = update.blockNumber;
            pool.lastUpdateMs = Date.now();
          }
          return false; // remove from pending, it's been resolved
        }
        return true; // still waiting for confirmations
      });
    }
  }

  /// Shared handler for every venue's Sync subscription — a single
  /// subscription now covers many pools (see this file's header comment),
  /// so logs are dispatched to the right pool by address rather than by
  /// which subscription called this.
  _onSyncLogs(logs) {
    for (const log of logs) {
      const key = log.address.toLowerCase();
      const pool = this.pools.get(key);
      if (!pool) continue; // shouldn't happen given the address-scoped filter, but defensive
      pool.pendingUpdates.push({
        blockNumber: log.blockNumber,
        reserve0: log.args.reserve0,
        reserve1: log.args.reserve1,
      });
    }
  }

  /// Fires on any subscription's onError (block-number or a venue's Sync
  /// watcher). Debounced via _reconnecting so N simultaneous subscription
  /// errors from the same underlying socket drop don't each kick off their
  /// own parallel reconnect attempt.
  _handleWsError(source, err) {
    console.error(`liquidityGraph: WS error from ${source}:`, err.shortMessage || err.message);
    if (this._reconnecting) return;
    this._reconnecting = true;

    const delayMs = cfg.graph.wsReconnectDelayMs;
    console.warn(`liquidityGraph: will attempt to re-establish subscriptions and resync in ${delayMs}ms...`);
    setTimeout(() => {
      this._reconnectAndResync()
        .catch((e) =>
          console.error(
            "liquidityGraph: reconnect/resync attempt failed — will retry on the next subscription " +
            "error or detected block gap:",
            e.message
          )
        )
        .finally(() => {
          this._reconnecting = false;
        });
    }, delayMs);
  }

  /// Re-establishes every subscription this graph owns from its current
  /// in-memory state (nothing about which pools/venues are tracked is
  /// lost across a WS drop — only the live subscriptions themselves die),
  /// then forces a full resync since any events missed during the outage
  /// have no backfill mechanism over a live subscription.
  async _reconnectAndResync() {
    if (this._blockUnwatch) {
      try {
        this._blockUnwatch();
      } catch (_) {
        // best-effort
      }
    }
    this._blockUnwatch = this.wsClient.watchBlockNumber({
      onBlockNumber: (blockNumber) => this._handleBlockNumber(blockNumber),
      onError: (err) => this._handleWsError("block-number subscription", err),
    });

    for (const venue of this._venueAddresses.keys()) {
      await this._resubscribeVenue(venue);
    }

    await this._resyncAll();
    console.log(`liquidityGraph: reconnected — ${this.pools.size} pool(s) resynced via multicall.`);
  }

  /// Multicall-batched getReserves() across every tracked pool, applied
  /// directly as confirmed state (not queued through pendingUpdates/
  /// confirmationDepth — a direct read at the current block is itself
  /// live on-chain state, not an event that could reorder). Used both
  /// after a reconnect and whenever a block-number gap suggests events
  /// may have been missed. Also used to recover a single stale pool via
  /// setConfirmedReserves() for a narrower, non-multicall path — see that
  /// method below.
  async _resyncAll() {
    const pools = Array.from(this.pools.values());
    if (pools.length === 0) return;

    const calls = pools.map((pool) => ({
      target: pool.address,
      allowFailure: true,
      callData: encodeFunctionData({ abi: PAIR_READ_ABI, functionName: "getReserves" }),
    }));

    let results;
    try {
      results = await this.publicClient.readContract({
        address: cfg.multicall3,
        abi: MULTICALL3_ABI,
        functionName: "aggregate3",
        args: [calls],
      });
    } catch (err) {
      throw new Error(`resync multicall failed: ${err.shortMessage || err.message}`);
    }

    const nowMs = Date.now();
    results.forEach((result, i) => {
      const pool = pools[i];
      if (!result.success) {
        console.warn(
          `liquidityGraph: resync getReserves() reverted for ${pool.address} — leaving its previously ` +
          `cached reserves in place until the next successful Sync event or resync.`
        );
        return;
      }
      try {
        const decoded = decodeFunctionResult({ abi: PAIR_READ_ABI, functionName: "getReserves", data: result.returnData });
        pool.reserve0 = decoded[0];
        pool.reserve1 = decoded[1];
        pool.lastUpdateBlock = this.latestBlock;
        pool.lastUpdateMs = nowMs;
        pool.pendingUpdates = []; // superseded by this direct read
      } catch (err) {
        console.warn(`liquidityGraph: failed to decode resync result for ${pool.address}: ${err.message}`);
      }
    });
  }

  /// True if this pool's confirmed reserves are old enough that a caller
  /// should not trust them without a fresh multicall read first. Covers a
  /// dropped WS connection or a pool that's genuinely gone quiet.
  isStale(pairAddress) {
    const pool = this.pools.get(pairAddress.toLowerCase());
    if (!pool) return true;
    return Date.now() - pool.lastUpdateMs > cfg.graph.maxReserveAgeMs;
  }

  /// Manually overwrite a pool's confirmed reserves — used to recover from
  /// staleness (caller re-read via multicall) without waiting for the next
  /// Sync event.
  setConfirmedReserves(pairAddress, reserve0, reserve1) {
    const pool = this.pools.get(pairAddress.toLowerCase());
    if (!pool) return;
    pool.reserve0 = reserve0;
    pool.reserve1 = reserve1;
    pool.lastUpdateMs = Date.now();
  }

  /// Local quote: tokenIn -> tokenOut across ALL tracked pools that
  /// directly pair them, returning the best (highest amountOut) result.
  /// Zero RPC calls — pure in-memory math against the confirmed reserves.
  quote(tokenIn, tokenOut, amountIn) {
    const tokenInLc = tokenIn.toLowerCase();
    const tokenOutLc = tokenOut.toLowerCase();
    let best = null;

    for (const pool of this.pools.values()) {
      const t0 = pool.token0.toLowerCase();
      const t1 = pool.token1.toLowerCase();
      let reserveIn, reserveOut;
      if (t0 === tokenInLc && t1 === tokenOutLc) {
        reserveIn = pool.reserve0;
        reserveOut = pool.reserve1;
      } else if (t1 === tokenInLc && t0 === tokenOutLc) {
        reserveIn = pool.reserve1;
        reserveOut = pool.reserve0;
      } else {
        continue;
      }

      const amountOut = quoteConstantProduct(amountIn, reserveIn, reserveOut, pool.feeBps);
      if (!best || amountOut > best.amountOut) {
        best = { amountOut, venue: pool.venue, poolAddress: pool.address, stale: this.isStale(pool.address) };
      }
    }

    return best; // null if no tracked pool covers this pair
  }

  /// All distinct token addresses this graph currently has pools for —
  /// used by the Bellman-Ford builder to enumerate graph nodes.
  tokens() {
    const set = new Set();
    for (const pool of this.pools.values()) {
      set.add(pool.token0.toLowerCase());
      set.add(pool.token1.toLowerCase());
    }
    return Array.from(set);
  }

  /// All tracked pools — used by the Bellman-Ford builder to enumerate
  /// graph edges.
  allPools() {
    return Array.from(this.pools.values());
  }

  /// Look up a single tracked pool's metadata (venue, feeBps, token0/1) by
  /// address — used by graph-scanner.js's Phase 3 re-quote step, which
  /// needs to know which venue/fee applies to each hop of a Bellman-Ford
  /// cycle (cycle.pools only gives addresses, not venue). Returns
  /// undefined if the address isn't tracked (shouldn't happen for a pool
  /// address that came out of this same graph's own cycle detection, but
  /// callers should not assume that invariant blindly).
  getPool(pairAddress) {
    return this.pools.get(pairAddress.toLowerCase());
  }

  /// Unsubscribe from every subscription this graph owns (block-number +
  /// every venue's Sync watcher). Call on shutdown.
  close() {
    if (this._blockUnwatch) {
      try {
        this._blockUnwatch();
      } catch (_) {
        // best-effort
      }
      this._blockUnwatch = null;
    }
    for (const unwatch of this._venueWatchers.values()) {
      try {
        unwatch();
      } catch (_) {
        // best-effort
      }
    }
    this._venueWatchers.clear();
  }
}

module.exports = { LiquidityGraph, quoteConstantProduct, PAIR_READ_ABI };
