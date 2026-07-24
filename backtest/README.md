# Backtesting the triangle-arb scanner

`bot/scanner.js` is a live, RPC-driven scanner — it has no historical replay
built in. This directory adds one: it reconstructs Uniswap V2 and
Aerodrome-volatile pool reserves over a past window from on-chain event
logs, then replays the scanner's exact route-enumeration and gas-aware
profit math against that reconstructed history instead of live
`getAmountsOut()` calls.

**This is a simulation of "would there have been a profitable window,"
not a guarantee the live bot would have captured it or earned this money.**
See "What this does NOT model" below before trusting any number it prints.

## What it does

1. `node backtest/fetch-data.js` — discovers the same pools
   `bot/graph-scanner.js` would (Uniswap V2 pairs + Aerodrome **volatile**
   pools only — see "Aerodrome stable pools" below), resolves your
   requested date range to a block range, fetches every `Sync` event for
   those pools in that range (reconstructing reserves-over-time), and
   fetches `baseFeePerGas` at each sample block. Everything is cached to
   `backtest/cache/`.
2. `node backtest/replay.js` — for each sample block, rebuilds the same
   `WETH -> tokenA -> tokenB -> WETH` candidate set
   `buildRouteCandidates()`/`quoteTrianglePath()` would live, quotes every
   leg with the identical constant-product formula
   (`quoteConstantProduct`), applies the same slippage floor
   (`SLIPPAGE_BPS`) and a gas-aware profit buffer
   (`GAS_PRICE_BUFFER_BPS`), and records the best candidate's net profit
   to `backtest/output/replay.csv`.
3. `node backtest/report.js` — summarizes that CSV: hit rate, total/median/
   max simulated profit, top opportunities.

Or all at once: `npm run backtest:fetch && npm run backtest:run && npm run backtest:report`

## Configuration

Reuses every relevant env var from the main README (`BASE_RPC_URL`,
`BASE_USDC`, `BASE_TRIANGLE_TOKENS`, `AMOUNT_IN_WEI`, `SLIPPAGE_BPS`,
`GAS_PRICE_BUFFER_BPS`, etc.) — the backtest is evaluating the same token
universe and thresholds the live scanner would use, not a separate config.
`FLASH_MODE=1` switches to flash-loan-mode gas/premium assumptions, same
as the live scanner.

Backtest-only additions (all optional, see `backtest/config.js` for full
comments):

| Env var | Default | Meaning |
|---|---|---|
| `BACKTEST_START` | 30 days ago | ISO date, window start |
| `BACKTEST_END` | now | ISO date, window end |
| `BACKTEST_SAMPLE_MINUTES` | 15 | How often to "run the scanner" against reconstructed state |
| `BACKTEST_LOG_CHUNK_BLOCKS` | 5000 | Starting `eth_getLogs` chunk size (auto-halves on range errors) |
| `BACKTEST_GAS_UNITS_PREFUNDED` | 320000 | **Unverified placeholder** — see below |
| `BACKTEST_GAS_UNITS_FLASH` | 480000 | **Unverified placeholder** — see below |
| `BACKTEST_PRIORITY_FEE_GWEI` | 0.05 | Assumed priority fee on top of historical base fee |
| `BACKTEST_FLASH_PREMIUM_BPS` | 5 | **Unverified placeholder** for Aave's flash premium — verify against the real historical value |

## RPC requirements — read this before running a real 30-day backtest

`eth_getLogs` doesn't need "archive" *state* access the way an `eth_call`
at a historical block does, but many free/public RPC endpoints (including
`mainnet.base.org`) still cap the block range per request and rate-limit
aggressively, and some prune log history further back than they'll admit
to. `fetch-data.js` auto-halves its chunk size on anything that looks
like a range error, so it will grind through a slow/limited endpoint, but:

- For a quick smoke test (1-2 days), the public endpoint is probably fine.
- For a real 30-day run, use a provider with real historical log
  retention — Alchemy, QuickNode, Ankr, etc. Set `BASE_RPC_URL` to that
  endpoint.

## What this does NOT model

- **No competition.** This counts every window where the math says
  "profitable," not "profitable AND nobody else's bot got there first."
  On a chain like Base with real MEV activity, treat the raw hit rate and
  profit sum as a ceiling, not an expectation.
- **No execution latency / reserve movement between quote and inclusion.**
  Reserves are read as-of the sample block, as if the trade landed
  instantly at that exact state — the same optimism every naive backtest
  of a latency-sensitive strategy has.
- **Aerodrome stable pools are excluded entirely.** Aerodrome volatile
  pools use the same `x*y=k` curve as Uniswap V2 (confirmed against
  Aerodrome's own `Pool.sol`, per `bot/graph/liquidityGraph.js`'s header
  comment), but stable pools use a different curve
  (`x^3*y + y^3*x = k`, Solidly-style) that nothing in this repo
  implements — not the live scanner's local-quote paths, not this
  backtest. Modeling a stable pool with constant-product math would give
  a confidently wrong number, so it's left out entirely rather than
  guessed at, the same choice `bot/graph-scanner.js` already makes.
- **Gas units are an unverified placeholder**, not a measured value —
  there's no deployed `TriangleArb`/`TriangleArbAaveFlash` contract at any
  historical block to run `estimateContractGas` against. If you have a
  real forge fork-test gas report for `executeTriangle` /
  `executeTriangleFlash`, set `BACKTEST_GAS_UNITS_PREFUNDED` /
  `BACKTEST_GAS_UNITS_FLASH` to that number instead of trusting the
  default.
- **Priority fee is a flat assumption**, not a reconstruction of what
  `publicClient.getGasPrice()` would have returned at that historical
  block — Base's `baseFeePerGas` is exact consensus data, but the
  priority fee actually needed to land a transaction at any given moment
  isn't something this repo replays.
- **Aave flash premium is a constant assumption** (`BACKTEST_FLASH_PREMIUM_BPS`),
  not fetched per-block — verify it against the real historical value for
  your window before trusting flash-mode results.
- Same heuristic gap the live scanner itself documents: this reuses its
  quoting logic as-is, including whatever known simplifications
  `bot/scanner.js`'s own comments already flag (e.g. Aerodrome route
  selection).

## Running the tests

`backtest/test/` covers the pure math (constant-product formula,
reserve-timeline carry-forward lookup, block-range binary search) and an
end-to-end synthetic smoke test with a mocked RPC client — none of these
need network access:

```bash
npm run backtest:test
```

This validates the code's wiring and formulas, **not** that the results
of a real run against real Base data are accurate — that depends on your
RPC provider's data and the assumptions above.
