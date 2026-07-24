/**
 * Backtest step 1: fetch and cache everything the replay needs.
 *
 * Run: node backtest/fetch-data.js
 *
 * Requires the same env vars as the live scanner (BASE_RPC_URL,
 * BASE_USDC, BASE_TRIANGLE_TOKENS, etc. — see main README) plus, if you
 * want a non-default window, BACKTEST_START / BACKTEST_END (ISO dates)
 * and BACKTEST_SAMPLE_MINUTES. See backtest/README.md for the full list.
 *
 * IMPORTANT: BASE_RPC_URL should point at a provider with good log
 * retention for the window you're asking for — see fetchReserveHistory.js's
 * header comment. mainnet.base.org is fine for a quick 1-2 day smoke test,
 * not recommended for a full 30-day run.
 */
require("dotenv").config();
const { createPublicClient, http } = require("viem");
const { base } = require("viem/chains");
const cfg = require("./config");
const { discoverPools } = require("./lib/discoverPools");
const { resolveBlockRange } = require("./lib/blockRange");
const { fetchReserveHistory, saveToCache, loadFromCache } = require("./lib/fetchReserveHistory");
const { getBaseFeePerGas } = require("./lib/gasHistory");
const { sleep, withRateLimitRetry } = require("./lib/rpcRetry");

const publicClient = createPublicClient({ chain: base, transport: http(cfg.RPC_URL) });

async function main() {
  console.log(`Backtest window: ${new Date(cfg.backtest.startMs).toISOString()} -> ${new Date(cfg.backtest.endMs).toISOString()}`);

  console.log("\n[1/4] Discovering pools for the configured token universe...");
  const pools = await discoverPools(publicClient, cfg);
  if (pools.length === 0) {
    console.error("No pools found. Check BASE_USDC / BASE_TRIANGLE_TOKENS and the dex factory addresses in bot/config.js.");
    process.exit(1);
  }
  console.log(`Found ${pools.length} pool(s):`);
  for (const p of pools) console.log(`  [${p.venue}] ${p.address} (${p.token0} / ${p.token1}, feeBps=${p.feeBps})`);

  console.log("\n[2/4] Resolving block range for the requested time window...");
  const { startBlock, endBlock } = await resolveBlockRange(publicClient, { startMs: cfg.backtest.startMs, endMs: cfg.backtest.endMs });
  console.log(`Block range: ${startBlock} -> ${endBlock} (${endBlock - startBlock} blocks)`);

  console.log("\n[3/4] Fetching reserve history (Sync events)...");
  const poolsWithHistory = await fetchReserveHistory(publicClient, pools, startBlock, endBlock, cfg);
  for (const p of poolsWithHistory) console.log(`  [${p.venue}] ${p.address}: ${p.updates.length} reserve update(s)`);

  console.log("\n[4/4] Fetching gas history for each sample block...");
  const sampleIntervalMs = cfg.backtest.sampleIntervalMinutes * 60 * 1000;
  const sampleIntervalBlocks = BigInt(Math.max(1, Math.round(sampleIntervalMs / cfg.backtest.approxBlockTimeMs)));

  // Resumable: if a prior run of this exact block range/interval got
  // partway through and died (e.g. rate-limited — see rpcRetry.js), pick
  // up from the last cached sample instead of re-fetching everything.
  // A mismatched startBlock/endBlock/interval (different backtest window)
  // invalidates the old cache rather than silently mixing samples.
  const priorMeta = loadFromCache(cfg, "meta.json");
  const priorSamples = loadFromCache(cfg, "samples.json");
  const canResume =
    priorMeta && priorSamples &&
    priorMeta.startBlock === startBlock && priorMeta.endBlock === endBlock &&
    priorMeta.sampleIntervalBlocks === sampleIntervalBlocks;

  const samples = canResume ? priorSamples : [];
  let block = canResume && samples.length > 0
    ? samples[samples.length - 1].blockNumber + sampleIntervalBlocks
    : startBlock;
  if (canResume && samples.length > 0) {
    console.log(`  resuming from cached progress: ${samples.length} sample(s) already fetched`);
  }

  let done = samples.length;
  const totalSamples = Number((endBlock - startBlock) / sampleIntervalBlocks) + 1;

  // Public/free RPC endpoints (mainnet.base.org in particular) rate-limit
  // aggressively under sustained load — throttle with a small delay
  // between requests and retry-with-backoff specifically on rate-limit
  // errors (see lib/rpcRetry.js), and checkpoint to cache periodically so
  // a rate-limit death doesn't cost you the progress already made.
  while (block <= endBlock) {
    const [chainBlock, baseFeePerGas] = await withRateLimitRetry(
      () => Promise.all([
        publicClient.getBlock({ blockNumber: block }),
        getBaseFeePerGas(publicClient, block),
      ]),
      { label: `fetch-data: gas history at block ${block}` }
    );
    samples.push({
      blockNumber: block,
      timestampMs: Number(chainBlock.timestamp) * 1000,
      baseFeePerGas,
    });
    done++;
    if (done % 25 === 0 || done === totalSamples) {
      process.stdout.write(`\r  ${done}/${totalSamples} sample blocks fetched`);
      saveToCache(cfg, "samples.json", samples);
      saveToCache(cfg, "meta.json", { startBlock, endBlock, sampleIntervalBlocks, fetchedAt: Date.now() });
    }
    block += sampleIntervalBlocks;
    await sleep(75); // light throttle — same spirit as fetchReserveHistory.js's getLogs pacing
  }
  console.log();

  saveToCache(cfg, "pools.json", poolsWithHistory);
  saveToCache(cfg, "samples.json", samples);
  saveToCache(cfg, "meta.json", { startBlock, endBlock, sampleIntervalBlocks, fetchedAt: Date.now() });

  console.log(`\nCached ${poolsWithHistory.length} pool histories and ${samples.length} gas samples to ${cfg.backtest.cacheDir}`);
  console.log("Next: node backtest/replay.js");
}

main().catch((err) => {
  console.error("fetch-data failed:", err);
  process.exit(1);
});
