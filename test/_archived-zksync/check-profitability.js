/**
 * Standalone, read-only profitability check for the SyncSwap-free flash
 * triangle: USDC.e -> USDT (Mute) -> WETH (SpaceFi) -> USDC.e (zkSwap
 * Finance).
 *
 * ROUTING NOTE: the USDT->WETH leg goes through SpaceFi, not zkSwap
 * Finance — zkSwap Finance's USDT/WETH pool was checked via getReserves()
 * and found to hold only ~$2,000 total liquidity (vs. SpaceFi's ~$15,000,
 * the deepest of the three UniV2-shaped DEXs checked). Routing through the
 * thin pool was the actual cause of earlier catastrophic-looking losses at
 * $5,000+ trade sizes — the pool was simply running dry, not a sign the
 * underlying strategy is unviable. See README.md "Fork test findings" for
 * the full comparison table. zkSwap Finance IS still used for the
 * WETH->USDC.e leg, where its pool is genuinely deep (~$108K).
 *
 * Unlike bot/scanner.js, this does NOT estimate gas, does NOT require a
 * deployed contract or adapter addresses, and NEVER submits a transaction
 * — it only calls read-only quote functions (getAmountsOut) across all
 * three hops, at several trade sizes, and reports whether a live,
 * mainnet-confirmed round trip is currently profitable before flash-loan
 * fee and gas, and after flash-loan fee alone (0.05%, SyncSwap Vault).
 * It does NOT account for real gas cost — see the printed caveat.
 *
 * All router/token addresses below were independently confirmed via real
 * executed swaps, live getAmountsOut calls, or live getReserves() depth
 * checks during fork testing this session — see README.md "Fork test
 * findings" for provenance on each.
 *
 * Run: node bot/check-profitability.js
 * Optional env: ZKSYNC_RPC_URL (defaults to public mainnet RPC)
 */

require("dotenv").config();
const { createPublicClient, http, formatUnits, parseUnits } = require("viem");

const RPC_URL = process.env.ZKSYNC_RPC_URL || "https://mainnet.era.zksync.io";

const client = createPublicClient({
  chain: { id: 324, name: "zkSync Era", nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RPC_URL] } } },
  transport: http(RPC_URL),
});

const TOKENS = {
  WETH: "0x5AEa5775959fBC2557Cc8789bC1bf90A239D9a91",
  USDC: "0x3355df6D4c9C3035724Fd0e3914dE96A5a83aaf4",
  USDT: "0x493257fD37EDB34451f62EDf8D2a0C418852bA4C",
};

const MUTE_ROUTER = "0x8B791913eB07C32779a16750e3868aA8495F5964";
const ZKSWAP_ROUTER = "0x18381c0f738146Fb694DE18D1106BdE2BE040Fa4";
const SPACEFI_ROUTER = "0xbE7D1FD1f6748bbDefC4fbaCafBb11C6Fc506d1d"; // deepest USDT/WETH pool of the three checked — see README.md comparison table
const SYNCSWAP_VAULT = "0x621425a1Ef6abE91058E9712575dcc4258F8d091";
const FLASH_FEE_BPS = 5n; // 0.05%, confirmed live via cast call FLASHLOAN_PREMIUM_TOTAL-style check on the vault during fork testing — SyncSwap Vault specifically, see README.md

const UNIV2_ABI = [
  {
    name: "getAmountsOut",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "amountIn", type: "uint256" },
      { name: "path", type: "address[]" },
    ],
    outputs: [{ name: "amounts", type: "uint256[]" }],
  },
];

const MUTE_ABI = [
  {
    name: "getAmountsOut",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "amountIn", type: "uint256" },
      { name: "path", type: "address[]" },
      { name: "stable", type: "bool[]" },
    ],
    outputs: [{ name: "amounts", type: "uint256[]" }],
  },
];

async function quoteMute(amountIn, tokenIn, tokenOut, stable) {
  const amounts = await client.readContract({
    address: MUTE_ROUTER,
    abi: MUTE_ABI,
    functionName: "getAmountsOut",
    args: [amountIn, [tokenIn, tokenOut], [stable]],
  });
  return amounts[amounts.length - 1];
}

async function quoteUniV2(routerAddress, amountIn, tokenIn, tokenOut) {
  const amounts = await client.readContract({
    address: routerAddress,
    abi: UNIV2_ABI,
    functionName: "getAmountsOut",
    args: [amountIn, [tokenIn, tokenOut]],
  });
  return amounts[amounts.length - 1];
}

