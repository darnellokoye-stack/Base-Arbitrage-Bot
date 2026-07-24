// Synthetic end-to-end smoke test: builds a fake publicClient with
// in-memory data standing in for a real Base RPC, then runs the same
// discoverPools -> fetchReserveHistory -> replay pipeline the real CLI
// scripts use. This can't validate the REAL formulas match Base's actual
// deployed contracts (that needs a real RPC), but it does validate every
// module's wiring, shapes, and edge-case handling work together, which is
// what's actually testable without network access.
const assert = require("assert");
const { discoverPools } = require("../lib/discoverPools");
const { fetchReserveHistory } = require("../lib/fetchReserveHistory");
const { bestCandidateAt, middleTokens } = require("../replay");
const { bufferedGasPriceWei } = require("../lib/gasHistory");

const WETH = "0x4200000000000000000000000000000000000006";
const USDC = "0x0000000000000000000000000000000000usdc".padEnd(42, "0");
const TOKA = "0x000000000000000000000000000000000000a1".padEnd(42, "0");
const UNIV2_FACTORY = "0xUniFactory".padEnd(42, "0");
const AERO_FACTORY = "0xAeroFactory".padEnd(42, "0");

const POOL_WETH_USDC_UNIV2 = "0xPoolWethUsdcUniv2".padEnd(42, "0");
const POOL_USDC_TOKA_UNIV2 = "0xPoolUsdcTokaUniv2".padEnd(42, "0");
const POOL_TOKA_WETH_UNIV2 = "0xPoolTokaWethUniv2".padEnd(42, "0");

function sortTokens(a, b) {
  return a.toLowerCase() < b.toLowerCase() ? [a, b] : [b, a];
}

// Fake publicClient covering exactly the methods discoverPools.js and
// fetchReserveHistory.js call.
function makeFakePublicClient() {
  const pairFor = {};
  function keyOf(a, b) {
    const [x, y] = sortTokens(a, b);
    return `${x.toLowerCase()}|${y.toLowerCase()}`;
  }
  pairFor[keyOf(WETH, USDC)] = POOL_WETH_USDC_UNIV2;
  pairFor[keyOf(USDC, TOKA)] = POOL_USDC_TOKA_UNIV2;
  pairFor[keyOf(TOKA, WETH)] = POOL_TOKA_WETH_UNIV2;

  const poolTokens = {
    [POOL_WETH_USDC_UNIV2.toLowerCase()]: sortTokens(WETH, USDC),
    [POOL_USDC_TOKA_UNIV2.toLowerCase()]: sortTokens(USDC, TOKA),
    [POOL_TOKA_WETH_UNIV2.toLowerCase()]: sortTokens(TOKA, WETH),
  };

  // Synthetic Sync history per pool: two updates each.
  const syncHistory = {
    [POOL_WETH_USDC_UNIV2.toLowerCase()]: [
      { blockNumber: 100n, reserve0: 10_000_000000000000000000n, reserve1: 30_000_000000n }, // arbitrary units
      { blockNumber: 150n, reserve0: 9_500_000000000000000000n, reserve1: 31_000_000000n },
    ],
    [POOL_USDC_TOKA_UNIV2.toLowerCase()]: [
      { blockNumber: 100n, reserve0: 20_000_000000n, reserve1: 20_000_000000000000000000n },
    ],
    [POOL_TOKA_WETH_UNIV2.toLowerCase()]: [
      { blockNumber: 100n, reserve0: 20_000_000000000000000000n, reserve1: 12_000_000000000000000000n },
    ],
  };

  return {
    async getBytecode({ address }) {
      return poolTokens[address.toLowerCase()] ? "0xabc123" : "0x";
    },
    async readContract({ address, functionName, args }) {
      if (functionName === "getPair") {
        const [a, b] = args;
        return pairFor[keyOf(a, b)] || "0x0000000000000000000000000000000000000000";
      }
      if (functionName === "getPool") {
        return "0x0000000000000000000000000000000000000000"; // no Aerodrome pools in this synthetic universe
      }
      if (functionName === "token0") return poolTokens[address.toLowerCase()][0];
      if (functionName === "token1") return poolTokens[address.toLowerCase()][1];
      if (functionName === "getReserves") {
        const hist = syncHistory[address.toLowerCase()];
        const first = hist[0];
        return [first.reserve0, first.reserve1, 0];
      }
      throw new Error(`unexpected readContract call: ${functionName}`);
    },
    async getLogs({ address, fromBlock, toBlock }) {
      const addrs = (Array.isArray(address) ? address : [address]).map((a) => a.toLowerCase());
      const logs = [];
      for (const addr of addrs) {
        for (const entry of syncHistory[addr] || []) {
          if (entry.blockNumber >= fromBlock && entry.blockNumber <= toBlock) {
            logs.push({ address: addr, blockNumber: entry.blockNumber, args: { reserve0: entry.reserve0, reserve1: entry.reserve1 } });
          }
        }
      }
      return logs;
    },
    async getBlock({ blockNumber }) {
      return { number: blockNumber ?? 999n, timestamp: BigInt(1000 + Number(blockNumber ?? 0n) * 2), baseFeePerGas: 1_000_000_000n };
    },
  };
}

