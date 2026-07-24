/**
 * Base-chain triangle-arb scanner. Replaces the old zkSync Era scanner.js
 * entirely (SyncSwap/Mute/SpaceFi -> Uniswap V2 + Aerodrome; ERC-3156/
 * SyncSwap flash loans -> Aave V3 flash loans). Same overall pattern
 * (dynamic gas-aware minProfit, startup ABI verification, allowlisted
 * adapters, dry-run-safe estimation) — see this file's function-level
 * comments for what changed and why, not just what stayed the same.
 *
 * Run: node bot/scanner.js            (pre-funded TriangleArb)
 *      FLASH_MODE=1 node bot/scanner.js  (Aave V3 flash-loan-funded)
 */

require("dotenv").config();
const { createPublicClient, createWalletClient, http, formatUnits, encodeAbiParameters, fallback } = require("viem");
const { base } = require("viem/chains");
const { privateKeyToAccount } = require("viem/accounts");
const cfg = require("./config");
const { CircuitBreaker } = require("./execution/circuitBreaker");
const { NonceManager } = require("./execution/nonceManager");
const { GasPricer } = require("./execution/gasPricer");
const { createTxSubmitter } = require("./execution/txSubmitter");
const { createPrivateRelayClient, createBloxrouteRelayClient } = require("./execution/privateSubmit");
const crypto = require('crypto');

const FLASH_MODE = !!process.env.FLASH_MODE;
const RPC_TRANSPORTS = (cfg.RPC_URLS && cfg.RPC_URLS.length > 0
  ? cfg.RPC_URLS
  : [cfg.RPC_URL]
).map((url) => http(url));

// --- Fail loudly on missing required config, rather than a confusing
// downstream null-address revert later. ---
if (!cfg.tokens.USDC) {
  console.error("FATAL: BASE_USDC env var not set. Verify the address on BaseScan before setting it.");
  process.exit(1);
}
const CONTRACT_ADDRESS = FLASH_MODE ? cfg.contracts.triangleArbAaveFlash : cfg.contracts.triangleArb;
if (!CONTRACT_ADDRESS) {
  console.error(
    `FATAL: ${FLASH_MODE ? "BASE_TRIANGLE_ARB_AAVE_FLASH" : "BASE_TRIANGLE_ARB"} env var not set. ` +
    `Deploy the contract first (see contracts/scripts/deploy-base.md) and set its address.`
  );
  process.exit(1);
}
if (!cfg.contracts.uniswapV2Adapter || !cfg.contracts.aerodromeAdapter) {
  console.error(
    "FATAL: BASE_UNIV2_ADAPTER and/or BASE_AERODROME_ADAPTER env vars not set. " +
    "Deploy both adapter contracts and set their addresses before scanning — " +
    "without them, scanOnce() would build legs pointing at a null adapter address."
  );
  process.exit(1);
}

const UNIV2_ROUTER_ABI = [
  {
    name: "getAmountsOut",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "amountIn", type: "uint256" }, { name: "path", type: "address[]" }],
    outputs: [{ type: "uint256[]" }],
  },
];

const AERODROME_ROUTER_ABI = [
  {
    name: "getAmountsOut",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "amountIn", type: "uint256" },
      {
        name: "routes",
        type: "tuple[]",
        components: [
          { name: "from", type: "address" },
          { name: "to", type: "address" },
          { name: "stable", type: "bool" },
          { name: "factory", type: "address" },
        ],
      },
    ],
    outputs: [{ type: "uint256[]" }],
  },
  {
    name: "defaultFactory",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
];

const AAVE_POOL_ABI = [
  {
    name: "FLASHLOAN_PREMIUM_TOTAL",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint128" }],
  },
  {
    name: "getReserveData",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "asset", type: "address" }],
    outputs: [{
      type: "tuple",
      components: [
        { name: "configuration", type: "uint256" },
        { name: "liquidityIndex", type: "uint128" },
        { name: "currentLiquidityRate", type: "uint128" },
        { name: "variableBorrowIndex", type: "uint128" },
        { name: "currentVariableBorrowRate", type: "uint128" },
        { name: "currentStableBorrowRate", type: "uint128" },
        { name: "lastUpdateTimestamp", type: "uint40" },
        { name: "id", type: "uint16" },
        { name: "aTokenAddress", type: "address" },
        { name: "stableDebtTokenAddress", type: "address" },
        { name: "variableDebtTokenAddress", type: "address" },
        { name: "interestRateStrategyAddress", type: "address" },
        { name: "accruedToTreasury", type: "uint128" },
        { name: "unbacked", type: "uint128" },
        { name: "isolationModeTotalDebt", type: "uint128" },
      ],
    }],
  },
];

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

const publicClient = createPublicClient({
  chain: base,
  transport: RPC_TRANSPORTS.length > 1 ? fallback(RPC_TRANSPORTS) : RPC_TRANSPORTS[0],
});

let walletClient = null;
let account = null;
if (process.env.PRIVATE_KEY) {
  account = privateKeyToAccount(process.env.PRIVATE_KEY);
  walletClient = createWalletClient({
    account,
    chain: base,
    transport: RPC_TRANSPORTS.length > 1 ? fallback(RPC_TRANSPORTS) : RPC_TRANSPORTS[0],
  });
}

// Same dry-run pattern as the original zkSync scanner: estimateContractGas
// needs a `from` that passes onlyOwner even with no PRIVATE_KEY set.
const ESTIMATION_ACCOUNT = account ? account.address : process.env.OWNER_ADDRESS || null;

// --- Phase 6/7 execution infrastructure ---
// All of these are cheap to construct (no network I/O at construction
// time — see nonceManager.js's header comment on why sync() is separate)
// and are only ever exercised on the submit() path, so constructing them
// unconditionally (even in dry-run mode with no walletClient) keeps this
// section simple and side-effect-free until a real submission happens.

