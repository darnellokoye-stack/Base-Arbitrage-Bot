/**
 * EDGE #1: New-pool listener for Base.
 *
 * The actual edge here isn't speed in the "faster than an MEV bot's
 * co-located infra" sense — you will lose that race every time. The edge
 * is COVERAGE: sophisticated searchers build routing/pricing logic per
 * pool (often per pair), which costs engineering time even for them. A
 * pool that didn't exist an hour ago is frequently unmapped by anyone
 * else's bot yet. This module's only job is: notice new pools fast, and
 * hand off anything that (a) pairs a brand-new token against a token you
 * already track (WETH/USDC) and (b) clears a minimum liquidity floor, to
 * a "fresh pool" watch list for aggressive quoting.
 *
 * This does NOT execute trades. It's a discovery feed. Wire its output
 * into your existing quote/execute logic (see scanner.js in the parent
 * bot/ dir for the general pattern — gas-aware minProfit, adapter
 * allowlisting, etc. all still apply once a candidate pool is found here).
 *
 * WHAT THIS COVERS:
 *   - Uniswap V2-shaped factories on Base (confirmed factory address in
 *     config.js). PairCreated is a standard, stable event shape.
 *
 * WHAT THIS DELIBERATELY DOES NOT COVER YET:
 *   - Aerodrome (Base's largest DEX by TVL) uses a Solidly-style factory
 *     with a different pool-creation event shape than plain UniswapV2.
 *     See config.js header comment — wire this in only after
 *     independently verifying Aerodrome's actual factory address and
 *     event ABI, the same way this project verified SyncSwap/Mute/SpaceFi
 *     on zkSync Era. Do not guess the ABI from memory.
 *   - Uniswap V3/V4-style concentrated-liquidity pools (different
 *     event: PoolCreated, different quoting math — constant-product
 *     quoteConstantProduct() in the parent scanner.js does NOT apply to
 *     these pools as-is).
 *
 * Run standalone for now: node bot/base-edges/new-pool-listener.js
 * (Prints discovered pools; hook onFreshPool() into your executor.)
 */

require("dotenv").config();
const { createPublicClient, http, webSocket, formatEther } = require("viem");
const { base } = require("viem/chains");
const cfg = require("./config");
const smallTradeSweep = require("./small-trade-sweep");

const PAIR_CREATED_EVENT = {
  type: "event",
  name: "PairCreated",
  inputs: [
    { indexed: true, name: "token0", type: "address" },
    { indexed: true, name: "token1", type: "address" },
    { indexed: false, name: "pair", type: "address" },
    { indexed: false, name: "", type: "uint256" },
  ],
};