const cfg = {
  tokens: { WETH, USDC },
  triangleTokens: [TOKA],
  dexes: { uniswapV2Factory: UNIV2_FACTORY, aerodromeFactory: AERO_FACTORY },
  slippageBps: 50n,
  gasPriceBufferBps: 2000n,
  amountInWei: 10n ** 17n,
  backtest: { logChunkBlocks: 100, assumedPriorityFeeGwei: 0.05 },
};

async function run() {
  const client = makeFakePublicClient();

  const pools = await discoverPools(client, cfg);
  assert.strictEqual(pools.length, 3, `expected 3 pools discovered, got ${pools.length}`);
  console.log(`PASS discoverPools found ${pools.length} pools`);

  const poolsWithHistory = await fetchReserveHistory(client, pools, 100n, 200n, cfg);
  const weth_usdc = poolsWithHistory.find((p) => p.address.toLowerCase() === POOL_WETH_USDC_UNIV2.toLowerCase());
  // 3, not 2: fetchReserveHistory seeds a getReserves() call at fromBlock
  // in addition to the 2 real Sync events, so pools with no activity
  // right at the window start still have a usable starting reserve.
  assert.strictEqual(weth_usdc.updates.length, 3, `expected 3 reserve updates (1 seed + 2 Sync events) for WETH/USDC pool, got ${weth_usdc.updates.length}`);
  console.log(`PASS fetchReserveHistory reconstructed ${weth_usdc.updates.length} updates for WETH/USDC pool`);

  const tokens = middleTokens(cfg);
  assert.deepStrictEqual(new Set(tokens), new Set([USDC.toLowerCase(), TOKA.toLowerCase()]), "middleTokens should include USDC and the triangle token, excluding WETH");
  console.log("PASS middleTokens excludes WETH, includes USDC + triangle token");

  const best = bestCandidateAt(poolsWithHistory, tokens, cfg.amountInWei, 150n, WETH.toLowerCase());
  assert.ok(best, "expected a candidate route to be found at block 150");
  assert.ok(best.amountOut > 0n, "expected a positive amountOut");
  console.log(`PASS bestCandidateAt found a route: ${best.route} amountOut=${best.amountOut}`);

  // Before the pool even existed (block 50) -> no candidate should be found
  const none = bestCandidateAt(poolsWithHistory, tokens, cfg.amountInWei, 50n, WETH.toLowerCase());
  assert.strictEqual(none, null, "expected no candidate before any pool had reserves");
  console.log("PASS bestCandidateAt returns null before pools existed");

  const gasPrice = bufferedGasPriceWei(1_000_000_000n, cfg);
  assert.ok(gasPrice > 1_000_000_000n, "buffered gas price should exceed raw base fee");
  console.log(`PASS bufferedGasPriceWei applies buffer (base=1000000000, buffered=${gasPrice})`);

  console.log("\nAll integration smoke tests passed.");
}

run().catch((err) => {
  console.error("INTEGRATION SMOKE TEST FAILED:", err);
  process.exit(1);
});