// Logs (rather than throws) to whatever's wired up today — console.error
// is the floor; wiring this to a real page/Slack webhook is an ops
// decision left to the deployment, not this module. See
// circuitBreaker.js's constructor doc for why onTrip is a plain callback.
const observability = require('./observability/metrics');
const observabilityDb = require('./observability/db');
const exporter = require('./observability/exporter');
const alerts = require('./observability/alerts');
const ologger = require('./observability/logger');

// initialize local DB for trade history and stats. Do not crash the bot on
// observability storage failures; inserts will reject and be logged by callers.
observabilityDb.init().catch((err) => {
  ologger.error('observability.db', 'failed to initialize database', { error: err.message });
});
if (process.env.ENABLE_METRICS_SERVER !== "0") {
  exporter.startExporter(process.env.MONITOR_PORT || 9467, async () => ({
    ok: true,
    mode: FLASH_MODE ? "flash" : "prefunded",
    contract: CONTRACT_ADDRESS,
    privateRelayConfigured: !!relayClient,
    publicFallbackAllowed: cfg.execution.allowPublicFallback,
    circuitBreaker: circuitBreaker.snapshot(),
  }));
}
// periodic retention cleanup (daily)
const retentionTimer = setInterval(() => {
  observabilityDb.cleanupRetention(Number(process.env.OBS_RETENTION_DAYS || 90)).catch((err) => {
    ologger.error('observability.db', 'retention cleanup failed', { error: err.message });
  });
}, 24 * 3600 * 1000);
if (retentionTimer.unref) retentionTimer.unref();

const circuitBreaker = new CircuitBreaker({
  dailyLossLimitWei: cfg.execution.dailyLossLimitWei,
  dailyGasBudgetWei: cfg.execution.dailyGasBudgetWei,
  maxConsecutiveFailures: cfg.execution.maxConsecutiveFailures,
  onTrip: (reason) => {
    ologger.error('circuitBreaker', `ALERT: trading halted by circuit breaker — ${reason}`);
    try { observability.incrCounter('circuit_breaker_trips_total', { reason }); } catch (e) {}
    try { alerts.triggerAlert('circuit_breaker_tripped', { reason }); } catch (e) {}
  },
});

const gasPricer = new GasPricer(publicClient, {
  priorityFeeFloorWei: cfg.execution.priorityFeeFloorWei,
  maxFeeCeilingWei: cfg.execution.maxFeeCeilingWei,
  escalationBps: cfg.execution.replacementEscalationBps,
  baseFeeHeadroomBlocks: cfg.execution.baseFeeHeadroomBlocks,
});

// null (not constructed) when there's no account to manage nonces for —
// dry-run mode never reaches a code path that needs it (see submit()
// below), so there's nothing to sync against yet.
const nonceManager = account ? new NonceManager(publicClient, account.address) : null;

// null when neither BASE_PRIVATE_RELAY_URL nor a BASE_PRIVATE_RELAY_PROVIDER
// is set — privateSubmit.js's submitPreferPrivate() treats a null relay
// client as "private submission disabled, always use the public
// mempool," not an error.
let relayClient = null;
if (cfg.privateRelay.provider === "bloxroute") {
  // Fails loudly here (not deep inside submit()) if the auth header is
  // missing, since that's a config mistake worth catching at startup.
  relayClient = createBloxrouteRelayClient({ authHeader: cfg.privateRelay.authHeader });
} else if (cfg.privateRelay.url) {
  relayClient = createPrivateRelayClient({ relayUrl: cfg.privateRelay.url });
}
if (!relayClient) {
  console.log(
    "privateSubmit: no private relay configured — private relay submission is disabled; " +
    "every transaction will go through the public mempool. Set BASE_PRIVATE_RELAY_PROVIDER=bloxroute " +
    "+ BASE_PRIVATE_RELAY_AUTH_HEADER (or BASE_PRIVATE_RELAY_URL for a generic relay) to enable it " +
    "(see bot/execution/privateSubmit.js)."
  );
}
if (account && cfg.execution.requirePrivateRelayForLive) {
  if (!relayClient) {
    console.error(
      "FATAL: LIVE_TRADING_REQUIRES_PRIVATE_RELAY is enabled, PRIVATE_KEY is set, and no private relay is configured."
    );
    process.exit(1);
  }
  if (cfg.execution.allowPublicFallback) {
    console.error(
      "FATAL: LIVE_TRADING_REQUIRES_PRIVATE_RELAY is enabled but ALLOW_PUBLIC_FALLBACK=true. " +
      "Disable public fallback for live private trading."
    );
    process.exit(1);
  }
}

// Constructed lazily inside submit() the first time a real submission
// happens, AFTER nonceManager.sync() has run — createTxSubmitter itself
// does no I/O, but it's kept null until first use so importing this
// module (e.g. from graph-scanner.js) never implies a wallet/nonce sync
// happened as a side effect of merely requiring the file.
let txSubmitter = null;
let nonceManagerSynced = false;

function quoteConstantProduct(amountIn, reserveIn, reserveOut, feeBps) {
  const amountInWithFee = amountIn * BigInt(10000 - feeBps);
  const numerator = amountInWithFee * reserveOut;
  const denominator = reserveIn * 10000n + amountInWithFee;
  return denominator === 0n ? 0n : numerator / denominator;
}

async function quoteUniV2(routerAddress, tokenIn, tokenOut, amountIn) {
  try {
    const amounts = await publicClient.readContract({
      address: routerAddress,
      abi: UNIV2_ROUTER_ABI,
      functionName: "getAmountsOut",
      args: [amountIn, [tokenIn, tokenOut]],
    });
    return amounts[amounts.length - 1];
  } catch (err) {
    throw new Error(
      `Uniswap V2 router at ${routerAddress} rejected getAmountsOut() — verify ` +
      `BASE_UNIV2_ROUTER on BaseScan before trusting it. Underlying error: ` +
      `${err.shortMessage || err.message}`
    );
  }
}

