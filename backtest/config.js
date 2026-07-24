// Backtest-specific config. Reuses bot/config.js for everything that's
// already environment-driven there (RPC_URL, tokens, dex addresses,
// slippageBps, gasPriceBufferBps, amountInWei, triangleTokens, etc.) so
// the backtest is always evaluating the SAME token universe and thresholds
// the live scanner would use — not a separately-drifting copy.
//
// This file only adds the handful of settings that are backtest-only and
// have no live-scanner equivalent (time range, sampling resolution, log
// chunk size, unverified gas-unit estimate).

const path = require("path");
const cfg = require("../bot/config");

function parseDate(value, fallbackDaysAgo) {
  if (value) {
    const ms = Date.parse(value);
    if (Number.isNaN(ms)) {
      throw new Error(`backtest config: could not parse date "${value}" — use an ISO string like 2026-06-23`);
    }
    return ms;
  }
  return Date.now() - fallbackDaysAgo * 24 * 60 * 60 * 1000;
}

const START_MS = parseDate(process.env.BACKTEST_START, 30);
const END_MS = parseDate(process.env.BACKTEST_END, 0);

module.exports = {
  ...cfg,

  backtest: {
    startMs: START_MS,
    endMs: END_MS,

    // How often to "run the scanner" against reconstructed reserves.
    // Real scan cycles happen roughly every RPC round trip (seconds); a
    // 30-day backtest at that resolution is enormous and mostly redundant
    // (reserves between blocks are usually unchanged). Default 15 minutes
    // is a deliberate resolution/cost tradeoff — lower it for a shorter
    // window if you want closer-to-live fidelity.
    sampleIntervalMinutes: Number(process.env.BACKTEST_SAMPLE_MINUTES || 15),

    // eth_getLogs block-range chunk size. Public/free RPC endpoints
    // commonly cap this well below what archive providers allow (some as
    // low as 500-2000 blocks per call) — fetchReserveHistory.js halves
    // this automatically on a range-too-large error, so this is a
    // starting point, not a hard requirement to get right up front.
    logChunkBlocks: Number(process.env.BACKTEST_LOG_CHUNK_BLOCKS || 5000),

    // Base's block time isn't perfectly constant; used only as a first
    // guess to seed the binary search in lib/blockRange.js, not trusted
    // as authoritative.
    approxBlockTimeMs: Number(process.env.BACKTEST_APPROX_BLOCK_TIME_MS || 2000),

    // UNVERIFIED — no deployed contract exists to run estimateContractGas
    // against for historical blocks, unlike the live scanner's
    // gasCostInStartToken(). This is a placeholder gas-units figure; if
    // you have a real forge/fork-test gas report for
    // executeTriangle/executeTriangleFlash, set these env vars to that
    // number instead of trusting the default.
    gasUnitsPreFunded: BigInt(process.env.BACKTEST_GAS_UNITS_PREFUNDED || "320000"),
    gasUnitsFlash: BigInt(process.env.BACKTEST_GAS_UNITS_FLASH || "480000"),

    // Base is EIP-1559; historical blocks give you baseFeePerGas exactly,
    // but not the priority fee actually paid by any given historical
    // transaction. This adds a flat assumed priority fee on top of
    // baseFeePerGas, then applies the live scanner's own
    // gasPriceBufferBps on top of that sum — an approximation, not a
    // reconstruction of what publicClient.getGasPrice() would have
    // returned at that historical block.
    assumedPriorityFeeGwei: Number(process.env.BACKTEST_PRIORITY_FEE_GWEI || 0.05),

    // Aave V3's FLASHLOAN_PREMIUM_TOTAL() is a live view call with no
    // historical-block guarantee of being queryable the same way through
    // every RPC provider's log/state retention; treated as a constant
    // here rather than re-fetched per sample block. Aave V3's total flash
    // premium on most deployments has been 5 bps for a long time, but
    // VERIFY this against the actual value for the block range you're
    // testing (a single eth_call with a blockNumber override against an
    // archive RPC) before trusting flash-mode results.
    assumedFlashPremiumBps: Number(process.env.BACKTEST_FLASH_PREMIUM_BPS || 5),

    cacheDir: path.join(__dirname, "cache"),
    outputDir: path.join(__dirname, "output"),
  },
};
