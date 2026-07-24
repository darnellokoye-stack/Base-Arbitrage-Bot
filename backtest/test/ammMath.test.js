const assert = require("assert");
const { quoteConstantProduct, quoteThroughPool } = require("../lib/ammMath");

// Known-answer test: 1000 in, 1,000,000/1,000,000 reserves, 30bps fee.
// amountInWithFee = 1000 * 9970 = 9,970,000
// numerator = 9,970,000 * 1,000,000 = 9,970,000,000,000
// denominator = 1,000,000*10000 + 9,970,000 = 10,009,970,000
// result = 996 (integer division)
{
  const out = quoteConstantProduct(1000n, 1_000_000n, 1_000_000n, 30);
  assert.strictEqual(out, 996n, `expected 996, got ${out}`);
  console.log("PASS quoteConstantProduct known-answer");
}

// Zero reserves -> 0, no throw, no division by zero
{
  assert.strictEqual(quoteConstantProduct(1000n, 0n, 1_000_000n, 30), 0n);
  assert.strictEqual(quoteConstantProduct(1000n, 1_000_000n, 0n, 30), 0n);
  console.log("PASS quoteConstantProduct zero-reserve guards");
}

// quoteThroughPool must respect token0/token1 ordering either direction
{
  const pool = { address: "0xPool", token0: "0xAAA", token1: "0xBBB", reserve0: 1_000_000n, reserve1: 2_000_000n, feeBps: 30 };
  const forward = quoteThroughPool(pool, "0xaaa", "0xbbb", 1000n); // tokenIn=token0
  const reverse = quoteThroughPool(pool, "0xbbb", "0xaaa", 1000n); // tokenIn=token1
  assert.ok(forward > 0n && reverse > 0n);
  assert.notStrictEqual(forward, reverse, "quoting in opposite directions through an asymmetric pool should give different outputs");
  console.log(`PASS quoteThroughPool direction-awareness (forward=${forward}, reverse=${reverse})`);
}

// quoteThroughPool must throw on a token pair the pool doesn't contain
{
  const pool = { address: "0xPool", token0: "0xAAA", token1: "0xBBB", reserve0: 1_000_000n, reserve1: 2_000_000n, feeBps: 30 };
  assert.throws(() => quoteThroughPool(pool, "0xAAA", "0xCCC", 1000n));
  console.log("PASS quoteThroughPool rejects unknown token pair");
}

console.log("\nAll ammMath tests passed.");