/// Aerodrome quoting requires knowing whether to route through the stable
/// or volatile pool for a given pair — unlike UniV2, both can coexist for
/// the same token pair with genuinely different reserves/pricing. This
/// quotes both pool types and takes the better live output. Stable-pool
/// support is still carried through the existing adapter extraData, so this
/// improves route quality without changing the on-chain public interface.
async function quoteAerodrome(routerAddress, tokenIn, tokenOut, amountIn, factory) {
  const tryRoute = async (stable) => {
    const amounts = await publicClient.readContract({
      address: routerAddress,
      abi: AERODROME_ROUTER_ABI,
      functionName: "getAmountsOut",
      args: [amountIn, [{ from: tokenIn, to: tokenOut, stable, factory }]],
    });
    return amounts[amounts.length - 1];
  };

  const [volatile, stable] = await Promise.allSettled([tryRoute(false), tryRoute(true)]);
  const quotes = [];
  if (volatile.status === "fulfilled") quotes.push({ amountOut: volatile.value, stable: false });
  if (stable.status === "fulfilled") quotes.push({ amountOut: stable.value, stable: true });
  if (quotes.length === 0) {
    throw new Error(
      `Aerodrome router at ${routerAddress} rejected getAmountsOut() for both ` +
      `stable and volatile routes on ${tokenIn} -> ${tokenOut}. Volatile error: ` +
      `${volatile.reason?.shortMessage || volatile.reason?.message}. Stable error: ` +
      `${stable.reason?.shortMessage || stable.reason?.message}`
    );
  }
  return quotes.sort((a, b) => (a.amountOut > b.amountOut ? -1 : a.amountOut < b.amountOut ? 1 : 0))[0];
}

/// Startup check: confirms both configured DEX routers actually respond to
/// their expected ABI shape, before the scan loop starts — same
/// fail-loud-and-early philosophy as the original zkSync scanner's
/// verifyThirdDexAbiOrExit, extended to cover both Base DEXs since neither
/// address has been re-verified on-chain by THIS specific deployment yet
/// (only cross-checked against external sources during setup).
async function verifyDexAbisOrExit() {
  const probeAmount = 10n ** 15n; // trivial size, purely to confirm the call succeeds
  try {
    await quoteUniV2(cfg.dexes.uniswapV2Router, cfg.tokens.WETH, cfg.tokens.USDC, probeAmount);
    console.log(`Uniswap V2 router ${cfg.dexes.uniswapV2Router} responds correctly — OK.`);
  } catch (err) {
    console.error(`\nSTARTUP CHECK FAILED (Uniswap V2):\n${err.message}\n`);
    process.exit(1);
  }

  try {
    const factory = cfg.dexes.aerodromeFactory;
    await quoteAerodrome(cfg.dexes.aerodromeRouter, cfg.tokens.WETH, cfg.tokens.USDC, probeAmount, factory);
    console.log(`Aerodrome router ${cfg.dexes.aerodromeRouter} responds correctly — OK.`);
  } catch (err) {
    console.error(`\nSTARTUP CHECK FAILED (Aerodrome):\n${err.message}\n`);
    process.exit(1);
  }
}

/// Aave V3 has no ERC-3156-style maxFlashLoan() view function. The
/// documented mechanism (Aave's own flash loan docs) is simpler: a
/// single-asset flashLoanSimple() can borrow up to the Pool's own token
/// balance for that asset (assuming the asset isn't paused/frozen for
/// flash loans, which isn't checked here — a genuinely thorough version
/// would also read the reserve's configuration flags via the Pool's
/// getReserveData, left as a further TODO). This checks the simpler,
/// more common failure mode: is there even enough of the token sitting in
/// the Pool to satisfy this specific loan size.
async function checkFlashLoanCapacity(startToken, amountIn) {
  const ERC20_BALANCE_ABI = [
    {
      name: "balanceOf",
      type: "function",
      stateMutability: "view",
      inputs: [{ name: "account", type: "address" }],
      outputs: [{ type: "uint256" }],
    },
  ];
  try {
    const reserveData = await publicClient.readContract({
      address: cfg.flashLoan.aavePool,
      abi: AAVE_POOL_ABI,
      functionName: "getReserveData",
      args: [startToken],
    });
    const configuration = reserveData.configuration ?? reserveData[0];
    const aTokenAddress = reserveData.aTokenAddress ?? reserveData[8];
    const active = ((configuration >> 56n) & 1n) === 1n;
    const frozen = ((configuration >> 57n) & 1n) === 1n;
    const paused = ((configuration >> 60n) & 1n) === 1n;
    const flashLoanEnabled = ((configuration >> 63n) & 1n) === 1n;

    if (!active || frozen || paused || !flashLoanEnabled) {
      console.log(
        "Aave reserve is not flash-loanable for this asset " +
        `(active=${active}, frozen=${frozen}, paused=${paused}, flashLoanEnabled=${flashLoanEnabled}).`
      );
      return false;
    }

    const availableLiquidity = await publicClient.readContract({
      address: startToken,
      abi: ERC20_BALANCE_ABI,
      functionName: "balanceOf",
      args: [aTokenAddress],
    });
    return availableLiquidity >= amountIn;
  } catch (err) {
    console.error("Aave flash capacity check failed:", err.shortMessage || err.message);
    return false; // fail closed
  }
}

async function getAaveFlashPremium(amountIn) {
  const premiumBps = await publicClient.readContract({
    address: cfg.flashLoan.aavePool,
    abi: AAVE_POOL_ABI,
    functionName: "FLASHLOAN_PREMIUM_TOTAL",
  });
  return {
    premiumBps,
    premium: (amountIn * premiumBps) / 10000n,
  };
}

