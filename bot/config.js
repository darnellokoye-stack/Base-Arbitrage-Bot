// Base-chain config — replaces the old zkSync Era setup entirely.
// Per-address verification status is noted individually below; this
// project's own established standard (see main README's "fork test
// findings" section) is: confirmed-from-a-primary-source is a starting
// point, not a substitute for your own on-chain re-verification
// (cast call / a real read function) before committing real capital.

const RPC_URL = process.env.BASE_RPC_URL || "https://mainnet.base.org";
const WS_RPC_URL = process.env.BASE_WS_RPC_URL || null;

function parseAddressList(value) {
  if (!value) return [];
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function parseNumericList(value) {
  if (!value) return [];
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => Number(entry));
}

module.exports = {
  RPC_URL,
  WS_RPC_URL,
  chainId: 8453,

  tokens: {
    // Base's canonical WETH predeploy — confirmed live via BaseScan
    // (matches the address embedded in Aerodrome's own deployed Router
    // ABI, cross-checked independently).
    WETH: process.env.BASE_WETH || "0x4200000000000000000000000000000000000006",

    // Native USDC on Base (Circle-issued, not a bridged/wrapped variant).
    // NOT hardcoded from memory — set this explicitly and verify on
    // BaseScan/Circle's own docs before use. Left required (no default)
    // deliberately, unlike WETH, since USDC contract addresses are a
    // common target for lookalike/scam token confusion and this project
    // has already been burned once by trusting an address without
    // independent verification.
    USDC: process.env.BASE_USDC || null,
  },

  dexes: {
    // Uniswap V2 Router02 on Base. Confirmed live via BaseScan:
    // 24.2M+ transactions, verified contract, active balance at time of
    // writing. Plain UniswapV2Router shape — works with the existing
    // UniswapV2Adapter unmodified.
    uniswapV2Router: process.env.BASE_UNIV2_ROUTER || "0x4752ba5dbc23f44d87826276bf6fd6b1c372ad24",

    // Uniswap V2 Factory on Base. Confirmed via Uniswap's own official
    // docs (developers.uniswap.org/docs/protocols/v2/deployments, "Base"
    // row). Used by the new-pool listener for PairCreated events.
    uniswapV2Factory: process.env.BASE_UNIV2_FACTORY || "0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6",

    // Aerodrome Finance — Base's largest DEX by TVL. Confirmed via the
    // deployed Router contract's own live, verified ABI on BaseScan
    // (3.8M+ transactions, active at time of writing) AND cross-checked
    // against Aerodrome's own GitHub (github.com/aerodrome-finance/contracts).
    // NOT a plain UniswapV2 shape — uses AerodromeAdapter, not
    // UniswapV2Adapter. See contracts/interfaces/IAerodromeRouter.sol for
    // the specific ABI differences.
    aerodromeRouter: process.env.BASE_AERODROME_ROUTER || "0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43",
    aerodromeFactory: process.env.BASE_AERODROME_FACTORY || "0x420DD381b31aEf6683db6B902084cB0FFECe40Da",
  },

  flashLoan: {
    // Aave V3 Pool Proxy on Base. Confirmed live via BaseScan: "Aave: Pool
    // Proxy Base", verified, 1M+ transactions, active balance at time of
    // writing. NOT ERC-3156 shaped — see contracts/interfaces/
    // IAaveV3Flash.sol for the specific callback/function differences from
    // the SyncSwap-based flash contract this replaces.
    aavePool: process.env.BASE_AAVE_POOL || "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5",
  },

  // Deployed contract addresses — filled in after you deploy (see
  // scripts/deploy-base.md). Left null so the scanner fails loudly on
  // startup rather than silently pointing at a zero address if you forget
  // to set these post-deployment.
  contracts: {
    triangleArb: process.env.BASE_TRIANGLE_ARB || null,
    triangleArbAaveFlash: process.env.BASE_TRIANGLE_ARB_AAVE_FLASH || null,
    // Per-DEX adapter contracts (deployed once, reused across every scan —
    // NOT the same as the DEX's own router address above; these are this
    // project's own ISwapAdapter-implementing wrapper contracts).
    uniswapV2Adapter: process.env.BASE_UNIV2_ADAPTER || null,
    aerodromeAdapter: process.env.BASE_AERODROME_ADAPTER || null,
  },

  // Same gas-aware minProfit pattern as the original zkSync scanner —
  // live gas price + buffer, recomputed every scan, not a static threshold.
  gasPriceBufferBps: BigInt(process.env.GAS_PRICE_BUFFER_BPS || 2000), // +20%
  minProfitMarginBps: BigInt(process.env.MIN_PROFIT_MARGIN_BPS || 0),
  slippageBps: BigInt(process.env.SLIPPAGE_BPS || 50), // 0.50% per leg
  maxRouteCandidates: Number(process.env.MAX_ROUTE_CANDIDATES || 50),
  triangleTokens: parseAddressList(process.env.BASE_TRIANGLE_TOKENS),

  amountInWei: BigInt(process.env.AMOUNT_IN_WEI || "100000000000000000"), // 0.1 WETH default

  // Multicall3 — same address on every EVM chain that supports it,
  // including Base (canonical deterministic-deployment address, not
  // chain-specific). Confirmed via Multicall3's own docs
  // (github.com/mds1/multicall, "Deployments" table lists Base at this
  // address). Re-verify on BaseScan before relying on it, same standard
  // as every other address in this file.
  multicall3: process.env.BASE_MULTICALL3 || "0xcA11bde05977b3631167028862bE2a173976CA11",

  // Dynamic liquidity graph settings (event-driven reserve cache instead
  // of an on-chain getAmountsOut call per candidate). See bot/graph/.
  graph: {
    // Blocks to wait before treating a Sync/Swap-driven reserve update as
    // final. Base's block time is fast (~2s) and reorgs of any depth are
    // rare but not impossible; this is a deliberate, documented tradeoff,
    // not zero. A reorg deeper than this window between a reserve update
    // and its use in a simulated quote means the graph is briefly wrong.
    // The final on-chain eth_call simulation (simulateExecution) before
    // submission is the actual safety net for that gap — this cache is a
    // speed optimization, never a substitute for that final check.
    confirmationDepth: Number(process.env.GRAPH_CONFIRMATION_DEPTH || 2),
    // If a pool hasn't received a Sync/Swap event in this long, treat its
    // cached reserves as stale and refetch via multicall before quoting
    // against it, rather than trusting an old event-driven snapshot
    // indefinitely (covers missed events / a dropped WS connection).
    maxReserveAgeMs: Number(process.env.GRAPH_MAX_RESERVE_AGE_MS || 60_000),

    // Minimum WETH-side reserve for a pool to be tracked at bootstrap.
    // Only applied to pools where WETH is directly one of the two tokens
    // (see bootstrapGraph()'s comment for why non-WETH pairs skip this
    // check rather than attempting a rough USD conversion) — same
    // 0.5 ETH-equivalent default as base-edges/config.js's
    // minPoolLiquidityWei, for consistency across the project's two
    // liquidity floors.
    minPoolLiquidityWeth: BigInt(process.env.GRAPH_MIN_POOL_LIQUIDITY_WETH || "500000000000000000"),

    // Phase 4 candidate filtering (bot/graph-scanner.js's
    // filterCandidateCycles) — cheap, zero-RPC checks applied to a cycle
    // BEFORE it's spent on a multicall re-quote, so an obviously bad
    // candidate never reaches the RPC-costing step at all.

    // Sum of every hop's feeBps in a cycle, above which the cycle is
    // discarded before re-quoting. A 5-hop cycle at 30bps/hop already
    // burns 1.5% to fees before slippage or gas even enter the picture —
    // Bellman-Ford's logProfit can still show "profitable" for such a
    // cycle at graph-snapshot time (its edge weights already bake fees
    // in), but a long, fee-heavy cycle is a worse bet per RPC dollar
    // spent verifying it than a short, cheap one. Default of 100bps is
    // roughly "more than 3 typical univ2-fee hops" — tune per risk
    // appetite, not a correctness bound.
    maxCycleFeeBps: Number(process.env.GRAPH_MAX_CYCLE_FEE_BPS || 100),

    // Estimated price impact ceiling (in bps of amountOut lost to the
    // constant-product curve vs. the marginal/spot rate), computed
    // locally per hop from cached reserves via quoteConstantProduct — no
    // RPC call. This is an ESTIMATE against a possibly-stale or
    // not-yet-confirmed reserve snapshot (see liquidityGraph.js's
    // staleness/confirmationDepth comments); it exists to prune obviously
    // thin pools before spending a multicall re-quote on them, not to
    // replace the real on-chain quote or the final simulateExecution
    // check. Expressed per-hop, not cumulative — one severely thin hop
    // should disqualify a cycle even if the others are fine.
    maxPriceImpactBps: Number(process.env.GRAPH_MAX_PRICE_IMPACT_BPS || 300),

    // How long to wait before attempting to re-establish subscriptions
    // and force a full resync after a WS subscription error. Not
    // immediate/zero on purpose — an error firing on every subscription
    // tied to the same dropped socket would otherwise pile up simultaneous
    // reconnect attempts; see liquidityGraph.js's _handleWsError.
    wsReconnectDelayMs: Number(process.env.GRAPH_WS_RECONNECT_DELAY_MS || 3000),
  },

  execution: {
    dailyLossLimitWei: BigInt(process.env.DAILY_LOSS_LIMIT_WEI || "50000000000000000"),
    dailyGasBudgetWei: BigInt(process.env.DAILY_GAS_BUDGET_WEI || "200000000000000000"),
    maxConsecutiveFailures: Number(process.env.MAX_CONSECUTIVE_FAILURES || 3),
    priorityFeeFloorWei: BigInt(process.env.PRIORITY_FEE_FLOOR_WEI || "10000000"),
    maxFeeCeilingWei: BigInt(process.env.MAX_FEE_CEILING_WEI || "5000000000"),
    replacementEscalationBps: BigInt(process.env.REPLACEMENT_ESCALATION_BPS || 1250),
    baseFeeHeadroomBlocks: Number(process.env.BASE_FEE_HEADROOM_BLOCKS || 3),
    confirmationTimeoutBlocks: Number(process.env.CONFIRMATION_TIMEOUT_BLOCKS || 3),
    maxReplacementAttempts: Number(process.env.MAX_REPLACEMENT_ATTEMPTS || 3),
    // Whether broadcasting to the public mempool is allowed when a private
    // relay is not configured. Default `false` prevents accidental public
    // broadcasts of large-value trades when an operator intended to use
    // private submission only.
    allowPublicFallback: (process.env.ALLOW_PUBLIC_FALLBACK || "false") === "true",
    // If `allowPublicFallback` is false and no private relay is configured,
    // reject any trade whose `amountIn` (the second arg to executeTriangle)
    // exceeds this wei threshold. Default 0 (reject all public broadcasts
    // when private relay disabled).
    publicBroadcastMaxWei: BigInt(process.env.PUBLIC_BROADCAST_MAX_WEI || "0"),
    // Gas limit safety buffer expressed in basis points (10000 = 100%).
    // Default 1500 = 15% buffer applied to estimated gas before signing.
    gasLimitBufferBps: Number(process.env.GAS_LIMIT_BUFFER_BPS || 1500),
    // Phase 5 trade-quality controls.
    dynamicSlippageEnabled: (process.env.DYNAMIC_SLIPPAGE_ENABLED || "true") === "true",
    slippageLiquidityWeight: Number(process.env.SLIPPAGE_LIQUIDITY_WEIGHT || 1.0),
    slippageSizeWeight: Number(process.env.SLIPPAGE_SIZE_WEIGHT || 1.0),
    slippageImpactWeight: Number(process.env.SLIPPAGE_IMPACT_WEIGHT || 1.0),
    slippageVolatilityBps: Number(process.env.SLIPPAGE_VOLATILITY_BPS || 0),
    dynamicSizingEnabled: (process.env.DYNAMIC_SIZING_ENABLED || "true") === "true",
    dynamicSizingMultipliers: parseNumericList(process.env.DYNAMIC_SIZING_MULTIPLIERS || "0.5,1.0,1.5,2.0"),
    opportunityRankingEnabled: (process.env.OPPORTUNITY_RANKING_ENABLED || "true") === "true",
  },

  privateRelay: {
    // Set to "bloxroute" to use bloXroute's Base Network blxr_tx API
    // (bot/execution/privateSubmit.js's createBloxrouteRelayClient)
    // instead of the generic eth_sendPrivateTransaction client. Anything
    // else (including unset) uses the generic client against `url`.
    provider: process.env.BASE_PRIVATE_RELAY_PROVIDER || null,
    url: process.env.BASE_PRIVATE_RELAY_URL || null,
    // bloXroute Account Portal "Authorization" value — required when
    // provider is "bloxroute", ignored otherwise.
    authHeader: process.env.BASE_PRIVATE_RELAY_AUTH_HEADER || null,
    simulateBeforeSend: process.env.PRIVATE_RELAY_SIMULATE !== "0",
  },
};
