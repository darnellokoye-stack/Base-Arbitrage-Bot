/**
 * Graph-based scanner — additive alternative candidate-generation path to
 * bot/scanner.js's buildRouteCandidates(), built for side-by-side
 * comparison during a dry run, NOT a replacement.
 *
 * Pipeline: dynamic liquidity graph (event-driven reserves) -> Bellman-Ford
 * negative-cycle detection -> re-quote the winning cycle at the real trade
 * size -> hand off to the EXACT SAME gas-floor/simulate/submit path
 * bot/scanner.js already uses (gasCostInStartToken, simulateExecution,
 * submit). Nothing about the on-chain safety model changes: the contract's
 * onlyOwner/allowlist/minProfit checks and the final eth_call simulation
 * are still the actual guarantees, exactly as before. This scanner only
 * changes how candidates are FOUND, not what happens after one is chosen.
 *
 * WHAT THIS DOES NOT DO (be clear-eyed about this before relying on it):
 *   - submit() (in bot/scanner.js, shared by this file) now has Phase 6
 *     retry/replacement, adaptive fees, a nonce manager, and a circuit
 *     breaker — see bot/execution/*.js — but its default broadcast path
 *     is STILL the public mempool (walletClient.writeContract). Phase 7's
 *     private-relay plumbing (bot/execution/privateSubmit.js) exists and
 *     is usable, but is deliberately not auto-wired into this call site —
 *     see submit()'s own comment in bot/scanner.js for why (replacement
 *     handling and private-relay submission are a real tradeoff, not a
 *     drop-in swap). Until an operator wires that tradeoff in explicitly,
 *     this scanner finds opportunities faster, it doesn't yet protect
 *     them from being sandwiched.
 *   - Gas bidding is now adaptive (bot/execution/gasPricer.js) rather than
 *     the old static gasPriceBufferBps buffer for the SUBMITTED
 *     transaction's fees — gasPriceBufferBps is still used as-is for
 *     scanner.js's own profitability ESTIMATE, a separate read-only
 *     number from the fee actually attached to the transaction.
 *   - Does not maintain a historical profitability database or any
 *     learned route scoring. Bellman-Ford's ranking is purely the
 *     marginal-rate log-profit of each cycle at graph-snapshot time —
 *     see negativeCycle.js's doc comment on why that's a screening
 *     signal, not a final profitability number.
 *
 * Run: node bot/graph-scanner.js            (pre-funded TriangleArb)
 *      FLASH_MODE=1 node bot/graph-scanner.js  (Aave V3 flash-loan-funded)
 */

require("dotenv").config();
const { createPublicClient, createWalletClient, http, webSocket, formatUnits, encodeAbiParameters, zeroAddress } = require("viem");
const { base } = require("viem/chains");
const { privateKeyToAccount } = require("viem/accounts");
const cfg = require("./config");
const { LiquidityGraph, PAIR_READ_ABI, quoteConstantProduct } = require("./graph/liquidityGraph");
const { findNegativeCycles } = require("./graph/negativeCycle");
const { batchQuote } = require("./graph/multicallQuoter");
const { Metrics } = require("./graph/metrics");

// The single execution pipeline (Phase 3): requiring scanner.js does NOT
// start its own polling loop (see the require.main guard at the bottom of
// that file) — it only gives us the exact same gas-floor/simulate/submit
// functions bot/scanner.js's own scanOnce() uses, including submit()'s
// shared txInFlight lock. This is the whole point of Phase 3: the graph
// only ever produces a `route` in the same shape bot/scanner.js's own
// buildRouteCandidates() produces, then hands it to code neither file
// duplicates a second copy of.
const {
  evaluateAndMaybeSubmit,
  routeLabel: sharedRouteLabel,
  checkFlashLoanCapacity,
  getAaveFlashPremium,
  FLASH_MODE: SCANNER_FLASH_MODE,
} = require("./scanner");

// Both this file and scanner.js compute FLASH_MODE independently from the
// same process.env.FLASH_MODE at module-load time — they should always
// agree since it's the same env var, but asserting it here turns a
// hypothetical future divergence (e.g. one file gaining an extra env
// override) into a loud startup failure instead of a silent split-brain
// where this file thinks it's in flash mode but scanner.js's exported
// checkFlashLoanCapacity/getAaveFlashPremium/evaluateAndMaybeSubmit don't.
if (FLASH_MODE !== SCANNER_FLASH_MODE) {
  console.error(
    `FATAL: graph-scanner.js FLASH_MODE=${FLASH_MODE} disagrees with scanner.js's FLASH_MODE=` +
    `${SCANNER_FLASH_MODE} — both read process.env.FLASH_MODE and must agree. This should be ` +
    "impossible; if you see this, something patched process.env.FLASH_MODE between the two " +
    "modules' load time."
  );
  process.exit(1);
}

const FLASH_MODE = !!process.env.FLASH_MODE;