function applySlippageFloor(amount, slippageBps = cfg.slippageBps) {
  return (amount * (10000n - BigInt(slippageBps))) / 10000n;
}

function estimateDynamicSlippageBps(route, amountIn) {
  if (!cfg.execution.dynamicSlippageEnabled) {
    return Number(cfg.slippageBps);
  }

  const sizeBps = Math.min(400, Math.max(0, Math.round(Number(amountIn) / 1e15)));
  const liquidityBps = Math.min(200, Math.max(0, (route.legs?.length || 1) * 25));
  const impactBps = Math.min(200, Math.max(0, Math.round(Number(amountIn) / 2e15)));
  const volatilityBps = cfg.execution.slippageVolatilityBps || 0;
  const baseBps = Number(cfg.slippageBps);
  const total = baseBps + (sizeBps * (cfg.execution.slippageSizeWeight || 1.0)) + (liquidityBps * (cfg.execution.slippageLiquidityWeight || 1.0)) + (impactBps * (cfg.execution.slippageImpactWeight || 1.0)) + volatilityBps;
  return Math.min(2000, Math.max(baseBps, total));
}

function getTradeSizingMultipliers() {
  if (!cfg.execution.dynamicSizingEnabled) return [1.0];
  const custom = (cfg.execution.dynamicSizingMultipliers || []).filter((value) => Number.isFinite(value) && value > 0);
  if (custom.length > 0) return custom;
  return [0.5, 1.0, 1.5, 2.0].filter((value) => value > 0 && value <= 2.0);
}

function scaleAmountIn(amountIn, multiplier) {
  return (amountIn * BigInt(Math.round(multiplier * 1000))) / 1000n;
}

function scoreOpportunity(route, amountIn, netProfitWei, gasCostWei, dynamicSlippageBps) {
  if (!cfg.execution.opportunityRankingEnabled) return 0;
  const profitScore = Number(netProfitWei) / 1e18;
  const gasPenalty = Number(gasCostWei) / 1e18;
  const liquidityScore = Math.max(0, 1 - Math.min(1, dynamicSlippageBps / 2000));
  const confidenceScore = Math.max(0, 1 - Math.min(1, dynamicSlippageBps / 2000));
  const expectedProfit = Number(route.amountOut > amountIn ? route.amountOut - amountIn : 0n) / 1e18;
  return (profitScore * 2) + expectedProfit + liquidityScore + confidenceScore - gasPenalty;
}

function netProfitFromSimulation(simulatedProfit) {
  return simulatedProfit;
}

function uniqueAddresses(addresses) {
  const seen = new Set();
  const out = [];
  for (const address of addresses.filter(Boolean)) {
    const key = address.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(address);
  }
  return out;
}

function routeLabel(route) {
  return route.legs
    .map((leg) => `${leg.venue}:${leg.tokenIn.slice(0, 6)}->${leg.tokenOut.slice(0, 6)}`)
    .join(" | ");
}

async function quoteVenue(venue, tokenIn, tokenOut, amountIn) {
  if (venue === "univ2") {
    const amountOut = await quoteUniV2(cfg.dexes.uniswapV2Router, tokenIn, tokenOut, amountIn);
    return {
      venue,
      tokenIn,
      tokenOut,
      amountIn,
      amountOut,
      slippageBps: estimateDynamicSlippageBps({ legs: [{ venue }] }, amountIn),
      stable: false,
    };
  }

  if (venue === "aerodrome") {
    const quote = await quoteAerodrome(
      cfg.dexes.aerodromeRouter,
      tokenIn,
      tokenOut,
      amountIn,
      cfg.dexes.aerodromeFactory
    );
    return {
      venue,
      tokenIn,
      tokenOut,
      amountIn,
      amountOut: quote.amountOut,
      slippageBps: estimateDynamicSlippageBps({ legs: [{ venue }] }, amountIn),
      stable: quote.stable,
    };
  }

  throw new Error(`unsupported venue ${venue}`);
}

function legFromQuote(quote) {
  const amountOutMin = applySlippageFloor(quote.amountOut, quote.slippageBps || cfg.slippageBps);
  const adapter = quote.venue === "univ2" ? cfg.contracts.uniswapV2Adapter : cfg.contracts.aerodromeAdapter;
  const extraData = quote.venue === "univ2"
    ? "0x"
    : encodeAerodromeExtraData(quote.stable, cfg.dexes.aerodromeFactory);

  return {
    adapter,
    hops: [{
      tokenIn: quote.tokenIn,
      tokenOut: quote.tokenOut,
      amountOutMin,
      extraData,
    }],
    amountOutMin,
  };
}

async function quoteTrianglePath(tokenA, tokenB, amountIn) {
  const venues = ["univ2", "aerodrome"];
  const candidates = [];

  for (const venue0 of venues) {
    let leg0;
    try {
      leg0 = await quoteVenue(venue0, cfg.tokens.WETH, tokenA, amountIn);
    } catch (_) {
      continue;
    }

    for (const venue1 of venues) {
      let leg1;
      try {
        leg1 = await quoteVenue(venue1, tokenA, tokenB, leg0.amountOut);
      } catch (_) {
        continue;
      }

      for (const venue2 of venues) {
        try {
          const leg2 = await quoteVenue(venue2, tokenB, cfg.tokens.WETH, leg1.amountOut);
          candidates.push({
            legs: [leg0, leg1, leg2],
            amountOut: leg2.amountOut,
          });
        } catch (_) {
          // Missing pair/liquidity for this venue; try the next venue.
        }
      }
    }
  }

  return candidates;
}

