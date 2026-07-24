const assert = require("assert");
const { findAsOfIndex, reservesAsOf } = require("../lib/reserveTimeline");

const updates = [
  { blockNumber: 100n, reserve0: 1n, reserve1: 10n },
  { blockNumber: 200n, reserve0: 2n, reserve1: 20n },
  { blockNumber: 300n, reserve0: 3n, reserve1: 30n },
];

// Before any update -> not available
assert.strictEqual(findAsOfIndex(updates, 50n), -1);
console.log("PASS findAsOfIndex before-first-update returns -1");

// Exactly at an update
assert.strictEqual(findAsOfIndex(updates, 200n), 1);
console.log("PASS findAsOfIndex exact-match");

// Between updates -> carries forward the earlier one
assert.strictEqual(findAsOfIndex(updates, 250n), 1);
console.log("PASS findAsOfIndex carry-forward between updates");

// After the last update -> the last one
assert.strictEqual(findAsOfIndex(updates, 999n), 2);
console.log("PASS findAsOfIndex after-last-update");

// reservesAsOf wraps this correctly
{
  const pool = { updates };
  const r = reservesAsOf(pool, 250n);
  assert.strictEqual(r.reserve0, 2n);
  assert.strictEqual(r.reserve1, 20n);
  assert.strictEqual(r.asOfBlock, 200n);
  assert.strictEqual(reservesAsOf(pool, 50n), null);
  console.log("PASS reservesAsOf");
}

console.log("\nAll reserveTimeline tests passed.");
