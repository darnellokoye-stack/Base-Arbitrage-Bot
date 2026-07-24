/**
 * EDGE #2: small-trade size sweep for Base.
 *
 * THE ACTUAL EDGE: sophisticated MEV/arb operations pay real per-attempt
 * overhead — private-relay bundle tips, infra costs, opportunity cost of
 * their own capital/attention — so a lot of them simply don't bother
 * contesting opportunities below some profit floor (rough public
 * estimates put this floor at tens of dollars on L2s, though nobody
 * publishes an exact number and it varies by operation). A solo dev
 * running their own hardware has near-zero marginal cost per scan, so a
 * $15-40 opportunity that isn't worth a bot's attention can still be
 * worth yours.
 *
 * THE ACTUAL GAP THIS CLOSES: the parent bot/scanner.js (zkSync) checks
 * exactly ONE fixed trade size per scan cycle (amountIn = BigInt(cfg.
 * amountInWei)). That's fine for a known-liquidity, known-size strategy,
 * but it structurally cannot find "this specific small size is
 * profitable even though my configured size isn't" — it only ever asks
 * one question per cycle. This module asks several, cheaply, every cycle.
 *
 * This is a STANDALONE module, not a fork of scanner.js — it doesn't
 * touch or risk your working zkSync bot. It reuses the exact same
 * PATTERN (dynamic gas-aware minProfit recomputed every scan from live
 * gas price + a real eth_estimateGas call, not a static threshold) but
 * against a swept range of small sizes, and against Base's new-pool feed
 * from new-pool-listener.js rather than a fixed 3-DEX rotation.
 *
 * STATUS: quoting + gas-aware profitability math is real and reusable.
 * Execution (writeContract call) is stubbed pending a deployed Base
 * TriangleArb-equivalent contract — see the TODO near submitCandidate().
 * Do not treat "SUBMIT (dry run)" output as evidence anything executes.
 *
 * Run: node bot/base-edges/small-trade-sweep.js
 */

require("dotenv").config();
const { createPublicClient, http, formatUnits, parseUnits } = require("viem");
const { base } = require("viem/chains");
const cfg = require("./config");

const RPC_URL = cfg.RPC_URL;
const client = createPublicClient({ chain: base, transport: http(RPC_URL) });

// --- Sweep sizes -----------------------------------------------------
// Small on purpose — this module exists specifically to check sizes a
// fixed-amountIn bot (or a size-unaware human) wouldn't bother
// configuring. Denominated in the pool's paired known-token (WETH here;
// swap to USDC-denominated sizing if your triangle starts from USDC
// instead — see quoteLeg's decimals handling below).
const SWEEP_SIZES_ETH = (process.env.SWEEP_SIZES_ETH || "0.01,0.02,0.05,0.1,0.2,0.3,0.5")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const MIN_PROFIT_MARGIN_BPS = BigInt(process.env.MIN_PROFIT_MARGIN_BPS || 0);
const GAS_PRICE_BUFFER_BPS = BigInt(process.env.GAS_PRICE_BUFFER_BPS || 2000); // +20%, same default as parent scanner.js

// A rough, fixed per-attempt gas estimate for a 3-leg triangle call, used
// ONLY until a real contract is deployed on Base (at which point this
// should be replaced with a live estimateContractGas call against the
// real deployed address + calldata, exactly like parent scanner.js's
// estimateGasCostInStartToken does — see TODO below). This number is a
// placeholder assumption, not a measurement: three UniV2-style swaps
// chained through a single contract call, roughly comparable in shape to
// the zkSync TriangleArb contract's gas profile. DO NOT trust this for
// a real go/no-go decision — it exists so the sweep math is runnable and
// demonstrably correct before a contract exists to measure for real.
const PLACEHOLDER_GAS_UNITS = BigInt(process.env.PLACEHOLDER_GAS_UNITS || 220000);

const UNIV2_ROUTER_ABI = [
  {
    name: "getAmountsOut",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "amountIn", type: "uint256" },
      { name: "path", type: "address[]" },
    ],
    outputs: [{ type: "uint256[]" }],
  },
];

async function quoteUniV2(routerAddress, tokenIn, tokenOut, amountIn) {
  const amounts = await client.readContract({
    address: routerAddress,
    abi: UNIV2_ROUTER_ABI,
    functionName: "getAmountsOut",
    args: [amountIn, [tokenIn, tokenOut]],
  });
  return amounts[amounts.length - 1];
}

/**
 * Quotes a full triangle for one trade size: WETH -> newToken -> ... ->
 * WETH, given a fresh pool discovered by new-pool-listener.js and a
 * known-liquid third router to close the loop back to WETH.
 *
 * ROUTING NOTE: this assumes the fresh pool's OTHER side (the "known
 * token" it was paired against) is WETH, and that you have a separate,
 * established WETH<->newToken-adjacent route to close the triangle. For
 * a genuine 3-DEX triangle you need a real third leg — this function
 * takes routerForThirdLeg as a parameter rather than hardcoding one,
 * since which DEX can route the new token back to WETH is specific to
 * each discovered pool and isn't knowable in advance.
 */
async function quoteTriangleAtSize({
  amountInWei,
  freshPoolRouter,
  newToken,
  wethAddress,
  routerForThirdLeg,
}) {
  // Leg 1: WETH -> newToken, through the fresh pool's own router
  const newTokenOut = await quoteUniV2(freshPoolRouter, wethAddress, newToken, amountInWei);

  // Leg 2: newToken -> WETH, closing the loop. In a genuine 3-DEX
  // triangle this would route through an intermediate token on a
  // different DEX before returning to WETH; simplified to a direct
  // 2-hop round trip here since the exact intermediate depends on what
  // routes the discovered token actually has — wire in a real 3-leg path
  // once you know a specific new token's available routing.
  const wethBack = await quoteUniV2(routerForThirdLeg, newToken, wethAddress, newTokenOut);

  return { amountInWei, newTokenOut, wethBack };
}