async function buildRouteCandidates(amountIn) {
  const middleTokens = uniqueAddresses([
    cfg.tokens.USDC,
    ...cfg.triangleTokens,
  ]).filter((token) => token.toLowerCase() !== cfg.tokens.WETH.toLowerCase());

  if (middleTokens.length < 2) {
    console.warn(
      "Need at least two non-WETH tokens for real 3-hop triangles. " +
      "Set BASE_TRIANGLE_TOKENS as a comma-separated address list."
    );
    return [];
  }

  const sizeMultipliers = getTradeSizingMultipliers();
  const amountsToTry = [...new Set(sizeMultipliers.map((multiplier) => scaleAmountIn(amountIn, multiplier).toString()))]
    .map((value) => BigInt(value));

  const candidates = [];
  for (const scaledAmountIn of amountsToTry) {
    for (const tokenA of middleTokens) {
      for (const tokenB of middleTokens) {
        if (tokenA.toLowerCase() === tokenB.toLowerCase()) continue;
        const quoted = await quoteTrianglePath(tokenA, tokenB, scaledAmountIn);
        for (const route of quoted) {
          candidates.push({ ...route, amountIn: scaledAmountIn });
        }
        if (candidates.length >= cfg.maxRouteCandidates) {
          return candidates
            .sort((a, b) => (a.amountOut > b.amountOut ? -1 : a.amountOut < b.amountOut ? 1 : 0))
            .slice(0, cfg.maxRouteCandidates);
        }
      }
    }
  }

  return candidates
    .sort((a, b) => (a.amountOut > b.amountOut ? -1 : a.amountOut < b.amountOut ? 1 : 0))
    .slice(0, cfg.maxRouteCandidates);
}

async function gasCostInStartToken(legs, amountIn, minProfitGuess, startToken) {
  if (!ESTIMATION_ACCOUNT) {
    throw new Error(
      "No PRIVATE_KEY or OWNER_ADDRESS set — cannot estimate gas (estimateContractGas " +
      "needs a `from` that passes the contract's onlyOwner check). Set one of these env vars."
    );
  }
  const gasPrice = await publicClient.getGasPrice();
  const bufferedGasPrice = (gasPrice * (10000n + cfg.gasPriceBufferBps)) / 10000n;

  const deadline = BigInt(Math.floor(Date.now() / 1000) + 300);
  const gasUnits = await publicClient.estimateContractGas({
    address: CONTRACT_ADDRESS,
    abi: TRIANGLE_ARB_ABI,
    functionName: CONTRACT_FUNCTION,
    args: [legs, amountIn, minProfitGuess, deadline],
    account: ESTIMATION_ACCOUNT,
  });

  const gasCostWei = gasUnits * bufferedGasPrice;

  // gasCostWei is denominated in ETH; if startToken isn't WETH, this
  // module doesn't do a unit conversion (same limitation the original
  // zkSync scanner had) — this assumes startToken IS WETH, which matches
  // this project's WETH-anchored triangle design throughout. Flag loudly
  // rather than silently returning a wrong-unit number if that assumption
  // ever changes.
  if (startToken.toLowerCase() !== cfg.tokens.WETH.toLowerCase()) {
    throw new Error(
      "gasCostInStartToken assumes startToken is WETH (gas is paid in ETH); " +
      `got startToken=${startToken}. Add a real ETH->startToken conversion ` +
      "before using this with a non-WETH-denominated triangle."
    );
  }

  return gasCostWei;
}

async function simulateExecution(legs, amountIn, minProfit) {
  if (!ESTIMATION_ACCOUNT) {
    throw new Error(
      "No PRIVATE_KEY or OWNER_ADDRESS set — cannot simulate execution " +
      "(the eth_call needs a `from` that passes onlyOwner)."
    );
  }

  const deadline = BigInt(Math.floor(Date.now() / 1000) + 300);
  const simulation = await publicClient.simulateContract({
    address: CONTRACT_ADDRESS,
    abi: TRIANGLE_ARB_ABI,
    functionName: CONTRACT_FUNCTION,
    args: [legs, amountIn, minProfit, deadline],
    account: ESTIMATION_ACCOUNT,
  });

  return simulation.result;
}

function legsUseFlashLenderProtocol(legs) {
  // Placeholder allowlist check mirroring the old SyncSwap-specific guard.
  // No equivalent Aave-V3-reentrancy conflict has been confirmed for Base
  // yet (see TriangleArbAaveFlash.sol's header comment) — this currently
  // always returns false until fork-testing proves otherwise. Do not
  // remove this function; wire in a real check the moment a conflict is
  // found, the same way the original SyncSwap conflict was discovered and
  // documented rather than assumed away.
  return false;
}

// Phase 3: remove the single global txInFlight guard in favor of per-
// route locking and per-block deduplication. This allows scanning to
// continue while background submissions proceed.

// Guards against ever having two of this process's own transactions
// in flight at once. Without this, a scan cycle that overlaps the next
// (very possible under load — see the scanInFlight guard in main() below)
// could submit a second trade before the first one's nonce has landed,
// risking a nonce collision, a double-spend of the same profitable
// opportunity, or two flash loans racing each other for the same Aave
// liquidity. Preserved exactly as before Phase 6/7 — txSubmitter.js and
// privateSubmit.js both operate WITHIN a single submit() call, they don't
// change the fact that only one submit() call runs at a time.
let txInFlight = false;

// Per-route in-flight tracking and per-block executed-route dedupe maps.
const inFlightRoutes = new Set();
const executedRoutesByBlock = new Map();