if (!cfg.tokens.USDC) {
  console.error("FATAL: BASE_USDC env var not set. Verify the address on BaseScan before setting it.");
  process.exit(1);
}
const CONTRACT_ADDRESS = FLASH_MODE ? cfg.contracts.triangleArbAaveFlash : cfg.contracts.triangleArb;
if (!CONTRACT_ADDRESS) {
  console.error(
    `FATAL: ${FLASH_MODE ? "BASE_TRIANGLE_ARB_AAVE_FLASH" : "BASE_TRIANGLE_ARB"} env var not set.`
  );
  process.exit(1);
}
if (!cfg.contracts.uniswapV2Adapter || !cfg.contracts.aerodromeAdapter) {
  console.error("FATAL: BASE_UNIV2_ADAPTER and/or BASE_AERODROME_ADAPTER env vars not set.");
  process.exit(1);
}
if (!cfg.WS_RPC_URL) {
  console.error(
    "FATAL: BASE_WS_RPC_URL is required for the graph scanner (event-driven reserve updates need a " +
    "WebSocket subscription — this scanner has no HTTP-polling fallback, unlike bot/backrun-monitor.js)."
  );
  process.exit(1);
}

const UNIV2_FACTORY_ABI = [
  {
    name: "getPair",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "tokenA", type: "address" },
      { name: "tokenB", type: "address" },
    ],
    outputs: [{ type: "address" }],
  },
];

// Aerodrome's PoolFactory — see contracts/interfaces/IAerodromeRouter.sol's
// IAerodromePoolFactory for the independently-verified source of this ABI
// (BaseScan + Aerodrome's own GitHub). getPool() returns address(0), not a
// revert, when no pool exists for a given (tokenA, tokenB, stable) triple —
// same "zero address means absent" convention as UniswapV2Factory.getPair().
const AERODROME_FACTORY_ABI = [
  {
    name: "getPool",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "tokenA", type: "address" },
      { name: "tokenB", type: "address" },
      { name: "stable", type: "bool" },
    ],
    outputs: [{ type: "address" }],
  },
  {
    name: "getFee",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "pool", type: "address" },
      { name: "stable", type: "bool" },
    ],
    outputs: [{ type: "uint256" }],
  },
];

// Standard UniswapV2 (and every faithful fork's) swap fee: 0.3%, burned
// into the pair contract's bytecode itself rather than being configurable
// per-pool — safe to hardcode, unlike Aerodrome's fee below. Expressed in
// the same feeBps-out-of-10000 convention quoteConstantProduct() expects.
const UNIV2_FEE_BPS = 30;

const HOP_COMPONENTS = [
  { name: "tokenIn", type: "address" },
  { name: "tokenOut", type: "address" },
  { name: "amountOutMin", type: "uint256" },
  { name: "extraData", type: "bytes" },
];
const LEG_COMPONENTS = [
  { name: "adapter", type: "address" },
  { name: "hops", type: "tuple[]", components: HOP_COMPONENTS },
  { name: "amountOutMin", type: "uint256" },
];
const TRIANGLE_ARB_ABI = [
  {
    name: FLASH_MODE ? "executeTriangleFlash" : "executeTriangle",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "legs", type: "tuple[]", components: LEG_COMPONENTS },
      { name: "amountIn", type: "uint256" },
      { name: "minProfit", type: "uint256" },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [{ name: "profit", type: "uint256" }],
  },
];
const CONTRACT_FUNCTION = FLASH_MODE ? "executeTriangleFlash" : "executeTriangle";

const AAVE_POOL_ABI = [
  {
    name: "FLASHLOAN_PREMIUM_TOTAL",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint128" }],
  },
];

const publicClient = createPublicClient({ chain: base, transport: http(cfg.RPC_URL) });
const wsClient = createPublicClient({ chain: base, transport: webSocket(cfg.WS_RPC_URL) });

let walletClient = null;
let account = null;
if (process.env.PRIVATE_KEY) {
  account = privateKeyToAccount(process.env.PRIVATE_KEY);
  walletClient = createWalletClient({ account, chain: base, transport: http(cfg.RPC_URL) });
}
const ESTIMATION_ACCOUNT = account ? account.address : process.env.OWNER_ADDRESS || null;

function applySlippageFloor(amount) {
  return (amount * (10000n - cfg.slippageBps)) / 10000n;
}

function encodeAerodromeExtraData(stable, factory) {
  return encodeAbiParameters([{ type: "bool" }, { type: "address" }], [stable, factory]);
}

/// All distinct tokens this scanner is willing to track: WETH, USDC, and
/// whatever's in BASE_TRIANGLE_TOKENS. Same token universe bot/scanner.js's
/// buildRouteCandidates() already works with — this scanner is meant to be
/// compared apples-to-apples against it, not to expand the token universe
/// on its own (see this file's header comment).
function tokenUniverse() {
  const set = new Set();
  set.add(cfg.tokens.WETH.toLowerCase());
  if (cfg.tokens.USDC) set.add(cfg.tokens.USDC.toLowerCase());
  for (const t of cfg.triangleTokens) set.add(t.toLowerCase());
  return Array.from(set);
}

