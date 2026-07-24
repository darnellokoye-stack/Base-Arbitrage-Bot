// A pool's reserve history is a sparse, irregular list of Sync-event
// updates (one per swap/mint/burn), not a value at every block. "What
// were the reserves at block N" means "the most recent Sync update at or
// before block N" — this is a carry-forward / as-of join, implemented as
// binary search since updates arrays are sorted by blockNumber ascending
// and can be large (potentially tens of thousands of entries per pool
// over 30 days for an active pool).

// Returns the index of the last entry with blockNumber <= targetBlock, or
// -1 if every entry is after targetBlock (i.e. the pool didn't exist /
// had no recorded update yet at that point).
function findAsOfIndex(updates, targetBlock) {
  let lo = 0;
  let hi = updates.length - 1;
  let result = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (updates[mid].blockNumber <= targetBlock) {
      result = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return result;
}

// pool: { address, token0, token1, feeBps, venue, updates: [{blockNumber, reserve0, reserve1}, ...] }
// Returns { reserve0, reserve1, asOfBlock } or null if no update exists
// yet at or before targetBlock (pool not yet liquid at that point in
// history — the caller should treat this route as unavailable, exactly
// like the live scanner treats a reverting getAmountsOut call).
function reservesAsOf(pool, targetBlock) {
  const idx = findAsOfIndex(pool.updates, targetBlock);
  if (idx === -1) return null;
  const entry = pool.updates[idx];
  return { reserve0: entry.reserve0, reserve1: entry.reserve1, asOfBlock: entry.blockNumber };
}

module.exports = { findAsOfIndex, reservesAsOf };
