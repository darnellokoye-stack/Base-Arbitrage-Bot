// Pool discovery for the backtest — deliberately the same two on-chain
// lookups bot/graph-scanner.js's bootstrapGraph() already does
// (UniswapV2Factory.getPair, Aerodrome PoolFactory.getPool volatile-only),
// duplicated here rather than imported because bootstrapGraph() is
// entangled with that file's live WS-subscription graph object.
//
// AERODROME STABLE POOLS ARE DELIBERATELY EXCLUDED — same reason as
// bot/graph-scanner.js: stable pools use a different curve (Solidly-style
// x^3*y + y^3*x = k) that quoteConstantProduct() does not model. Nothing
// in this repo implements that curve. Modeling a stable pool with
// constant-product math would produce a confidently wrong number rather
// than an honest "unavailable" — so this backtest only ever considers
// Uniswap V2 and Aerodrome-volatile routes, exactly like graph-scanner.js.

const { zeroAddress } = require("viem");
const { sleep, withRateLimitRetry } = require("./rpcRetry");

const UNIV2_FACTORY_ABI = [
  {
    name: "getPair",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "tokenA", type: "address" }, { name: "tokenB", type: "address" }],
    outputs: [{ type: "address" }],
  },
];

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
    inputs: [{ name: "pool", type: "address" }, { name: "stable", type: "bool" }],
    outputs: [{ type: "uint256" }],
  },
];

const PAIR_READ_ABI = [
  { name: "getReserves", type: "function", stateMutability: "view", inputs: [], outputs: [
    { name: "reserve0", type: "uint112" }, { name: "reserve1", type: "uint112" }, { name: "blockTimestampLast", type: "uint32" },
  ] },
  { name: "token0", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { name: "token1", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
];

const UNIV2_FEE_BPS = 30; // standard, bytecode-fixed for every faithful UniV2 fork — same constant graph-scanner.js hardcodes

function tokenUniverse(cfg) {
  const set = new Set();
  set.add(cfg.tokens.WETH.toLowerCase());
  if (cfg.tokens.USDC) set.add(cfg.tokens.USDC.toLowerCase());
  for (const t of cfg.triangleTokens) set.add(t.toLowerCase());
  return Array.from(set);
}

function tokenPairs(tokens) {
  const pairs = [];
  for (let i = 0; i < tokens.length; i++) {
    for (let j = i + 1; j < tokens.length; j++) {
      pairs.push([tokens[i], tokens[j]]);
    }
  }
  return pairs;
}

async function poolHasCode(publicClient, address) {
  const code = await publicClient.getBytecode({ address });
  return !!code && code !== "0x";
}

async function loadPool(publicClient, address, { venue, feeBps }) {
  const hasCode = await poolHasCode(publicClient, address);
  if (!hasCode) return null;
  try {
    const [token0, token1] = await Promise.all([
      publicClient.readContract({ address, abi: PAIR_READ_ABI, functionName: "token0" }),
      publicClient.readContract({ address, abi: PAIR_READ_ABI, functionName: "token1" }),
    ]);
    return { address, venue, feeBps, token0, token1 };
  } catch (err) {
    console.warn(`discoverPools: ${address} has code but rejected token0/token1 — skipping (${err.shortMessage || err.message}).`);
    return null;
  }
}

// Returns an array of pool descriptors: { address, venue, feeBps, token0, token1 }
async function discoverPools(publicClient, cfg) {
  const tokens = tokenUniverse(cfg);
  if (tokens.length < 2) {
    throw new Error("discoverPools: need at least WETH + one more token — set BASE_USDC and/or BASE_TRIANGLE_TOKENS.");
  }

  const pairs = tokenPairs(tokens);
  const pools = [];

  for (const [tokenA, tokenB] of pairs) {
    try {
      const pairAddress = await withRateLimitRetry(
        () => publicClient.readContract({
          address: cfg.dexes.uniswapV2Factory,
          abi: UNIV2_FACTORY_ABI,
          functionName: "getPair",
          args: [tokenA, tokenB],
        }),
        { label: `discoverPools: getPair(${tokenA}, ${tokenB})` }
      );
      if (pairAddress && pairAddress !== zeroAddress) {
        const pool = await loadPool(publicClient, pairAddress, { venue: "univ2", feeBps: UNIV2_FEE_BPS });
        if (pool) pools.push(pool);
      }
    } catch (err) {
      console.warn(`discoverPools: UniswapV2Factory.getPair(${tokenA}, ${tokenB}) failed: ${err.shortMessage || err.message}`);
    }

    await sleep(50); // light throttle — same spirit as fetchReserveHistory.js's getLogs pacing

    try {
      const poolAddress = await withRateLimitRetry(
        () => publicClient.readContract({
          address: cfg.dexes.aerodromeFactory,
          abi: AERODROME_FACTORY_ABI,
          functionName: "getPool",
          args: [tokenA, tokenB, false],
        }),
        { label: `discoverPools: getPool(${tokenA}, ${tokenB})` }
      );
      if (poolAddress && poolAddress !== zeroAddress) {
        const feeBps = await withRateLimitRetry(
          () => publicClient.readContract({
            address: cfg.dexes.aerodromeFactory,
            abi: AERODROME_FACTORY_ABI,
            functionName: "getFee",
            args: [poolAddress, false],
          }),
          { label: `discoverPools: getFee(${poolAddress})` }
        );
        const pool = await loadPool(publicClient, poolAddress, { venue: "aerodrome", feeBps: Number(feeBps) });
        if (pool) pools.push(pool);
      }
    } catch (err) {
      console.warn(`discoverPools: Aerodrome getPool(${tokenA}, ${tokenB}, false) failed: ${err.shortMessage || err.message}`);
    }

    await sleep(50);
  }

  return pools;
}

module.exports = { discoverPools, tokenUniverse, tokenPairs };