async function checkSize(usdcAmountHuman) {
  const amountIn = parseUnits(String(usdcAmountHuman), 6); // USDC.e, 6 decimals

  // Leg 1: USDC.e -> USDT on Mute (stable pair, confirmed live in fork testing)
  const usdtOut = await quoteMute(amountIn, TOKENS.USDC, TOKENS.USDT, true);

  // Leg 2: USDT -> WETH on SpaceFi (deepest USDT/WETH pool of the three
  // checked — zkSwap Finance's equivalent pool holds only ~$2,000 total,
  // confirmed via getReserves(); see README.md)
  const wethOut = await quoteUniV2(SPACEFI_ROUTER, usdtOut, TOKENS.USDT, TOKENS.WETH);

  // Leg 3: WETH -> USDC.e on zkSwap Finance RouterV2
  const usdcBack = await quoteUniV2(ZKSWAP_ROUTER, wethOut, TOKENS.WETH, TOKENS.USDC);

  const flashFee = (amountIn * FLASH_FEE_BPS) / 10000n;
  const totalOwed = amountIn + flashFee;

  const grossPnl = usdcBack - amountIn; // before flash fee
  const netPnlAfterFlashFee = usdcBack - totalOwed; // after flash fee, still before gas

  return {
    amountIn,
    usdtOut,
    wethOut,
    usdcBack,
    flashFee,
    grossPnl,
    netPnlAfterFlashFee,
    profitableBeforeGas: netPnlAfterFlashFee > 0n,
  };
}

function fmtUsdc(x) {
  return formatUnits(x, 6);
}

function fmtUsdt(x) {
  return formatUnits(x, 6);
}

function fmtWeth(x) {
  return formatUnits(x, 18);
}

async function main() {
  console.log(`Checking live SyncSwap-free triangle profitability (USDC.e -> USDT [Mute] -> WETH [SpaceFi] -> USDC.e [zkSwap])`);
  console.log(`RPC: ${RPC_URL}\n`);

  // Sizes chosen around the actual confirmed liquidity ceiling: the
  // shallowest pool in this rotation (SpaceFi USDT/WETH, ~$15K total —
  // see README.md) makes anything above ~$5-10K show heavy slippage
  // regardless of how deep the other two legs are. Finer granularity here
  // than the original wide sweep, to actually find where (if anywhere)
  // this rotation crosses from profitable to unprofitable.
  const sizesUsdc = [50, 100, 250, 500, 1000, 2500, 5000, 7500, 10000];

  for (const size of sizesUsdc) {
    try {
      const r = await checkSize(size);
      const pnlStr = r.netPnlAfterFlashFee >= 0n ? `+${fmtUsdc(r.netPnlAfterFlashFee)}` : fmtUsdc(r.netPnlAfterFlashFee);
      console.log(
        `${String(size).padStart(6)} USDC.e in -> ${fmtUsdc(r.usdcBack)} USDC.e out | ` +
        `flash fee: ${fmtUsdc(r.flashFee)} | net P&L (before gas): ${pnlStr} USDC.e ` +
        `${r.profitableBeforeGas ? "✅ PROFITABLE (before gas)" : "❌ loss"}`
      );
      console.log(
        `         legs: ${fmtUsdc(r.amountIn)} USDC.e -> ${fmtUsdt(r.usdtOut)} USDT (Mute) ` +
        `-> ${fmtWeth(r.wethOut)} WETH (SpaceFi) -> ${fmtUsdc(r.usdcBack)} USDC.e (zkSwap)`
      );
    } catch (err) {
      console.error(`${size} USDC.e: quote failed — ${err.shortMessage || err.message}`);
    }
  }

  console.log(
    `\nCAVEAT: this does NOT subtract real transaction gas cost (zkSync Era gas ` +
    `is cheap but non-zero, and includes L1 pubdata cost which can dominate). ` +
    `A size marked "profitable before gas" here still needs gas cost subtracted ` +
    `before it's genuinely profitable — bot/scanner.js does that gas-aware check ` +
    `for real; this script is for a quick, no-deployment-needed sanity read on ` +
    `whether there's ANY edge worth chasing right now. Quotes also don't include ` +
    `price impact from your own trade moving the market further than these ` +
    `single-call estimates show for very large sizes, or from other bots front-running.`
  );
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