/// All unordered pairs from a token list (each combination once, not each
/// permutation) — factory getPair/getPool calls are token-order-independent
/// (both factories sort internally), so querying (A,B) and (B,A) would just
/// be the same on-chain lookup twice.
function tokenPairs(tokens) {
  const pairs = [];
  for (let i = 0; i < tokens.length; i++) {
    for (let j = i + 1; j < tokens.length; j++) {
      pairs.push([tokens[i], tokens[j]]);
    }
  }
  return pairs;
}

/// Defensive check per the review's "verify deployed pool bytecode" item:
/// a factory returning a non-zero address is the normal "pool exists"
/// signal, but treating that address as trustworthy without confirming a
/// contract actually lives there means a misbehaving/mocked RPC (or a
/// factory address that was itself never independently verified) can
/// silently walk this bootstrap into reading garbage. Cheap to check,
/// expensive to skip and find out later.
async function poolHasCode(publicClient, address) {
  const code = await publicClient.getBytecode({ address });
  return !!code && code !== "0x";
}

/// Runs the full verification chain the review asked for — bytecode check,
/// reserve read (which also gives us verified token0/token1 ordering
/// straight from the pool contract, not assumed from the factory call
/// order), zero-liquidity rejection, and the configurable liquidity floor —
/// then registers the pool with the graph if and only if it passes all of
/// them. Returns true if the pool was added.
async function tryTrackPool(graph, publicClient, pairAddress, { venue, feeBps, label }) {
  if (!pairAddress || pairAddress === zeroAddress) return false;

  const hasCode = await poolHasCode(publicClient, pairAddress);
  if (!hasCode) {
    console.warn(
      `bootstrapGraph: ${label} factory returned ${pairAddress} but no contract code is deployed ` +
      `there — skipping rather than trusting the factory response blindly.`
    );
    return false;
  }

  let reserves, token0, token1;
  try {
    [reserves, token0, token1] = await Promise.all([
      publicClient.readContract({ address: pairAddress, abi: PAIR_READ_ABI, functionName: "getReserves" }),
      publicClient.readContract({ address: pairAddress, abi: PAIR_READ_ABI, functionName: "token0" }),
      publicClient.readContract({ address: pairAddress, abi: PAIR_READ_ABI, functionName: "token1" }),
    ]);
  } catch (err) {
    console.warn(
      `bootstrapGraph: ${label} pool ${pairAddress} has code but rejected getReserves/token0/token1 — ` +
      `skipping (${err.shortMessage || err.message}).`
    );
    return false;
  }

  const [reserve0, reserve1] = reserves;
  if (reserve0 === 0n || reserve1 === 0n) {
    console.log(`bootstrapGraph: skipping ${label} pool ${pairAddress} — zero-liquidity (uninitialized) pool.`);
    return false;
  }

  // Liquidity floor: only checkable directly when WETH is one of the two
  // tokens in the pool, since that's the one denomination we can compare
  // against cfg.graph.minPoolLiquidityWeth without doing a further
  // conversion quote (which would mean spending an RPC call per candidate
  // pool just to decide whether to track it — self-defeating for a
  // bootstrap step). Non-WETH-paired pools (e.g. USDC/tokenX) skip this
  // specific floor and rely on zero-liquidity rejection above plus
  // whatever profitability the quote/simulate pipeline finds later.
  const wethLc = cfg.tokens.WETH.toLowerCase();
  const t0Lc = token0.toLowerCase();
  const t1Lc = token1.toLowerCase();
  let wethSideReserve = null;
  if (t0Lc === wethLc) wethSideReserve = reserve0;
  else if (t1Lc === wethLc) wethSideReserve = reserve1;

  if (wethSideReserve !== null && wethSideReserve < cfg.graph.minPoolLiquidityWeth) {
    console.log(
      `bootstrapGraph: skipping ${label} pool ${pairAddress} — WETH-side liquidity ` +
      `${formatUnits(wethSideReserve, 18)} WETH below floor ` +
      `${formatUnits(cfg.graph.minPoolLiquidityWeth, 18)} WETH.`
    );
    return false;
  }

  await graph.addPool(pairAddress, { venue, feeBps });
  console.log(`bootstrapGraph: tracking ${label} pool ${pairAddress} (feeBps=${feeBps}).`);
  return true;
}

