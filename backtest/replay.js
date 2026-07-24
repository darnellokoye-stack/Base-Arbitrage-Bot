/**
 * Backtest step 2: replay bot/scanner.js's route enumeration and
 * gas-aware profit math against the cached reserve history.
 *
 * Run: node backtest/replay.js
 *
 * For every sample block, this rebuilds the SAME candidate set
 * bot/scanner.js's buildRouteCandidates()/quoteTrianglePath() would have
 * built live (WETH -> tokenA -> tokenB -> WETH, both venues per hop),
 * quotes each leg with the identical constant-product formula, applies
 * the same slippage floor and gas-aware profit buffer, and records the
 * best candidate's simulated net profit.
 *
 * WHAT THIS DOES NOT MODEL (read before trusting the results):
 *   - No competition. A real profitable window would likely be captured
 *     by other bots first; this counts every window where the math says
 *     "profitable," not "profitable AND uncontested."
 *   - No execution latency / reserve movement between quote and
 *     inclusion. Reserves are read as-of the sample block, as if the
 *     trade landed instantly at that exact state.
 *   - Aerodrome stable pools are excluded entirely (see discoverPools.js).
 *   - Gas units and Aave flash premium are configurable assumptions, not
 *     measured values — see backtest/config.js's comments.
 *   - This is a "would there have been a profitable window" simulation,
 *     not a "the live bot would have earned this" guarantee.
 */
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const cfg = require("./config");
const { loadFromCache } = require("./lib/fetchReserveHistory");
const { reservesAsOf } = require("./lib/reserveTimeline");
const { quoteThroughPool } = require("./lib/ammMath");
const { bufferedGasPriceWei } = require("./lib/gasHistory");

const FLASH_MODE = !!process.env.FLASH_MODE;
const VENUES = ["univ2", "aerodrome"];

function findPool(pools, tokenX, tokenY, venue) {
  const x = tokenX.toLowerCase();
  const y = tokenY.toLowerCase();
  return pools.find((p) => {
    if (p.venue !== venue) return false;
    const t0 = p.token0.toLowerCase();
    const t1 = p.token1.toLowerCase();
    return (t0 === x && t1 === y) || (t0 === y && t1 === x);
  }) || null;
}

// Resolves reserves as-of a target block for a pool, returning a
// {token0, token1, reserve0, reserve1, feeBps, venue} object ready for
// quoteThroughPool, or null if the pool has no history yet at that block.
function poolStateAsOf(pool, targetBlock) {
  const r = reservesAsOf(pool, targetBlock);
  if (!r) return null;
  return { address: pool.address, venue: pool.venue, feeBps: pool.feeBps, token0: pool.token0, token1: pool.token1, reserve0: r.reserve0, reserve1: r.reserve1 };
}

function applySlippageFloor(amount, cfg) {
  return (amount * (10000n - cfg.slippageBps)) / 10000n;
}

function middleTokens(cfg) {
  const set = new Set();
  if (cfg.tokens.USDC) set.add(cfg.tokens.USDC.toLowerCase());
  for (const t of cfg.triangleTokens) set.add(t.toLowerCase());
  set.delete(cfg.tokens.WETH.toLowerCase());
  return Array.from(set);
}

// Enumerates every (tokenA, tokenB, venue0, venue1, venue2) triangle and
// returns the best-by-gross-output candidate, or null if nothing quotes
// through at this block (matches quoteTrianglePath's try/skip-on-revert
// pattern, just against local reserves instead of RPC calls).
function bestCandidateAt(pools, tokens, amountIn, targetBlock, weth) {
  let best = null;

  for (const tokenA of tokens) {
    for (const tokenB of tokens) {
      if (tokenA === tokenB) continue;

      for (const venue0 of VENUES) {
        const pool0 = findPool(pools, weth, tokenA, venue0);
        if (!pool0) continue;
        const state0 = poolStateAsOf(pool0, targetBlock);
        if (!state0) continue;
        let amountOut0;
        try {
          amountOut0 = quoteThroughPool(state0, weth, tokenA, amountIn);
        } catch {
          continue;
        }
        if (amountOut0 === 0n) continue;

        for (const venue1 of VENUES) {
          const pool1 = findPool(pools, tokenA, tokenB, venue1);
          if (!pool1) continue;
          const state1 = poolStateAsOf(pool1, targetBlock);
          if (!state1) continue;
          let amountOut1;
          try {
            amountOut1 = quoteThroughPool(state1, tokenA, tokenB, amountOut0);
          } catch {
            continue;
          }
          if (amountOut1 === 0n) continue;

          for (const venue2 of VENUES) {
            const pool2 = findPool(pools, tokenB, weth, venue2);
            if (!pool2) continue;
            const state2 = poolStateAsOf(pool2, targetBlock);
            if (!state2) continue;
            let amountOut2;
            try {
              amountOut2 = quoteThroughPool(state2, tokenB, weth, amountOut1);
            } catch {
              continue;
            }
            if (amountOut2 === 0n) continue;

            if (!best || amountOut2 > best.amountOut) {
              best = {
                tokenA, tokenB,
                route: `WETH-[${venue0}]->A-[${venue1}]->B-[${venue2}]->WETH`,
                amountOut: amountOut2,
              };
            }
          }
        }
      }
    }
  }

  return best;
}

