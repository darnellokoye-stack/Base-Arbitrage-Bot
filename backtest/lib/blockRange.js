// Resolves "what block was closest to this timestamp" via binary search.
// getBlockTimestampMs(blockNumber) is injected (rather than this module
// calling publicClient directly) so the search logic itself is testable
// with a synthetic chain and no network access — see test/blockRange.test.js.

async function findBlockAtOrBeforeTimestamp(getBlockTimestampMs, targetMs, { latestBlock, latestTimestampMs, genesisBlock = 0n }) {
  if (targetMs >= latestTimestampMs) return latestBlock;

  let lo = genesisBlock;
  let hi = latestBlock;
  let result = genesisBlock;

  while (lo <= hi) {
    const mid = (lo + hi) / 2n;
    const ts = await getBlockTimestampMs(mid);
    if (ts <= targetMs) {
      result = mid;
      lo = mid + 1n;
    } else {
      hi = mid - 1n;
    }
  }
  return result;
}

// Convenience wrapper around a viem publicClient: fetches the latest
// block once, then binary-searches for startMs/endMs. Memoizes
// getBlockTimestampMs calls within a single resolve() invocation since
// binary search on the same range for start and end would otherwise
// re-fetch overlapping blocks.
async function resolveBlockRange(publicClient, { startMs, endMs }) {
  const latest = await publicClient.getBlock({ blockTag: "latest" });
  const latestBlock = latest.number;
  const latestTimestampMs = Number(latest.timestamp) * 1000;

  const cache = new Map();
  async function getBlockTimestampMs(blockNumber) {
    const key = blockNumber.toString();
    if (cache.has(key)) return cache.get(key);
    const block = await publicClient.getBlock({ blockNumber });
    const ts = Number(block.timestamp) * 1000;
    cache.set(key, ts);
    return ts;
  }

  const startBlock = await findBlockAtOrBeforeTimestamp(getBlockTimestampMs, startMs, { latestBlock, latestTimestampMs });
  const endBlock = await findBlockAtOrBeforeTimestamp(getBlockTimestampMs, endMs, { latestBlock, latestTimestampMs });

  if (endBlock <= startBlock) {
    throw new Error(
      `resolveBlockRange: resolved end block ${endBlock} <= start block ${startBlock} — check BACKTEST_START/BACKTEST_END.`
    );
  }

  return { startBlock, endBlock };
}

module.exports = { findBlockAtOrBeforeTimestamp, resolveBlockRange };