/// Seeds the graph with every pool implied by cfg.tokens/cfg.triangleTokens
/// against both venues: for each unordered token pair, checks
/// UniswapV2Factory.getPair() and Aerodrome PoolFactory.getPool() (volatile
/// side only — see note below), verifies what comes back, and registers
/// anything that clears the checks in tryTrackPool().
///
/// AERODROME STABLE POOLS ARE DELIBERATELY NOT BOOTSTRAPPED: volatile
/// Aerodrome pools use the same x*y=k constant-product curve as UniswapV2
/// (confirmed against Aerodrome's own Pool.sol — this is why
/// quoteConstantProduct() in liquidityGraph.js is safe to reuse for them),
/// but stable pools use a different curve (Solidly-style x3y+y3x, for
/// low-slippage correlated-asset pairs). quoteConstantProduct() does NOT
/// model that curve, and neither does negativeCycle.js's marginal-rate
/// math. Tracking a stable pool in this graph would produce confidently
/// wrong local quotes rather than an honest error. Once a stable-pool
/// quote function is written and independently verified against Pool.sol's
/// actual _get_y/_k math, stable pools can be added as their own
/// venue/quote-function pair — left out for now rather than silently
/// mismodeled.
async function bootstrapGraph(graph) {
  const tokens = tokenUniverse();
  if (tokens.length < 2) {
    console.warn(
      "bootstrapGraph: fewer than 2 tokens configured (need at least WETH + one more — set BASE_USDC " +
      "and/or BASE_TRIANGLE_TOKENS). The graph will start empty."
    );
    return;
  }

  const pairs = tokenPairs(tokens);
  console.log(
    `bootstrapGraph: checking ${pairs.length} token pair(s) across ${tokens.length} token(s) against ` +
    `Uniswap V2 (${cfg.dexes.uniswapV2Factory}) and Aerodrome volatile pools (${cfg.dexes.aerodromeFactory})...`
  );

  let tracked = 0;
  for (const [tokenA, tokenB] of pairs) {
    // Uniswap V2
    try {
      const pairAddress = await graph.publicClient.readContract({
        address: cfg.dexes.uniswapV2Factory,
        abi: UNIV2_FACTORY_ABI,
        functionName: "getPair",
        args: [tokenA, tokenB],
      });
      const added = await tryTrackPool(graph, graph.publicClient, pairAddress, {
        venue: "univ2",
        feeBps: UNIV2_FEE_BPS,
        label: `UniswapV2 ${tokenA.slice(0, 8)}/${tokenB.slice(0, 8)}`,
      });
      if (added) tracked++;
    } catch (err) {
      console.warn(`bootstrapGraph: UniswapV2Factory.getPair(${tokenA}, ${tokenB}) failed: ${err.shortMessage || err.message}`);
    }

    // Aerodrome, volatile pools only — see header comment on why stable
    // pools are skipped.
    try {
      const poolAddress = await graph.publicClient.readContract({
        address: cfg.dexes.aerodromeFactory,
        abi: AERODROME_FACTORY_ABI,
        functionName: "getPool",
        args: [tokenA, tokenB, false],
      });
      if (poolAddress && poolAddress !== zeroAddress) {
        const feeBps = await graph.publicClient.readContract({
          address: cfg.dexes.aerodromeFactory,
          abi: AERODROME_FACTORY_ABI,
          functionName: "getFee",
          args: [poolAddress, false],
        });
        const added = await tryTrackPool(graph, graph.publicClient, poolAddress, {
          venue: "aerodrome",
          feeBps: Number(feeBps),
          label: `Aerodrome-volatile ${tokenA.slice(0, 8)}/${tokenB.slice(0, 8)}`,
        });
        if (added) tracked++;
      }
    } catch (err) {
      console.warn(`bootstrapGraph: Aerodrome PoolFactory.getPool(${tokenA}, ${tokenB}, false) failed: ${err.shortMessage || err.message}`);
    }
  }

  console.log(`bootstrapGraph: done — tracking ${tracked} pool(s) across ${graph.tokens().length} token(s).`);
  if (tracked === 0) {
    console.warn(
      "bootstrapGraph: tracked zero pools. Check BASE_TRIANGLE_TOKENS, BASE_USDC, and that the " +
      "configured factory addresses actually have deployed pools for this token set on Base mainnet."
    );
  }
}