const ERC20_ABI = [
  { name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ name: "account", type: "address" }], outputs: [{ type: "uint256" }] },
  { name: "symbol", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { name: "decimals", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
];

// Use a WS transport if provided (real push notifications on new blocks/logs);
// fall back to HTTP polling otherwise. WS is strongly preferred for this
// module specifically, since the entire value proposition is noticing
// pools quickly — HTTP polling on a public RPC adds real latency and rate
// limits that eat into the exact edge this module exists to capture.
const transport = cfg.WS_RPC_URL ? webSocket(cfg.WS_RPC_URL) : http(cfg.RPC_URL);
if (!cfg.WS_RPC_URL) {
  console.warn(
    "WARNING: BASE_WS_RPC_URL not set — falling back to HTTP polling via " +
    `${cfg.RPC_URL}. This works but is materially slower to notice new pools ` +
    "than a WebSocket subscription. Get a WS endpoint (Alchemy/Infura/etc " +
    "free tier is fine) if you want this module to do what it's actually for."
  );
}

const client = createPublicClient({ chain: base, transport });

// In-memory only — see note in onFreshPool() below about persistence.
const freshPools = new Map(); // pairAddress -> { token0, token1, pair, discoveredAt, timer }
const knownTokenEntries = Object.entries(cfg.knownTokens).filter(([, addr]) => !!addr);
if (knownTokenEntries.length === 0) {
  throw new Error("No known tokens configured. Set BASE_USDC or keep the default WETH config before running.");
}
const knownTokenSet = new Set(knownTokenEntries.map(([, addr]) => addr.toLowerCase()));
const configuredKnownTokens = Object.fromEntries(knownTokenEntries);

/**
 * Cheap pre-filter: does this new pool pair a brand-new token against a
 * token we already have quoting/routing logic for? A pool between two
 * totally unknown tokens isn't triangulable by this bot no matter how
 * early it's caught, so there's no point spending an RPC call checking
 * its liquidity.
 */
function pairsAgainstKnownToken(token0, token1) {
  const t0 = token0.toLowerCase();
  const t1 = token1.toLowerCase();
  if (knownTokenSet.has(t0)) return { knownToken: token0, newToken: token1 };
  if (knownTokenSet.has(t1)) return { knownToken: token1, newToken: token0 };
  return null;
}

/**
 * Reads the known-token side's balance in the new pool as a rough,
 * cheap liquidity heuristic. This is NOT the same as a proper constant-
 * product quote (see quoteConstantProduct in the parent bot/scanner.js
 * for that) — it's deliberately cheap so we can filter out obvious dust
 * pools before doing real work on a candidate.
 */
async function roughLiquidityCheck(pairAddress, knownTokenAddress) {
  try {
    const balance = await client.readContract({
      address: knownTokenAddress,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [pairAddress],
    });
    return balance;
  } catch (err) {
    console.error(`liquidity check failed for pair ${pairAddress}:`, err.shortMessage || err.message);
    return 0n;
  }
}

/**
 * Called once a pool clears the liquidity pre-filter. This is the actual
 * hand-off point to your execution logic — currently just logs and adds
 * to the in-memory freshPools map with an expiry timer.
 *
 * WIRE-UP NOTE: to actually trade on these, you'd extend the parent
 * bot/scanner.js (or a Base-specific sibling) to accept a dynamic pool
 * address + token pair instead of the current hardcoded
 * SYNCSWAP_WETH_USDC_POOL-style env vars, then run its existing
 * gas-aware minProfit / adapter-allowlist logic against each fresh pool
 * on freshPoolPollIntervalMs while it's in this map. That reuse is
 * deliberate — the discovery layer here is new, but the quote/execute
 * safety logic this project already built and fork-tested should not be
 * duplicated or reinvented per-chain.
 *
 * PERSISTENCE NOTE: this in-memory Map is lost on restart. That's fine
 * for a first pass (missing a few pools across a restart is a minor cost,
 * not a correctness bug) but if you want continuity across restarts,
 * persist discoveredAt/pair/tokens to a small local DB or file rather
 * than re-deriving it from historical logs on every boot (expensive and
 * mostly pointless — pools discovered more than freshPoolWindowMs ago
 * aren't "fresh" anymore anyway).
 */
function onFreshPool({ pair, token0, token1, knownToken, newToken, knownTokenLiquidity }) {
  const readableLiquidity = formatEther(knownTokenLiquidity);
  console.log(
    `[${new Date().toISOString()}] FRESH POOL: ${pair} ` +
    `(${newToken} / ${knownToken}) — known-side liquidity ~${readableLiquidity} ` +
    `(raw units of the known token, not necessarily ETH-denominated)`
  );

  // EDGE #2 hand-off: sweep several small trade sizes against this fresh
  // pool on the freshPoolPollIntervalMs cadence, rather than checking one
  // fixed size. Still requires a routerForThirdLeg (how the new token
  // routes back to WETH) to be knowable — left as null here since that's
  // pool-specific and not derivable from the PairCreated event alone; the
  // sweep will simply report quote failures until a real third-leg router
  // is supplied for a given new token. See small-trade-sweep.js's
  // checkCandidate() and its own routing-note comment.
  const pollTimer = setInterval(() => {
    smallTradeSweep
      .checkCandidate({
        poolLabel: `${pair} (${newToken})`,
        freshPoolRouter: cfg.dexes.uniswapV2Router,
        newToken,
        routerForThirdLeg: process.env.BASE_THIRD_LEG_ROUTER || null,
      })
      .catch((err) => console.error(`sweep error for ${pair}:`, err.message));
  }, cfg.freshPoolPollIntervalMs);

  // Single expiry timer owns cleanup of BOTH the map entry and the poll
  // interval — avoids the two timers drifting out of sync or the poll
  // interval leaking past the pool's fresh window.
  const expiryTimer = setTimeout(() => {
    clearInterval(pollTimer);
    freshPools.delete(pair.toLowerCase());
    console.log(`[${new Date().toISOString()}] pool ${pair} aged out of fresh window — sweep stopped.`);
  }, cfg.freshPoolWindowMs);

  freshPools.set(pair.toLowerCase(), {
    pair,
    token0,
    token1,
    knownToken,
    newToken,
    discoveredAt: Date.now(),
    expiryTimer,
    pollTimer,
  });
}

async function handlePairCreatedLog(log) {
  const { token0, token1, pair } = log.args;
  if (!token0 || !token1 || !pair) return;

  const match = pairsAgainstKnownToken(token0, token1);
  if (!match) {
    // Pool between two tokens we have no routing logic for — not
    // triangulable by this bot, skip without spending further RPC calls.
    return;
  }

  const liquidity = await roughLiquidityCheck(pair, match.knownToken);
  if (liquidity < cfg.minPoolLiquidityWei) {
    console.log(
      `[${new Date().toISOString()}] skipping ${pair} — known-token liquidity ` +
      `${formatEther(liquidity)} below floor ${formatEther(cfg.minPoolLiquidityWei)}`
    );
    return;
  }

  onFreshPool({
    pair,
    token0,
    token1,
    knownToken: match.knownToken,
    newToken: match.newToken,
    knownTokenLiquidity: liquidity,
  });
}

async function main() {
  console.log(`Starting Base new-pool listener against factory ${cfg.factories.uniswapV2}...`);
  console.log(
    `Tracking pools paired against known tokens: ${JSON.stringify(configuredKnownTokens)}`
  );

  client.watchEvent({
    address: cfg.factories.uniswapV2,
    event: PAIR_CREATED_EVENT,
    onLogs: (logs) => {
      logs.forEach((log) => {
        handlePairCreatedLog(log).catch((err) =>
          console.error("error handling PairCreated log:", err.message)
        );
      });
    },
    onError: (err) => {
      console.error("watchEvent error (will keep retrying via viem's built-in reconnect):", err.message);
    },
  });

  // Keep process alive; watchEvent runs its own subscription/poll loop.
  process.stdin.resume();
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});

module.exports = { freshPools, pairsAgainstKnownToken };
