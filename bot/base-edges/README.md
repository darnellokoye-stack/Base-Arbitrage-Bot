# Base edges — Edge #1: new-pool listener

Status: **discovery layer only, does not trade yet.** Built as the first of
five planned solo-dev edges for running this project's arb logic on Base
instead of zkSync Era (see parent repo's README/scanner.js for the
core triangle-arb + gas-aware-minProfit + adapter-allowlist logic this
is meant to feed into, not replace).

## What's real vs. still needed

**Verified / real:**
- `bot/base-edges/config.js` → `factories.uniswapV2` is Base's official
  Uniswap V2 Factory address, sourced directly from Uniswap's own docs
  (developers.uniswap.org/docs/protocols/v2/deployments). Not yet
  independently re-verified on-chain by this project (no live `cast call`
  against it) — do that before trusting it with real capital, per this
  repo's own established verification standard (see main README's "Fork
  test findings" for why that step matters).
- `PairCreated` event shape — standard, stable UniswapV2 ABI, unlikely to
  drift.

**Explicitly NOT done, don't assume otherwise:**
- **Aerodrome** (Base's largest DEX by TVL, ~50% of Base DEX liquidity per
  public reporting) is NOT covered. It's a Solidly-style ve(3,3) factory
  with a different pool-creation event and lookup ABI than plain
  UniswapV2Factory. `config.js` leaves `aerodromeFactory` blank on purpose
  — fill it in only after independently verifying the address and ABI the
  same way this project verified SyncSwap/Mute/SpaceFi on zkSync Era (see
  main README). Guessing this from memory or a blog post is exactly the
  mistake that cost real time on the Linea detour (Lynex/ICHI/SushiSwap
  false leads) — don't repeat it here.
- **Execution.** `onFreshPool()` in `new-pool-listener.js` currently just
  logs and tracks discovered pools in memory. Wiring a fresh pool into an
  actual quote → gas-aware-minProfit → executeTriangle call is the next
  slice, deliberately left as a hand-off point rather than guessed at,
  since it depends on a strategy decision (which known token(s) to route
  the new token's proceeds back through) that's yours to make, not a pure
  plumbing question.
- **V3/V4-style concentrated-liquidity pools.** Different event
  (`PoolCreated`), different quoting math entirely. Out of scope for this
  slice.

## Running it

```
BASE_WS_RPC_URL=wss://...   # strongly recommended — see config.js comment
BASE_USDC=0x...              # verify on BaseScan before setting
npm run base:new-pools
```

Without `BASE_WS_RPC_URL` it falls back to HTTP polling, which works but
is materially slower to notice new pools — undermining the entire point
of this module. Get a free-tier WS endpoint (Alchemy, Infura, etc.)
before relying on this for anything real.

## The other edges

1. ~~New-pool listener~~ ✅ `new-pool-listener.js` (discovery + wired into
   edge #2's sweep; trade EXECUTION still pending a deployed Base
   contract)
2. ~~Small-trade size sweep~~ ✅ `small-trade-sweep.js` — sweeps several
   small trade sizes (default 0.01–0.5 WETH) per fresh pool per poll
   cycle, using the same dynamic gas-aware minProfit pattern as parent
   `bot/scanner.js` (live gas price + buffer, vs. a static threshold).
   **Real and tested (pure-math logic verified standalone; not yet run
   against live Base RPC in this sandbox — no network egress here).**
   Two things still genuinely missing, not hidden:
     - **Gas estimate is a placeholder** (`PLACEHOLDER_GAS_UNITS`, a
       guessed 220,000 gas), not a live `estimateContractGas` call,
       because there's no deployed contract yet to estimate against. Swap
       this for a real estimate once a Base contract exists — see the
       TODO in `gasCostInWeth()`.
     - **Execution is a dry-run stub** (`submitCandidate()` just logs).
       No transaction is ever sent by this module.
     - **Third-leg routing is unresolved.** Closing a triangle needs to
       know which router can route a newly-discovered token back to
       WETH, which isn't derivable from the `PairCreated` event alone.
       Currently passed as `null`/an env var — real automatic third-leg
       discovery (e.g. checking which known routers have a pool for the
       new token) is a further TODO, not yet built.
3. Private submission via a real Base builder/relay endpoint — NOT
   started. Needs a real, currently-live Base-specific private-orderflow
   endpoint identified and verified before writing any code against it —
   do not fabricate or guess an endpoint URL/API shape here.
4. Non-obvious token triangles — a data/config exercise once pool
   discovery (edge #1) and third-leg routing (edge #2's open TODO) are
   both resolved; no separate plumbing needed beyond what's already here.
5. Backrunning logic — the largest lift: needs pending-tx visibility
   (mempool subscription) and same-block-inclusion timing logic, which is
   architecturally different from anything in this repo so far.