async function main() {
  console.log(`Starting Base graph scanner (${FLASH_MODE ? "FLASH" : "pre-funded"} mode) against ${CONTRACT_ADDRESS}...`);
  console.log(
    "NOTE: this is a side-by-side candidate-generation alternative to bot/scanner.js, for dry-run " +
    "comparison. It shares the same gas-floor/simulate/submit safety path — see this file's header comment."
  );

  const graph = new LiquidityGraph(publicClient, wsClient);
  await bootstrapGraph(graph);
  graph.start();

  const metrics = new Metrics();
  const metricsIntervalMs = Number(process.env.GRAPH_METRICS_INTERVAL_MS || 60_000);
  const stopMetricsLogging = metrics.startPeriodicLogging(metricsIntervalMs);
  // Best-effort cleanup so a graceful shutdown doesn't leave the periodic
  // logging interval as the one thing keeping the process alive after
  // everything else has already unsubscribed/closed — mirrors the same
  // "return an unwatch/stop function, call it on shutdown" pattern
  // LiquidityGraph.close() and watchBlockNumber's own unwatch already use.
  process.on("SIGINT", () => {
    stopMetricsLogging();
    metrics.logSummary(); // final summary before exit, not just periodic ones
    graph.close();
    process.exit(0);
  });

  const intervalMs = Number(process.env.SCAN_INTERVAL_MS || 3000);
  let scanInFlight = false;

  setInterval(() => {
    if (scanInFlight) {
      console.log("graph scan skipped: previous cycle still running.");
      metrics.incr("scan.skipped_overlap");
      return;
    }
    scanInFlight = true;
    metrics.incr("scan.started");
    metrics
      .timeAsync("scan.cycle_ms", () => scanOnce(graph, metrics))
      .catch((err) => {
        metrics.incr("scan.errored");
        console.error("graph scan error:", err.message);
      })
      .finally(() => {
        scanInFlight = false;
      });
  }, intervalMs);
}

/// Turns one Bellman-Ford cycle (tokens[]/pools[] addresses only — no
/// venue/fee/stable info) into the batchQuote request shape, by looking
/// each hop's pool back up in the graph for its venue/feeBps/stable-ness.
/// Bellman-Ford's marginal-rate edge weights only prove the cycle is
/// profitable at near-zero size (see negativeCycle.js's doc comment) — this
/// is the mandatory re-quote-at-real-size step the review called for,
/// using a single coherent multicall batch (batchQuote) rather than one
/// eth_call per hop, and rather than trusting the graph's own in-memory
/// quote() for the number that actually gets used to build calldata.
/// Returns null if any hop's pool isn't tracked (shouldn't happen for a
/// pool address that came out of this graph's own cycle detection, but
/// checked rather than assumed) or is an Aerodrome pool without a
/// resolvable factory address (needed for the extraData every downstream
/// AerodromeAdapter hop requires).
function buildRequoteRequests(graph, cycle, amountIn) {
  const requests = [];
  for (let i = 0; i < cycle.pools.length; i++) {
    const pool = graph.getPool(cycle.pools[i]);
    if (!pool) {
      console.warn(
        `scanOnce: cycle references untracked pool ${cycle.pools[i]} — discarding candidate ` +
        `(graph state may have changed between cycle detection and re-quote).`
      );
      return null;
    }
    const tokenIn = cycle.tokens[i];
    const tokenOut = cycle.tokens[i + 1];
    if (pool.venue === "univ2") {
      requests.push({ venue: "univ2", tokenIn, tokenOut });
    } else if (pool.venue === "aerodrome") {
      // bootstrapGraph() only ever tracks volatile Aerodrome pools (see
      // that function's header comment), so stable is always false here —
      // NOT an independent assumption made twice, just the one constraint
      // this graph already enforces at bootstrap time.
      requests.push({ venue: "aerodrome", tokenIn, tokenOut, stable: false, factory: cfg.dexes.aerodromeFactory });
    } else {
      console.warn(`scanOnce: cycle pool ${cycle.pools[i]} has unrecognized venue "${pool.venue}" — discarding candidate.`);
      return null;
    }
  }
  return requests;
}

/// Chains batchQuote's per-hop amountOut results (each hop quoted
/// independently at that hop's OWN input amount) into a single route in
/// the exact `{ legs: quote[], amountOut }` shape
/// evaluateAndMaybeSubmit/legFromQuote already expect from
/// bot/scanner.js's buildRouteCandidates() — so nothing downstream needs to
/// know whether the candidate came from the graph or the original scanner.
/// Returns null (discarding the candidate) if any hop reverts in the
/// multicall, rather than propagating a zero/garbage amountOut into a
/// profitability check.
function chainQuotesIntoRoute(cycle, requests, quoteResults, amountIn) {
  const legs = [];
  let runningAmountIn = amountIn;

  for (let i = 0; i < requests.length; i++) {
    const result = quoteResults[i];
    if (!result.ok) {
      console.log(
        `scanOnce: re-quote failed for hop ${i} (${routeLabelForCycle(cycle)}): ${result.error} — discarding candidate.`
      );
      return null;
    }
    const req = requests[i];
    legs.push({
      venue: req.venue,
      tokenIn: req.tokenIn,
      tokenOut: req.tokenOut,
      amountIn: runningAmountIn,
      amountOut: result.amountOut,
      stable: req.stable || false,
    });
    runningAmountIn = result.amountOut;
  }

  return { legs, amountOut: runningAmountIn };
}

function routeLabelForCycle(cycle) {
  return cycle.tokens.map((t) => t.slice(0, 8)).join(" -> ");
}