async function submit(legs, amountIn, minProfit) {
  if (!walletClient) {
    console.log(">>> [DRY RUN] would submit — no PRIVATE_KEY set, not sending a transaction.");
    return { confirmed: false, dryRun: true, viaPrivateRelay: false, reason: "dry run" };
  }

  const gate = circuitBreaker.checkAllowed();
  if (!gate.allowed) {
    console.warn(`submit skipped: circuit breaker is tripped — ${gate.reason}`);
    return { confirmed: false, reason: `circuit breaker: ${gate.reason}` };
  }

  try {
    // Nonce manager needs one authoritative chain read before it can
    // hand out nonces at all — done once per process, not once per
    // submit(), since sync() is a network call and every subsequent
    // nonce comes from local tracking (see nonceManager.js's header
    // comment on why local tracking exists in the first place).
    if (!nonceManagerSynced) {
      await nonceManager.sync();
      nonceManagerSynced = true;
    }
    if (!txSubmitter) {
      txSubmitter = createTxSubmitter(
        {
          walletClient,
          publicClient,
          nonceManager,
          gasPricer,
          circuitBreaker,
          relayClient,
          metrics: metricsAdapter,
          // Execution policy flags for public fallback behavior
          allowPublicFallback: cfg.execution.allowPublicFallback,
          publicBroadcastMaxWei: cfg.execution.publicBroadcastMaxWei,
          estimationAccount: ESTIMATION_ACCOUNT,
          simulatePrivateRelay: cfg.privateRelay.simulateBeforeSend,
        },
        {
          confirmationTimeoutBlocks: cfg.execution.confirmationTimeoutBlocks,
          maxReplacementAttempts: cfg.execution.maxReplacementAttempts,
        }
      );
    }

    const deadline = BigInt(Math.floor(Date.now() / 1000) + 300);
    const writeArgs = {
      address: CONTRACT_ADDRESS,
      abi: TRIANGLE_ARB_ABI,
      functionName: CONTRACT_FUNCTION,
      args: [legs, amountIn, minProfit, deadline],
    };

    const legsLabel = legs.map((leg) => leg.adapter.slice(0, 8)).join(" | ");
    const result = await txSubmitter.submitWithReplacement(writeArgs, legsLabel);

    if (result.confirmed) {
      console.log(`confirmed: ${result.hash}`);
      const gasWei = result.receipt.gasUsed * result.receipt.effectiveGasPrice;
      const lossWei = result.receipt.status === "success" ? 0n : gasWei;
      circuitBreaker.recordFill({ lossWei, gasWei });
    } else {
      console.error(`submit did not confirm: ${result.reason}`);
    }
    return result;
  } finally {
    // no global txInFlight flag to toggle
  }
}

// Local no-op default so evaluateAndMaybeSubmit(route, amountIn, startToken,
// flashFee) — i.e. every existing call site, including this file's own
// scanOnce() below and any external caller that predates Phase 5 — keeps
// working with zero behavior change when no metrics object is passed.
// Defined here (not imported from bot/graph/metrics.js) so scanner.js gains
// no new dependency on the graph/ subtree — this file should be usable
// completely standalone, same as it always has been.
const NOOP_METRICS = {
  incr() {},
  recordDuration() {},
  async timeAsync(_name, fn) {
    return fn();
  },
};

// Adapter exposing the simple metrics API expected by existing modules to
// the new Prometheus-based observability implementation. Keep calls
// synchronous where possible; heavy work (DB writes/webhooks) is done
// separately and best-effort.
const metricsAdapter = {
  incr: (name, labels = {}, value = 1) => {
    try { observability.incrCounter(name, labels, value); } catch (e) {}
  },
  async timeAsync(name, fn) {
    const start = Date.now();
    const res = await fn();
    const ms = Date.now() - start;
    try { observability.observeLatency(`${name}_ms`, ms); } catch (e) {}
    return res;
  },
};

