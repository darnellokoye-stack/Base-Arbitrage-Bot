const assert = require("assert");
const { findBlockAtOrBeforeTimestamp } = require("../lib/blockRange");

// Synthetic chain: block N has timestamp N * 2000ms (2s block time), blocks 0..999999
const BLOCK_TIME_MS = 2000;
const LATEST_BLOCK = 999_999n;
const LATEST_TS = Number(LATEST_BLOCK) * BLOCK_TIME_MS;

async function getBlockTimestampMs(blockNumber) {
  return Number(blockNumber) * BLOCK_TIME_MS;
}

async function run() {
  // Exact match
  {
    const target = 500_000 * BLOCK_TIME_MS;
    const block = await findBlockAtOrBeforeTimestamp(getBlockTimestampMs, target, { latestBlock: LATEST_BLOCK, latestTimestampMs: LATEST_TS });
    assert.strictEqual(block, 500_000n, `expected 500000, got ${block}`);
    console.log("PASS exact timestamp match");
  }

  // Between two blocks -> rounds down (last block AT OR BEFORE target)
  {
    const target = 500_000 * BLOCK_TIME_MS + 999; // just short of block 500001
    const block = await findBlockAtOrBeforeTimestamp(getBlockTimestampMs, target, { latestBlock: LATEST_BLOCK, latestTimestampMs: LATEST_TS });
    assert.strictEqual(block, 500_000n);
    console.log("PASS rounds down between blocks");
  }

  // Target at/after latest -> latest block, no search needed
  {
    const block = await findBlockAtOrBeforeTimestamp(getBlockTimestampMs, LATEST_TS + 999999, { latestBlock: LATEST_BLOCK, latestTimestampMs: LATEST_TS });
    assert.strictEqual(block, LATEST_BLOCK);
    console.log("PASS target after latest returns latest block");
  }

  // Target before genesis -> genesis block
  {
    const block = await findBlockAtOrBeforeTimestamp(getBlockTimestampMs, -1000, { latestBlock: LATEST_BLOCK, latestTimestampMs: LATEST_TS, genesisBlock: 0n });
    assert.strictEqual(block, 0n);
    console.log("PASS target before genesis returns genesis block");
  }

  console.log("\nAll blockRange tests passed.");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