/// Phase 4: cheap, zero-RPC pruning applied to raw Bellman-Ford cycles
/// BEFORE any of them reach the multicall re-quote step. Every check here
/// uses only data already in memory (the graph's cached pool metadata/
/// reserves and the cycle's own tokens/pools arrays) — the whole point is
/// to stop paying an RPC round trip (batchQuote) to verify a candidate
/// that was never going to pass anyway. This does NOT replace the re-quote
/// or simulateExecution — a cycle that survives this filter can still be
/// discarded later for reverting or failing the gas-floor check. It only
/// narrows what gets a shot at those more expensive checks.
///
/// Returns { kept: cycle[], rejected: { cycle, reason }[] } rather than
/// just the survivors, so scanOnce() can log why candidates were dropped —
/// silent filtering makes an empty "no candidates" scan cycle impossible
/// to debug (was the graph empty? did every cycle fail one specific
/// filter? which one?).
function filterCandidateCycles(graph, cycles, amountIn) {
  const kept = [];
  const rejected = [];

  for (const cycle of cycles) {
    // --- Duplicate pool detection: a cycle that uses the same pool
    // address twice is either a degenerate 2-hop there-and-back (no real
    // arbitrage, just paying fees twice against the same curve) or a sign
    // the cycle walk in negativeCycle.js produced something malformed.
    // Bellman-Ford's predecessor-chain walk shouldn't normally produce
    // this for a startToken-anchored cycle, but checked rather than
    // assumed — see this file's header comment on not trusting upstream
    // invariants blindly.
    const poolSet = new Set(cycle.pools.map((p) => p.toLowerCase()));
    if (poolSet.size !== cycle.pools.length) {
      rejected.push({ cycle, reason: "duplicate pool within cycle" });
      continue;
    }

    // --- Duplicate token detection: cycle.tokens is
    // [startToken, mid1, ..., midN, startToken] (see negativeCycle.js) —
    // the array naturally repeats startToken at the end, so we check
    // every OTHER token for a repeat. A revisited intermediate token
    // means the "cycle" is actually two smaller loops glued together,
    // which the on-chain contract's Leg[] structure doesn't special-case
    // and which needlessly adds hops (and fee/gas cost) versus the
    // smaller loop alone.
    const middleTokens = cycle.tokens.slice(1, -1).map((t) => t.toLowerCase());
    if (new Set(middleTokens).size !== middleTokens.length) {
      rejected.push({ cycle, reason: "duplicate intermediate token within cycle" });
      continue;
    }

    // --- Unsupported adapter / fee accumulation, computed together in one
    // pass since both need each hop's pool metadata anyway.
    let totalFeeBps = 0;
    let unsupportedVenue = null;
    let missingPool = null;
    for (const poolAddress of cycle.pools) {
      const pool = graph.getPool(poolAddress);
      if (!pool) {
        missingPool = poolAddress;
        break;
      }
      if (pool.venue !== "univ2" && pool.venue !== "aerodrome") {
        unsupportedVenue = pool.venue;
        break;
      }
      totalFeeBps += pool.feeBps;
    }
    if (missingPool) {
      // Same situation buildRequoteRequests() guards against later — graph
      // state moved between cycle detection and filtering. Caught here too
      // so it's rejected (and logged) at the cheap stage instead of only
      // downstream.
      rejected.push({ cycle, reason: `references untracked pool ${missingPool}` });
      continue;
    }
    if (unsupportedVenue) {
      rejected.push({ cycle, reason: `unsupported venue "${unsupportedVenue}"` });
      continue;
    }
    if (totalFeeBps > cfg.graph.maxCycleFeeBps) {
      rejected.push({
        cycle,
        reason: `cumulative fee ${totalFeeBps}bps exceeds cfg.graph.maxCycleFeeBps=${cfg.graph.maxCycleFeeBps}bps`,
      });
      continue;
    }

    // --- Minimum liquidity (re-checked here, not just at bootstrap): a
    // pool's reserves can drain well below cfg.graph.minPoolLiquidityWeth
    // AFTER it was tracked (bootstrapGraph()'s floor is a one-time
    // admission check, not a standing guarantee) — Sync events update
    // pool.reserve0/1 live, so re-reading them here catches a pool that's
    // since become too thin without needing a fresh RPC call.
    let belowLiquidityFloor = null;
    for (const poolAddress of cycle.pools) {
      const pool = graph.getPool(poolAddress);
      const wethLc = cfg.tokens.WETH.toLowerCase();
      let wethSideReserve = null;
      if (pool.token0.toLowerCase() === wethLc) wethSideReserve = pool.reserve0;
      else if (pool.token1.toLowerCase() === wethLc) wethSideReserve = pool.reserve1;
      if (wethSideReserve !== null && wethSideReserve < cfg.graph.minPoolLiquidityWeth) {
        belowLiquidityFloor = poolAddress;
        break;
      }
    }
    if (belowLiquidityFloor) {
      rejected.push({ cycle, reason: `pool ${belowLiquidityFloor} now below minPoolLiquidityWeth floor` });
      continue;
    }

    // --- Estimated price impact per hop: run the cycle's own amountIn
    // through quoteConstantProduct() locally (zero RPC, same cached
    // reserves used for graph.quote()) and compare the resulting
    // effective rate against the pool's marginal (spot) rate. This is an
    // ESTIMATE against a graph snapshot that may be a block or two behind
    // confirmed on-chain state (see liquidityGraph.js's confirmationDepth/
    // staleness comments) — good enough to reject an obviously-thin pool
    // before spending a multicall re-quote on it, not a substitute for the
    // real quote that comes next.
    let worstImpactBps = 0;
    let runningAmount = amountIn;
    let impactPoolAddress = null;
    for (let i = 0; i < cycle.pools.length; i++) {
      const pool = graph.getPool(cycle.pools[i]);
      const tokenIn = cycle.tokens[i].toLowerCase();
      const t0 = pool.token0.toLowerCase();
      const t1 = pool.token1.toLowerCase();
      const reserveIn = tokenIn === t0 ? pool.reserve0 : pool.reserve1;
      const reserveOut = tokenIn === t0 ? pool.reserve1 : pool.reserve0;

      if (reserveIn === 0n || reserveOut === 0n) {
        worstImpactBps = 10000; // 100% — can't quote, treat as maximal impact
        impactPoolAddress = cycle.pools[i];
        break;
      }

      const amountOut = quoteConstantProduct(runningAmount, reserveIn, reserveOut, pool.feeBps);
      // Marginal (spot) amountOut at this same input, ignoring the curve's
      // own slippage: reserveOut/reserveIn * runningAmount, fee-adjusted
      // the same way quoteConstantProduct fee-adjusts amountIn. Comparing
      // actual-vs-marginal at the SAME input isolates curve-depth impact
      // from the fee itself (which both numbers already include equally).
      const amountInWithFee = runningAmount * BigInt(10000 - pool.feeBps);
      const marginalAmountOut = (amountInWithFee * reserveOut) / (reserveIn * 10000n);

      if (marginalAmountOut > 0n) {
        const impactBps = Number(((marginalAmountOut - amountOut) * 10000n) / marginalAmountOut);
        if (impactBps > worstImpactBps) {
          worstImpactBps = impactBps;
          impactPoolAddress = cycle.pools[i];
        }
      }
      runningAmount = amountOut;
    }
    if (worstImpactBps > cfg.graph.maxPriceImpactBps) {
      rejected.push({
        cycle,
        reason: `estimated price impact ${worstImpactBps}bps at pool ${impactPoolAddress} exceeds ` +
          `cfg.graph.maxPriceImpactBps=${cfg.graph.maxPriceImpactBps}bps`,
      });
      continue;
    }

    kept.push(cycle);
  }

  return { kept, rejected };
}