async function gasCostInWeth() {
  const gasPrice = await client.getGasPrice();
  const bufferedGasPrice = (gasPrice * (10000n + GAS_PRICE_BUFFER_BPS)) / 10000n;
  // TODO: once a Base TriangleArb-equivalent contract is deployed, replace
  // PLACEHOLDER_GAS_UNITS with a live client.estimateContractGas(...) call
  // against the real address + calldata, exactly like parent scanner.js's
  // estimateGasCostInStartToken(). Keeping the placeholder clearly labeled
  // rather than silently presenting it as a real estimate.
  return PLACEHOLDER_GAS_UNITS * bufferedGasPrice;
}

/**
 * Sweeps all configured sizes against one fresh pool, returns any sizes
 * that clear gas-aware minProfit. Small trade sizes matter here
 * specifically: a size can be profitable in RAW terms while a larger
 * configured size on the same pool would show a loss from price impact
 * against thin fresh liquidity — this is the actual mechanism by which
 * "check more sizes" finds edge a single fixed-amountIn bot would miss.
 */
async function sweepPool({ freshPoolRouter, newToken, routerForThirdLeg }) {
  const wethAddress = cfg.knownTokens.WETH;
  const gasCost = await gasCostInWeth();
  const requiredProfit = gasCost + (gasCost * MIN_PROFIT_MARGIN_BPS) / 10000n;

  const results = [];
  for (const sizeStr of SWEEP_SIZES_ETH) {
    const amountInWei = parseUnits(sizeStr, 18);
    try {
      const { wethBack } = await quoteTriangleAtSize({
        amountInWei,
        freshPoolRouter,
        newToken,
        wethAddress,
        routerForThirdLeg,
      });
      const grossProfit = wethBack > amountInWei ? wethBack - amountInWei : 0n;
      const profitable = grossProfit >= requiredProfit;
      results.push({ sizeStr, amountInWei, wethBack, grossProfit, requiredProfit, profitable });
    } catch (err) {
      // A revert at one size (e.g. exceeds available liquidity) doesn't
      // mean smaller sizes will also fail — keep sweeping instead of
      // aborting the whole pass on one bad quote.
      results.push({ sizeStr, amountInWei, error: err.shortMessage || err.message });
    }
  }
  return results;
}

function reportResults(poolLabel, results) {
  console.log(`\n--- sweep: ${poolLabel} ---`);
  for (const r of results) {
    if (r.error) {
      console.log(`  ${r.sizeStr} WETH: quote failed (${r.error})`);
      continue;
    }
    const marker = r.profitable ? "✅ PROFITABLE (after gas)" : "  below required profit";
    console.log(
      `  ${r.sizeStr.padStart(6)} WETH in -> ${formatUnits(r.wethBack, 18)} WETH out | ` +
      `gross=${formatUnits(r.grossProfit, 18)} required=${formatUnits(r.requiredProfit, 18)} ${marker}`
    );
  }
}

/**
 * TODO: not yet wired to a real contract. Once a Base TriangleArb
 * (or TriangleArbFlash) deployment exists, this is where a profitable
 * sweep result gets submitted — mirroring parent scanner.js's
 * walletClient.writeContract call, with legs built from the specific
 * router addresses used in the winning quote. Left unimplemented
 * deliberately rather than guessed at.
 */
function submitCandidate(poolLabel, result) {
  console.log(
    `>>> [DRY RUN — NOT SUBMITTED] ${poolLabel} @ ${result.sizeStr} WETH would submit here ` +
    `once a Base contract is deployed and wired in. No transaction sent.`
  );
}

/**
 * Entry point for a single fresh-pool candidate (e.g. handed off from
 * new-pool-listener.js's onFreshPool). Exported so new-pool-listener.js
 * (or any other discovery source) can call this directly instead of
 * this file needing its own duplicate discovery logic.
 */
async function checkCandidate({ poolLabel, freshPoolRouter, newToken, routerForThirdLeg }) {
  const results = await sweepPool({ freshPoolRouter, newToken, routerForThirdLeg });
  reportResults(poolLabel, results);
  const winners = results.filter((r) => r.profitable);
  for (const w of winners) {
    submitCandidate(poolLabel, w);
  }
  return winners;
}

// Standalone run: demonstrates the sweep math against a manually-provided
// candidate (env-configured) rather than waiting on live pool discovery,
// so this file's logic is independently testable/runnable on its own.
async function main() {
  const freshPoolRouter = process.env.DEMO_ROUTER;
  const newToken = process.env.DEMO_NEW_TOKEN;
  const routerForThirdLeg = process.env.DEMO_THIRD_ROUTER || freshPoolRouter;

  if (!freshPoolRouter || !newToken) {
    console.log(
      "Standalone demo mode needs DEMO_ROUTER and DEMO_NEW_TOKEN env vars " +
      "(a real UniV2-shaped router + a real token address on Base) to run " +
      "against something concrete. In real use, checkCandidate() is called " +
      "directly by new-pool-listener.js once it finds a fresh pool — this " +
      "main() is a standalone test harness, not the primary entry point."
    );
    process.exit(1);
  }

  console.log(`Sweeping sizes [${SWEEP_SIZES_ETH.join(", ")}] WETH against ${newToken}...`);
  await checkCandidate({ poolLabel: newToken, freshPoolRouter, newToken, routerForThirdLeg });
}

if (require.main === module) {
  main().catch((err) => {
    console.error("fatal:", err);
    process.exit(1);
  });
}

module.exports = { checkCandidate, sweepPool, SWEEP_SIZES_ETH };
