// Reconstructs each pool's reserve-update timeline from historical Sync
// events. Every reserve-changing operation on a UniswapV2 pair or an
// Aerodrome volatile pool ends by emitting Sync(reserve0, reserve1) — see
// bot/graph/liquidityGraph.js's header comment for the confirmed source
// of that claim. Fetching Sync alone (not also Swap/Mint/Burn) is the
// same deliberate choice that module makes, for the same reason: no
// reserve information those other events carry that Sync doesn't already
// give you, post-operation, in one shot.
//
// NOTE ON RPC REQUIREMENTS: eth_getLogs does not need "archive" state
// access the way an eth_call at a historical block does — most full nodes
// retain logs going back further than they retain state — but many free
// public endpoints still cap the block range per call and/or rate-limit
// aggressively. This fetcher starts at cfg.backtest.logChunkBlocks and
// halves the chunk size on any error that looks like a range/size limit,
// with a small delay between requests. If your requests are still
// failing, use a provider with better log retention (Alchemy, QuickNode,
// Ankr, etc.) rather than mainnet.base.org for anything beyond a day or
// two of history.

const fs = require("fs");
const path = require("path");

const UNIV2_SYNC_EVENT = {
  type: "event", name: "Sync",
  inputs: [{ name: "reserve0", type: "uint112", indexed: false }, { name: "reserve1", type: "uint112", indexed: false }],
};
const AERODROME_SYNC_EVENT = {
  type: "event", name: "Sync",
  inputs: [{ name: "reserve0", type: "uint256", indexed: false }, { name: "reserve1", type: "uint256", indexed: false }],
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function looksLikeRangeError(err) {
  const msg = (err.shortMessage || err.message || "").toLowerCase();
  return (
    msg.includes("range") || msg.includes("limit") || msg.includes("too many") ||
    msg.includes("10,000") || msg.includes("block range") || msg.includes("timeout")
  );
}

// Fetches logs for one venue's Sync event across [fromBlock, toBlock] for
// a set of pool addresses, chunked with adaptive backoff. Returns raw
// viem logs (already decoded, since `event` is passed to getLogs).
async function fetchSyncLogsChunked(publicClient, addresses, event, fromBlock, toBlock, startChunk) {
  const logs = [];
  let chunk = BigInt(startChunk);
  let cursor = fromBlock;

  while (cursor <= toBlock) {
    const end = cursor + chunk - 1n > toBlock ? toBlock : cursor + chunk - 1n;
    try {
      const batch = await publicClient.getLogs({
        address: addresses,
        event,
        fromBlock: cursor,
        toBlock: end,
      });
      logs.push(...batch);
      cursor = end + 1n;
      await sleep(50); // light throttle — be a polite citizen to whatever RPC this is
    } catch (err) {
      if (chunk > 50n && looksLikeRangeError(err)) {
        chunk = chunk / 2n;
        console.warn(`fetchReserveHistory: range/limit error, halving chunk to ${chunk} blocks and retrying...`);
        continue;
      }
      throw new Error(`fetchReserveHistory: getLogs failed for blocks ${cursor}-${end}: ${err.shortMessage || err.message}`);
    }
  }
  return logs;
}

// pools: array from discoverPools(). Returns the same pools, each with an
// added `updates` array: [{ blockNumber, reserve0, reserve1 }, ...] sorted
// ascending by blockNumber (log order within a block is preserved as
// returned by getLogs, which is block-then-logIndex order).
async function fetchReserveHistory(publicClient, pools, fromBlock, toBlock, cfg) {
  const univ2Addresses = pools.filter((p) => p.venue === "univ2").map((p) => p.address);
  const aeroAddresses = pools.filter((p) => p.venue === "aerodrome").map((p) => p.address);

  const chunk = cfg.backtest.logChunkBlocks;
  const byPool = new Map(pools.map((p) => [p.address.toLowerCase(), []]));

  if (univ2Addresses.length > 0) {
    console.log(`fetchReserveHistory: fetching Sync logs for ${univ2Addresses.length} Uniswap V2 pool(s)...`);
    const logs = await fetchSyncLogsChunked(publicClient, univ2Addresses, UNIV2_SYNC_EVENT, fromBlock, toBlock, chunk);
    for (const log of logs) {
      byPool.get(log.address.toLowerCase()).push({
        blockNumber: log.blockNumber,
        reserve0: log.args.reserve0,
        reserve1: log.args.reserve1,
      });
    }
  }

  if (aeroAddresses.length > 0) {
    console.log(`fetchReserveHistory: fetching Sync logs for ${aeroAddresses.length} Aerodrome pool(s)...`);
    const logs = await fetchSyncLogsChunked(publicClient, aeroAddresses, AERODROME_SYNC_EVENT, fromBlock, toBlock, chunk);
    for (const log of logs) {
      byPool.get(log.address.toLowerCase()).push({
        blockNumber: log.blockNumber,
        reserve0: log.args.reserve0,
        reserve1: log.args.reserve1,
      });
    }
  }

  // Seed each pool's pre-window reserves with a single getReserves() call
  // at fromBlock, so a pool that had zero Sync events during the window
  // (quiet pool) still has a usable starting reserve rather than being
  // treated as nonexistent for the whole backtest.
  const PAIR_READ_ABI = [{ name: "getReserves", type: "function", stateMutability: "view", inputs: [], outputs: [
    { name: "reserve0", type: "uint112" }, { name: "reserve1", type: "uint112" }, { name: "blockTimestampLast", type: "uint32" },
  ] }];
  for (const pool of pools) {
    try {
      const [reserve0, reserve1] = await publicClient.readContract({
        address: pool.address, abi: PAIR_READ_ABI, functionName: "getReserves", blockNumber: fromBlock,
      });
      byPool.get(pool.address.toLowerCase()).unshift({ blockNumber: fromBlock, reserve0, reserve1 });
    } catch (err) {
      console.warn(`fetchReserveHistory: could not seed starting reserves for ${pool.address} at block ${fromBlock} — pool likely didn't exist yet (${err.shortMessage || err.message}).`);
    }
  }

  return pools.map((pool) => {
    const updates = byPool.get(pool.address.toLowerCase()).sort((a, b) => (a.blockNumber < b.blockNumber ? -1 : a.blockNumber > b.blockNumber ? 1 : 0));
    return { ...pool, updates };
  });
}

function cachePath(cfg, name) {
  return path.join(cfg.backtest.cacheDir, name);
}

function saveToCache(cfg, name, data) {
  fs.mkdirSync(cfg.backtest.cacheDir, { recursive: true });
  fs.writeFileSync(
    cachePath(cfg, name),
    JSON.stringify(data, (_, v) => (typeof v === "bigint" ? `${v.toString()}n` : v)),
  );
}

function loadFromCache(cfg, name) {
  const p = cachePath(cfg, name);
  if (!fs.existsSync(p)) return null;
  const raw = fs.readFileSync(p, "utf8");
  return JSON.parse(raw, (_, v) => (typeof v === "string" && /^\d+n$/.test(v) ? BigInt(v.slice(0, -1)) : v));
}

module.exports = { fetchReserveHistory, saveToCache, loadFromCache };