// No-op fallback so scanOnce(graph) (no metrics arg) behaves exactly as it
// did before Phase 5 — nothing else in this codebase, or any external
// caller of this module, should be forced to pass a Metrics instance.
const NOOP_METRICS = {
  incr() {},
  recordDuration() {},
  async timeAsync(_name, fn) {
    return fn();
  },
};

async function scanOnce(graph, metrics = NOOP_METRICS) {
  const amountIn = cfg.amountInWei;
  const startToken = cfg.tokens.WETH;

  if (graph.tokens().length < 2) {
    console.log(`[${new Date().toISOString()}] graph has fewer than 2 tokens tracked — nothing to scan yet.`);
    return;
  }

  let cycles;
  try {
    cycles = findNegativeCycles(graph, { startToken, maxCycleLength: 5 });
  } catch (err) {
    console.error("negative-cycle detection failed:", err.message);
    metrics.incr("cycles.detection_errored");
    return;
  }

  if (cycles.length === 0) {
    console.log(`[${new Date().toISOString()}] no profitable cycle found in graph snapshot`);
    metrics.incr("cycles.none_found");
    return;
  }
  metrics.incr("cycles.found", cycles.length);

  const { kept, rejected } = filterCandidateCycles(graph, cycles, amountIn);
  if (rejected.length > 0) {
    // Grouped by reason category rather than one line per rejected cycle —
    // with maxRouteCandidates up to 50+, per-cycle logging here would
    // drown out everything else in scanOnce()'s output on a noisy graph
    // snapshot. Grouped by the first few words of the reason string, which
    // is stable enough per filter (each filter always starts its reason
    // the same way) without needing a separate reason-code enum.
    const byReason = new Map();
    for (const { reason } of rejected) {
      const category = reason.split(" ").slice(0, 3).join(" ");
      byReason.set(category, (byReason.get(category) || 0) + 1);
    }
    const summary = Array.from(byReason.entries())
      .map(([category, count]) => `${count}x "${category}..."`)
      .join(", ");
    console.log(
      `[${new Date().toISOString()}] filtered ${rejected.length}/${cycles.length} candidate(s) before re-quote: ${summary}`
    );
    metrics.incr("cycles.filtered_total", rejected.length);
    // Per-category counters too (not just the log line) — this is the
    // "cache statistics" / filter-effectiveness visibility Phase 5 asks
    // for: which specific filter is doing the pruning over time, so
    // cfg.graph.maxCycleFeeBps/maxPriceImpactBps/minPoolLiquidityWeth can
    // be tuned from data instead of guesswork.
    for (const [category, count] of byReason.entries()) {
      metrics.incr(`cycles.filtered.${category.replace(/\s+/g, "_")}`, count);
    }
  }

  if (kept.length === 0) {
    console.log(`[${new Date().toISOString()}] no candidates survived pre-re-quote filtering`);
    return;
  }
  metrics.incr("cycles.kept", kept.length);

  console.log(
    `[${new Date().toISOString()}] found ${kept.length} candidate cycle(s) after filtering, ` +
    `best logProfit=${kept[0].logProfit.toFixed(6)}`
  );

  let flashFee = null;
  if (FLASH_MODE) {
    const hasCapacity = await checkFlashLoanCapacity(startToken, amountIn);
    if (!hasCapacity) {
      console.log("Aave pool lacks capacity for this loan size; skipping this scan cycle.");
      metrics.incr("flash.capacity_unavailable");
      return;
    }
    try {
      flashFee = await getAaveFlashPremium(amountIn);
    } catch (err) {
      console.error("Aave flash premium read failed:", err.shortMessage || err.message);
      metrics.incr("flash.premium_read_errored");
      return;
    }
  }

  // The Bellman-Ford pass only proves a cycle is profitable at marginal
  // (near-zero) trade size — this loop's job is to re-quote each candidate
  // at the REAL trade size before anything gets treated as executable, per
  // the review's "Re-quote candidates at real trade size" item. Candidates
  // are tried in descending logProfit order (findNegativeCycles already
  // sorts them, and filterCandidateCycles preserves that order) and
  // evaluateAndMaybeSubmit's own gas-floor check is still the actual
  // profitability gate — logProfit only orders which candidate gets a shot
  // first.
  for (const cycle of kept.slice(0, cfg.maxRouteCandidates)) {
    const requests = buildRequoteRequests(graph, cycle, amountIn);
    if (!requests) {
      metrics.incr("requote.discarded_untracked_or_unsupported");
      continue;
    }

    let quoteResults;
    try {
      // Quote latency (review's explicit "quote latency monitoring" item):
      // timeAsync wraps the exact multicall round trip, nothing else, so
      // this number is comparable across scan cycles and against
      // multicallQuoter.js's own stated goal of replacing N sequential
      // eth_calls with one coherent batch — a rising trend here is the
      // direct signal that goal is or isn't holding up as pool count grows.
      quoteResults = await metrics.timeAsync("requote.batch_ms", () => batchQuote(graph.publicClient, requests));
      metrics.incr("requote.batches_ok");
    } catch (err) {
      console.error(
        `scanOnce: batchQuote failed for ${routeLabelForCycle(cycle)}: ${err.shortMessage || err.message} — discarding candidate.`
      );
      metrics.incr("requote.batches_errored");
      continue;
    }

    const route = chainQuotesIntoRoute(cycle, requests, quoteResults, amountIn);
    if (!route) {
      metrics.incr("requote.discarded_hop_failure");
      continue;
    }

    // Compute current block for per-block dedupe
    let currentBlock = null;
    try {
      currentBlock = await graph.publicClient.getBlockNumber();
    } catch (err) {
      console.error(`graph-scan: failed to read block number: ${err.message}`);
    }

    // From here on this is IDENTICAL to bot/scanner.js's own scanOnce()
    // loop: hand the route to the shared evaluateAndMaybeSubmit, which
    // applies the slippage floor, builds Leg[] calldata via legFromQuote,
    // estimates gas, checks the profit-after-gas floor, runs the exact-
    // calldata eth_call simulation, and only then submits. No part of that
    // chain is reimplemented here — see this file's header comment and the
    // scanner.js import above for why that matters (the shared txInFlight
    // lock in particular). evaluateAndMaybeSubmit's own optional metrics
    // param (see scanner.js) is what actually records simulation
    // success/failure and submission outcome — this call site only times
    // and counts at the "did a route make it through the whole pipeline"
    // granularity.
    let submitted;
    try {
      submitted = await metrics.timeAsync("evaluate.pipeline_ms", () =>
        evaluateAndMaybeSubmit(route, amountIn, startToken, flashFee, metrics, currentBlock)
      );
    } catch (err) {
      console.error(
        `scanOnce: evaluateAndMaybeSubmit threw for ${sharedRouteLabel(route)}: ${err.shortMessage || err.message}`
      );
      metrics.incr("evaluate.threw");
      continue;
    }
    if (submitted) {
      metrics.incr("evaluate.submitted");
      return; // one submission per cycle, same discipline as bot/scanner.js's scanOnce()
    }
  }
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