async function evaluateAndMaybeSubmit(route, amountIn, startToken, flashFee, metrics = NOOP_METRICS, currentBlock = null, options = {}) {
  const legs = route.legs.map(legFromQuote);
  const skipSubmit = !!(options && options.skipSubmit);

  // Use actual suggested fees when computing the gas floor rather than
  // an independent gas-price estimate. This keeps profitability math
  // aligned with what will be used to submit.
  let fees;
  try {
    fees = await gasPricer.suggestFees();
  } catch (err) {
    console.error(`fee suggestion failed for ${routeLabel(route)}:`, err.message);
    metrics.incr("evaluate.fee_suggestion_failed");
    return false;
  }

  // Estimate gas units for the exact calldata we will send, then apply
  // the configured buffer (BPS) before multiplying by the suggested
  // maxFeePerGas to derive the wei cost used in profit checks.
  let gasUnits;
  try {
    gasUnits = await metrics.timeAsync("evaluate.gas_estimate_ms", () =>
      publicClient.estimateContractGas({
        address: CONTRACT_ADDRESS,
        abi: TRIANGLE_ARB_ABI,
        functionName: CONTRACT_FUNCTION,
        args: [legs, amountIn, 0n, BigInt(Math.floor(Date.now() / 1000) + 300)],
        account: ESTIMATION_ACCOUNT,
      })
    );
  } catch (err) {
    console.error(`gas estimation rejected ${routeLabel(route)}:`, err.shortMessage || err.message);
    metrics.incr("evaluate.gas_estimate_errored");
    return false;
  }

  const bufferBps = BigInt(cfg.execution.gasLimitBufferBps || 1500);
  const gasLimitBuffered = (gasUnits * (10000n + bufferBps) + 9999n) / 10000n; // ceil

  const gasCost = gasLimitBuffered * fees.maxFeePerGas;
  const requiredProfit = gasCost + (gasCost * cfg.minProfitMarginBps) / 10000n;

  // Final on-chain simulateExecution returns the slippage-adjusted
  // outcome (contract-level profit). Use that as the source of truth
  // for profitability, not the original spot quote (route.amountOut).
  let simulatedProfit;
  try {
    simulatedProfit = await metrics.timeAsync("evaluate.simulate_ms", () =>
      simulateExecution(legs, amountIn, requiredProfit)
    );
    console.log(`simulation OK: contract profit=${formatUnits(simulatedProfit, 18)} WETH`);
    metrics.incr("evaluate.simulation_ok");
  } catch (err) {
    console.error("simulation rejected exact calldata:", err.shortMessage || err.message);
    metrics.incr("evaluate.simulation_reverted");
    return false;
  }

  // executeTriangleFlash returns profit after principal + premium repayment
  // (see TriangleArbAaveFlash.executeOperation), so simulateExecution()
  // already includes the flash premium. Subtracting it here would double
  // charge flash-mode routes.
  const netProfitBeforeGas = netProfitFromSimulation(simulatedProfit);
  const profitable = netProfitBeforeGas >= requiredProfit;

  const dynamicSlippageBps = Math.max(
    ...route.legs.map((leg) => Number(leg.slippageBps || cfg.slippageBps))
  );
  const routeScore = scoreOpportunity(route, amountIn, netProfitBeforeGas, gasCost, dynamicSlippageBps);
  route.score = routeScore;
  route.dynamicSlippageBps = dynamicSlippageBps;
  route.simulatedProfit = simulatedProfit;
  route.requiredProfit = requiredProfit;
  route.netProfitBeforeGas = netProfitBeforeGas;
  route.gasCost = gasCost;

  console.log(
    `[${new Date().toISOString()}] ${routeLabel(route)} | ` +
      `simulatedBack=${formatUnits(simulatedProfit, 18)} WETH ` +
      `netBeforeGas=${formatUnits(netProfitBeforeGas, 18)} ` +
      `gasFloor=${formatUnits(requiredProfit, 18)} ` +
      `slippage=${dynamicSlippageBps}bps ` +
      `score=${routeScore.toFixed(2)} ` +
      `${profitable ? "PROFITABLE" : "below floor"}`
  );

  if (!profitable) {
    metrics.incr("evaluate.below_profit_floor");
    return false;
  }

  if (skipSubmit) {
    return true;
  }

  if (FLASH_MODE && legsUseFlashLenderProtocol(legs)) {
    console.log("legs route through the flash lender's own protocol; skipping.");
    metrics.incr("evaluate.flash_lender_protocol_conflict");
    return false;
  }

  const rHash = routeHashFor(route, amountIn);
  if (inFlightRoutes.has(rHash)) {
    console.log(`route already in flight; skipping duplicate submission for ${routeLabel(route)}`);
    metrics.incr("evaluate.route_in_flight");
    return false;
  }
  if (currentBlock != null && executedRoutesByBlock.get(currentBlock)?.has(rHash)) {
    console.log(`route already submitted in block ${currentBlock}; skipping duplicate for ${routeLabel(route)}`);
    metrics.incr("evaluate.route_block_deduped");
    return false;
  }

  // Reserve route dedupe and mark in-flight before launching background
  // submission so later scan cycles see the reservation.
  try {
    inFlightRoutes.add(rHash);
    if (currentBlock != null) {
      const set = executedRoutesByBlock.get(currentBlock) || new Set();
      set.add(rHash);
      executedRoutesByBlock.set(currentBlock, set);
    }

    // Launch submit in background and return immediately so scanning
    // can continue; cleanup the in-flight marker when done.
    (async () => {
      const startMs = Date.now();
      try {
        metrics.incr("evaluate.submit_attempted");
        const result = await submit(legs, amountIn, requiredProfit);
        const durationMs = Date.now() - startMs;
        // Record submission latency and outcomes
        try {
          observability.incrCounter('submission_attempts_total', { viaPrivate: result && result.viaPrivateRelay ? '1' : '0' });
          observability.observeLatency('submission_latency_ms', durationMs, {});
        } catch (e) {}

        if (result && result.confirmed) {
          // Persist trade-level analytics if route context available
          try {
            const db = require('./observability/db');
            const relay = result.viaPrivateRelay ? 'private' : 'public';
            const gasUsed = result.receipt && result.receipt.gasUsed ? Number(result.receipt.gasUsed) : null;
            const gasCostWei = result.receipt && result.receipt.effectiveGasPrice ? (BigInt(gasUsed || 0) * BigInt(result.receipt.effectiveGasPrice)).toString() : null;
            const execMs = durationMs;
            // route may have simulatedProfit/netProfitBeforeGas attached earlier in evaluate phase
            const simulatedProfit = route.simulatedProfit || null;
            const netProfit = route.netProfitBeforeGas || null;
            const flashFeeWei = flashFee ? flashFee.premium : 0n;
            db.insertTrade({
              ts: new Date().toISOString(),
              blockNumber: result.receipt ? result.receipt.blockNumber : null,
              route: routeLabel(route),
              dexSequence: route.legs.map(l => l.venue).join(','),
              flashAmountWei: FLASH_MODE ? amountIn.toString() : null,
              grossProfitWei: simulatedProfit ? simulatedProfit.toString() : null,
              netProfitWei: netProfit ? netProfit.toString() : null,
              gasUsed: gasUsed,
              gasCostWei: gasCostWei,
              flashFeeWei: flashFeeWei ? flashFeeWei.toString() : null,
              execDurationMs: execMs,
              relay: relay,
              confirmationTimeMs: result.receipt && result.receipt.blockNumber ? 0 : null,
              success: result.receipt && result.receipt.status === 'success',
              failureReason: result.receipt && result.receipt.status !== 'success' ? 'reverted' : null,
            });
          } catch (err) {
            console.error('failed to persist trade record:', err.message);
          }
        }
      } catch (err) {
        console.error(`background submit error for ${routeLabel(route)}: ${err.message}`);
      } finally {
        inFlightRoutes.delete(rHash);
      }
    })();

    return true;
  } catch (err) {
    // defensive cleanup on unexpected error
    inFlightRoutes.delete(rHash);
    return false;
  }
 }