function csvEscape(v) {
  return typeof v === "string" && v.includes(",") ? `"${v}"` : v;
}

function main() {
  const pools = loadFromCache(cfg, "pools.json");
  const samples = loadFromCache(cfg, "samples.json");
  if (!pools || !samples) {
    console.error("No cached data found — run `node backtest/fetch-data.js` first.");
    process.exit(1);
  }

  const weth = cfg.tokens.WETH.toLowerCase();
  const tokens = middleTokens(cfg);
  if (tokens.length < 2) {
    console.error("Need at least two non-WETH tokens (BASE_USDC + BASE_TRIANGLE_TOKENS) for real 3-hop triangles.");
    process.exit(1);
  }

  const amountIn = cfg.amountInWei;
  const gasUnits = FLASH_MODE ? cfg.backtest.gasUnitsFlash : cfg.backtest.gasUnitsPreFunded;
  const flashPremiumBps = FLASH_MODE ? BigInt(cfg.backtest.assumedFlashPremiumBps) : 0n;

  const rows = [];
  let profitableCount = 0;

  console.log(`Replaying ${samples.length} sample(s) across ${tokens.length} middle token(s), ${FLASH_MODE ? "flash" : "pre-funded"} mode...`);

  for (const sample of samples) {
    const best = bestCandidateAt(pools, tokens, amountIn, sample.blockNumber, weth);

    if (!best) {
      rows.push({ timestamp: new Date(sample.timestampMs).toISOString(), blockNumber: sample.blockNumber.toString(), route: "", grossProfitWei: "", gasCostWei: "", flashPremiumWei: "", netProfitWei: "", profitable: false });
      continue;
    }

    const grossProfit = best.amountOut - amountIn;
    const gasPrice = bufferedGasPriceWei(sample.baseFeePerGas, cfg);
    const gasCostWei = gasUnits * gasPrice;
    const flashPremiumWei = (amountIn * flashPremiumBps) / 10000n;
    const slippageHaircut = amountIn - applySlippageFloor(amountIn, cfg); // conservative: worst-case slippage on notional, not on the specific quote
    const netProfit = grossProfit - gasCostWei - flashPremiumWei - slippageHaircut;
    const profitable = netProfit > 0n;
    if (profitable) profitableCount++;

    rows.push({
      timestamp: new Date(sample.timestampMs).toISOString(),
      blockNumber: sample.blockNumber.toString(),
      route: `${best.tokenA}->${best.tokenB} ${best.route}`,
      grossProfitWei: grossProfit.toString(),
      gasCostWei: gasCostWei.toString(),
      flashPremiumWei: flashPremiumWei.toString(),
      netProfitWei: netProfit.toString(),
      profitable,
    });
  }

  fs.mkdirSync(cfg.backtest.outputDir, { recursive: true });
  const outPath = path.join(cfg.backtest.outputDir, "replay.csv");
  const header = "timestamp,blockNumber,route,grossProfitWei,gasCostWei,flashPremiumWei,netProfitWei,profitable\n";
  const body = rows.map((r) => [r.timestamp, r.blockNumber, csvEscape(r.route), r.grossProfitWei, r.gasCostWei, r.flashPremiumWei, r.netProfitWei, r.profitable].join(",")).join("\n");
  fs.writeFileSync(outPath, header + body + "\n");

  console.log(`\nWrote ${rows.length} rows to ${outPath}`);
  console.log(`${profitableCount}/${rows.length} sample(s) simulated as net-profitable (${((profitableCount / rows.length) * 100).toFixed(2)}%).`);
  console.log("Next: node backtest/report.js");
}

if (require.main === module) {
  main();
}

module.exports = { findPool, poolStateAsOf, bestCandidateAt, middleTokens };
