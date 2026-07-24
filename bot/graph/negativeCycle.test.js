/**
 * Pure-math tests for the negative-cycle detector, run against a fake
 * in-memory graph object (not the real LiquidityGraph, no network). This
 * follows the same "pure-math logic verified standalone" discipline
 * bot/base-edges/README.md already applies to small-trade-sweep.js: prove
 * the algorithm is correct in isolation before it's ever wired to live
 * Base RPC data.
 *
 * Run: node bot/graph/negativeCycle.test.js
 */

const assert = require("assert");
const { findNegativeCycles } = require("./negativeCycle");

const WETH = "0x4200000000000000000000000000000000000006";
const USDC = "0x0000000000000000000000000000000000a001";
const TOKB = "0x0000000000000000000000000000000000a002";

function fakePool(address, token0, token1, reserve0, reserve1, feeBps = 30) {
  return { address, token0, token1, reserve0: BigInt(reserve0), reserve1: BigInt(reserve1), feeBps, venue: "test" };
}

function fakeGraph(pools) {
  return {
    tokens() {
      const set = new Set();
      for (const p of pools) {
        set.add(p.token0.toLowerCase());
        set.add(p.token1.toLowerCase());
      }
      return Array.from(set);
    },
    allPools() {
      return pools;
    },
  };
}

function test_noProfitableCycleInBalancedMarket() {
  // Fair, internally-consistent prices across all three pools (no fee) —
  // no profitable cycle should be reported once fees are applied (every
  // real hop costs 30bps, so round-tripping through 3 pools always loses
  // money in a perfectly balanced market).
  const pools = [
    fakePool("0xPoolA", WETH, USDC, "1000000000000000000000", "2000000000000"), // 1 WETH = 2000 USDC
    fakePool("0xPoolB", USDC, TOKB, "2000000000000", "1000000000000000000000"), // 1 USDC = 0.5 TOKB
    fakePool("0xPoolC", TOKB, WETH, "1000000000000000000000", "1000000000000000000000"), // 1 TOKB = 1 WETH
  ];
  const graph = fakeGraph(pools);
  const cycles = findNegativeCycles(graph, { startToken: WETH, maxCycleLength: 5 });
  assert.strictEqual(cycles.length, 0, "balanced market with real fees should show no profitable cycle");
  console.log("PASS: test_noProfitableCycleInBalancedMarket");
}

function test_detectsObviousMispricedTriangle() {
  // Deliberately mispriced: round-tripping WETH -> USDC -> TOKB -> WETH
  // nets a large surplus even after fees, simulating a real cross-DEX
  // price discrepancy.
  const pools = [
    fakePool("0xPoolA", WETH, USDC, "1000000000000000000000", "2000000000000"), // 1 WETH = 2000 USDC
    fakePool("0xPoolB", USDC, TOKB, "2000000000000", "1000000000000000000000"), // 1 USDC = 0.5 TOKB
    // Mispriced: 1 TOKB = 1.5 WETH instead of the "fair" 1 TOKB = 1 WETH
    fakePool("0xPoolC", TOKB, WETH, "1000000000000000000000", "1500000000000000000000"),
  ];
  const graph = fakeGraph(pools);
  const cycles = findNegativeCycles(graph, { startToken: WETH, maxCycleLength: 5 });
  assert.ok(cycles.length > 0, "mispriced triangle should be detected as a profitable cycle");
  assert.ok(cycles[0].logProfit > 0, "reported cycle should have positive logProfit");
  assert.strictEqual(cycles[0].tokens[0].toLowerCase(), WETH.toLowerCase(), "cycle should start at WETH");
  assert.strictEqual(
    cycles[0].tokens[cycles[0].tokens.length - 1].toLowerCase(),
    WETH.toLowerCase(),
    "cycle should close back to WETH"
  );
  console.log("PASS: test_detectsObviousMispricedTriangle");
}

function test_throwsWithoutStartToken() {
  const pools = [fakePool("0xPoolA", WETH, USDC, "1000000000000000000000", "2000000000000")];
  const graph = fakeGraph(pools);
  assert.throws(() => findNegativeCycles(graph, {}), /requires opts.startToken/);
  console.log("PASS: test_throwsWithoutStartToken");
}

function test_respectsMaxCycleLength() {
  // A 4-hop profitable cycle should be excluded when maxCycleLength is 3.
  const TOKC = "0x0000000000000000000000000000000000a003";
  const pools = [
    fakePool("0xPoolA", WETH, USDC, "1000000000000000000000", "2000000000000"),
    fakePool("0xPoolB", USDC, TOKB, "2000000000000", "1000000000000000000000"),
    fakePool("0xPoolC", TOKB, TOKC, "1000000000000000000000", "1000000000000000000000"),
    // Mispriced final leg back to WETH
    fakePool("0xPoolD", TOKC, WETH, "1000000000000000000000", "1500000000000000000000"),
  ];
  const graph = fakeGraph(pools);
  const cyclesShort = findNegativeCycles(graph, { startToken: WETH, maxCycleLength: 3 });
  const cyclesLong = findNegativeCycles(graph, { startToken: WETH, maxCycleLength: 5 });
  assert.strictEqual(cyclesShort.length, 0, "4-hop cycle should be excluded when maxCycleLength=3");
  assert.ok(cyclesLong.length > 0, "same 4-hop cycle should be found when maxCycleLength=5");
  console.log("PASS: test_respectsMaxCycleLength");
}

function main() {
  test_noProfitableCycleInBalancedMarket();
  test_detectsObviousMispricedTriangle();
  test_throwsWithoutStartToken();
  test_respectsMaxCycleLength();
  console.log("\nAll negativeCycle tests passed.");
}

main();