async function scanOnce() {
  const amountIn = cfg.amountInWei;
  const startToken = cfg.tokens.WETH;
  const metrics = NOOP_METRICS;

  const candidates = await buildRouteCandidates(amountIn);
  if (candidates.length === 0) {
    console.log(`[${new Date().toISOString()}] no route candidates quoted`);
    return;
  }

  // Fetch current block once per scan cycle for per-block dedupe.
  let currentBlock = null;
  try {
    currentBlock = await publicClient.getBlockNumber();
  } catch (err) {
    console.error(`scanOnce: failed to read block number: ${err.message}`);
    // proceed with null -> evaluateAndMaybeSubmit will fallback
  }

  let bestCandidate = null;
  for (const candidate of candidates) {
    const effectiveAmountIn = candidate.amountIn || amountIn;
    let flashFee = null;
    if (FLASH_MODE) {
      const hasCapacity = await checkFlashLoanCapacity(startToken, effectiveAmountIn);
      if (!hasCapacity) {
        console.log("Aave pool lacks capacity for this candidate loan size; skipping.");
        continue;
      }
      try {
        flashFee = await getAaveFlashPremium(effectiveAmountIn);
      } catch (err) {
        console.error("Aave flash premium read failed:", err.shortMessage || err.message);
        continue;
      }
    }
    const profitable = await evaluateAndMaybeSubmit(
      candidate,
      effectiveAmountIn,
      startToken,
      flashFee,
      metrics,
      currentBlock,
      { skipSubmit: true }
    );
    if (!profitable) continue;
    candidate.flashFee = flashFee;
    if (!bestCandidate || (candidate.score || 0) > (bestCandidate.score || 0)) {
      bestCandidate = candidate;
    }
  }

  if (!bestCandidate) {
    return;
  }

  const effectiveAmountIn = bestCandidate.amountIn || amountIn;
  let finalFlashFee = bestCandidate.flashFee || null;
  if (FLASH_MODE) {
    const hasCapacity = await checkFlashLoanCapacity(startToken, effectiveAmountIn);
    if (!hasCapacity) {
      console.log("Aave pool lacks capacity for selected loan size; skipping.");
      return;
    }
    try {
      finalFlashFee = await getAaveFlashPremium(effectiveAmountIn);
    } catch (err) {
      console.error("Aave flash premium read failed:", err.shortMessage || err.message);
      return;
    }
  }
  await evaluateAndMaybeSubmit(
    bestCandidate,
    effectiveAmountIn,
    startToken,
    finalFlashFee,
    metrics,
    currentBlock
  );
}

function encodeAerodromeExtraData(stable, factory) {
  // Real ABI encoding via viem, matching AerodromeAdapter.sol's
  // abi.decode(hops[i].extraData, (bool, address)) exactly.
  return encodeAbiParameters(
    [{ type: "bool" }, { type: "address" }],
    [stable, factory]
  );
}

// True while a scanOnce() call is still running. Route-candidate building
// can issue dozens of RPC calls (up to maxRouteCandidates candidates across
// 2 venues per hop, plus Aave reads in flash mode); on a slow/rate-limited
// RPC a single cycle can easily exceed SCAN_INTERVAL_MS. Without this guard,
// setInterval would start a second scanOnce() on top of a still-running one,
// which is exactly how two "profitable" evaluations can both reach submit()
// for the same opportunity.
let scanInFlight = false;

async function main() {
  await verifyDexAbisOrExit();
  console.log(`Starting Base scanner (${FLASH_MODE ? "FLASH" : "pre-funded"} mode) against ${CONTRACT_ADDRESS}...`);
  const intervalMs = Number(process.env.SCAN_INTERVAL_MS || 3000);
  setInterval(() => {
    if (scanInFlight) {
      console.log("scan skipped: previous scan cycle still running.");
      return;
    }
    scanInFlight = true;
    scanOnce()
      .catch((err) => console.error("scan error:", err.message))
      .finally(() => {
        scanInFlight = false;
      });
  }, intervalMs);
}

// Only auto-run scanOnce()'s polling loop when this file is executed
// directly (`node bot/scanner.js`), not when it's require()'d as a module
// (bot/graph-scanner.js does exactly this — see that file's header comment
// on Phase 3). Without this guard, requiring scanner.js for its exported
// gasCostInStartToken/simulateExecution/submit/evaluateAndMaybeSubmit would
// ALSO silently start a second, independent scanOnce() polling loop against
// bot/scanner.js's own buildRouteCandidates() — two processes-in-one both
// able to reach submit(), racing each other for the same nonce and the same
// on-chain opportunity. require()'ing this module must be side-effect-free
// beyond the FATAL config-validation checks at the top of the file (those
// intentionally still run either way, so a misconfigured deployment fails
// fast regardless of which entrypoint is used).
if (require.main === module) {
  main().catch((err) => {
    console.error("fatal:", err);
    process.exit(1);
  });
}

// Exported so bot/graph-scanner.js can reuse the EXACT SAME gas-floor/
// simulate/submit safety path documented in that file's header comment,
// instead of re-implementing (and risking divergence in) any of it. In
// particular, submit()'s txInFlight lock is a module-local variable in
// THIS module — graph-scanner.js must call this exported submit (whether
// directly or via evaluateAndMaybeSubmit), never a copy, or the two
// scanners' in-flight guards can't see each other and the collision this
// lock exists to prevent becomes possible again across processes.
module.exports = {
  legFromQuote,
  applySlippageFloor,
  gasCostInStartToken,
  simulateExecution,
  submit,
  evaluateAndMaybeSubmit,
  legsUseFlashLenderProtocol,
  routeLabel,
  checkFlashLoanCapacity,
  getAaveFlashPremium,
  netProfitFromSimulation,
  CONTRACT_ADDRESS,
  FLASH_MODE,
};

function routeHashFor(route, amountIn) {
  // Use a deterministic, string-safe representation: routeLabel + amountIn
  const label = routeLabel(route);
  const key = `${label}|${amountIn.toString()}`;
  return crypto.createHash('sha256').update(key).digest('hex');
}
