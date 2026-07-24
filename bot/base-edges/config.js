// Re-exports bot/config.js (the single source of truth for Base addresses,
// now that the whole project runs on Base) and adds only the settings
// specific to pool-discovery/small-trade-sweep that the core scanner
// doesn't need. Previously this file duplicated factory addresses
// independently — consolidated after the full Base migration to avoid the
// two configs drifting out of sync with each other.

const core = require("../config");

module.exports = {
  ...core,

  factories: {
    uniswapV2: core.dexes.uniswapV2Factory,
    aerodromeFactory: core.dexes.aerodromeFactory,
  },

  knownTokens: {
    WETH: core.tokens.WETH,
    USDC: core.tokens.USDC,
  },

  minPoolLiquidityWei: BigInt(process.env.MIN_POOL_LIQUIDITY_WEI || "500000000000000000"), // 0.5 ETH-equivalent
  freshPoolWindowMs: Number(process.env.FRESH_POOL_WINDOW_MS || 30 * 60 * 1000), // 30 min
  freshPoolPollIntervalMs: Number(process.env.FRESH_POOL_POLL_INTERVAL_MS || 2000),
};
