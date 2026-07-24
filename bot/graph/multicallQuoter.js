/**
 * Multicall-batched quoting.
 *
 * The original scanner (bot/scanner.js's quoteVenue/quoteTrianglePath)
 * issues one RPC round trip per (venue, hop) combination — for
 * MAX_ROUTE_CANDIDATES=50 candidates across 2 venues and up to 3 hops,
 * that's potentially hundreds of sequential `eth_call`s per scan cycle.
 * On a public RPC (mainnet.base.org) this is the concrete bottleneck
 * flagged in review: it rate-limits fast and adds latency per candidate,
 * so by the time candidate #40 is quoted, candidate #3's numbers may
 * already be stale.
 *
 * Multicall3 (github.com/mds1/multicall) batches many read calls into a
 * single `eth_call` against one contract, at one block height, so every
 * quote in a batch is consistent with every other quote in that same
 * batch — not just faster, but internally coherent in a way N sequential
 * calls across N different (possibly different) block heights are not.
 *
 * This module does NOT replace bot/scanner.js. It's an additive,
 * side-by-side quoting path so the two can be compared during a dry run
 * before anything is switched over for real.
 */

const { encodeFunctionData, decodeFunctionResult } = require("viem");
const cfg = require("../config");

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

const UNIV2_GET_AMOUNTS_OUT_ABI = [
  {
    name: "getAmountsOut",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "amountIn", type: "uint256" }, { name: "path", type: "address[]" }],
    outputs: [{ type: "uint256[]" }],
  },
];

const AERODROME_GET_AMOUNTS_OUT_ABI = [
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
];

/**
 * @param requests array of either:
 *   { venue: "univ2", tokenIn, tokenOut, amountIn }
 *   { venue: "aerodrome", tokenIn, tokenOut, amountIn, stable, factory }
 * @returns array, same order/length as requests, of either
 *   { ok: true, amountOut } or { ok: false, error }
 */
async function batchQuote(publicClient, requests) {
  if (requests.length === 0) return [];

  const calls = requests.map((req) => {
    if (req.venue === "univ2") {
      return {
        target: cfg.dexes.uniswapV2Router,
        allowFailure: true,
        callData: encodeFunctionData({
          abi: UNIV2_GET_AMOUNTS_OUT_ABI,
          functionName: "getAmountsOut",
          args: [req.amountIn, [req.tokenIn, req.tokenOut]],
        }),
      };
    }
    if (req.venue === "aerodrome") {
      return {
        target: cfg.dexes.aerodromeRouter,
        allowFailure: true,
        callData: encodeFunctionData({
          abi: AERODROME_GET_AMOUNTS_OUT_ABI,
          functionName: "getAmountsOut",
          args: [
            req.amountIn,
            [{ from: req.tokenIn, to: req.tokenOut, stable: req.stable, factory: req.factory }],
          ],
        }),
      };
    }
    throw new Error(`batchQuote: unsupported venue ${req.venue}`);
  });

  // Single eth_call, single block height, for every quote in this batch —
  // this is the coherence property sequential calls don't give you, on
  // top of the round-trip-count win.
  const results = await publicClient.readContract({
    address: cfg.multicall3,
    abi: MULTICALL3_ABI,
    functionName: "aggregate3",
    args: [calls],
  });

  return results.map((result, i) => {
    const req = requests[i];
    if (!result.success) {
      return { ok: false, error: `multicall entry ${i} (${req.venue} ${req.tokenIn}->${req.tokenOut}) reverted` };
    }
    try {
      const abi = req.venue === "univ2" ? UNIV2_GET_AMOUNTS_OUT_ABI : AERODROME_GET_AMOUNTS_OUT_ABI;
      const decoded = decodeFunctionResult({
        abi,
        functionName: "getAmountsOut",
        data: result.returnData,
      });
      const amounts = decoded;
      return { ok: true, amountOut: amounts[amounts.length - 1] };
    } catch (err) {
      return { ok: false, error: `decode failed for entry ${i}: ${err.message}` };
    }
  });
}

module.exports = { batchQuote };
