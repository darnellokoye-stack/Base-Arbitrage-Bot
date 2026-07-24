# Base Triangle Arbitrage

Atomic multi-leg swap (A → B → ... → A) across DEX adapters on Base, in
either a pre-funded or flash-loan-funded flavor, plus an off-chain scanner
that watches quotes, computes a live gas-aware profit floor, and fires the
trade when profitable.

**This project was migrated from zkSync Era to Base in full.** The zkSync
Era version (SyncSwap/Mute/SpaceFi adapters, ERC-3156 flash loans against
SyncSwap's Vault, and all the fork-testing history that went with it) is
preserved in `test/_archived-zksync/` — including the original README
(`README-zksync-era.md`) — rather than deleted, since it's a real record of
what was confirmed and how. Nothing in `test/_archived-zksync/` is wired
into the current build.

## What's verified vs. what you must verify yourself

**Confirmed against live, verified Base contracts (via BaseScan and/or the
protocol's own official docs/GitHub) during this migration:**
- Uniswap V2 Router02 on Base: `0x4752bA5DBc23f44D87826276BF6Fd6b1C372AD24`
  — verified contract, 24M+ transactions, confirmed via BaseScan
- Uniswap V2 Factory on Base: `0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6`
  — confirmed via Uniswap's own official docs
  (developers.uniswap.org/docs/protocols/v2/deployments)
- Aerodrome Router: `0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43` — confirmed
  via the deployed contract's own live, verified ABI on BaseScan (3.8M+
  transactions) AND cross-checked against Aerodrome's own GitHub
  (github.com/aerodrome-finance/contracts)
- Aerodrome PoolFactory: `0x420DD381b31aEf6683db6B902084cB0FFECe40Da` —
  same two-source cross-check
- Aave V3 Pool Proxy on Base: `0xA238Dd80C259a72e81d7e4664a9801593F98d1c5`
  — confirmed via BaseScan, verified, 1M+ transactions
- Base's canonical WETH predeploy: `0x4200000000000000000000000000000000000006`

**Fork-tested, but not live-deployed or live-exercised with your own
capital yet:**
- Base fork tests execute real Uniswap V2 and Aerodrome swaps against live
  Base state.
- `TriangleArbAaveFlash` is fork-tested against Aave V3 on Base, including
  a bare WETH flash-loan probe and a flash-loan-backed leg chain. Foundry is
  pinned to `evm_version = "cancun"` because Aave's current Base
  implementation uses opcodes that older fork EVM settings report as
  `NotActivated`.
- No production deployment from this repo has been funded and sent by the
  bot yet. Treat fork success as integration proof, not proof that a live
  opportunity is profitable or safe to submit publicly.
- `AerodromeAdapter`'s stable-vs-volatile route selection
  (`quoteAerodrome` in `bot/scanner.js`) is a documented heuristic (try
  volatile, fall back to stable), not a "best route" guarantee — a thorough
  version would quote both and take the better one.
- USDC address on Base is deliberately left unset (`BASE_USDC` env var,
  no default) — verify it yourself on BaseScan/Circle's docs before use,
  the same discipline this project applied to zkSync's USDT address.

## Architecture

- `contracts/TriangleArbBase.sol` — shared owner/allowlist/leg-execution
  logic, chain-agnostic, unchanged from the zkSync version
- `contracts/TriangleArb.sol` — pre-funded variant, chain-agnostic,
  unchanged
- `contracts/TriangleArbAaveFlash.sol` — flash-loan-funded variant,
  **new**, replaces the old SyncSwap/ERC-3156-based `TriangleArbFlash.sol`
  because Aave V3's flash loan interface is NOT ERC-3156 (different
  function names, different callback signature — see
  `contracts/interfaces/IAaveV3Flash.sol` for specifics)
- `contracts/adapters/UniswapV2Adapter.sol` — unchanged, works against
  Base's Uniswap V2 fork since it's genuinely UniV2-shaped
- `contracts/adapters/AerodromeAdapter.sol` — **new**, required because
  Aerodrome's Router takes a `Route[]` struct (from/to/stable/factory),
  not a plain `address[]` path, despite being a UniV2-derived DEX
- `bot/config.js` / `bot/scanner.js` — fully rewritten for Base (see
  inline comments for what changed and why)
- `bot/base-edges/` — the solo-dev "edges" work (new-pool discovery,
  small-trade sweeping); see `bot/base-edges/README.md` for status

## Deploying

Prep-only — this repo does not deploy on your behalf. See
`contracts/scripts/deploy-base.md` for the full checklist, including the
on-chain re-verification step you should run before trusting any address
in this README with real capital.

## Running the scanner

```bash
npm install
BASE_USDC=0x...                  # verify first, see above
BASE_TRIANGLE_ARB=0x...          # from deployment
BASE_UNIV2_ADAPTER=0x...
BASE_AERODROME_ADAPTER=0x...
PRIVATE_KEY=0x...                # omit to dry-run only
OWNER_ADDRESS=0x...              # required for dry-run gas/simulation if PRIVATE_KEY is omitted
SLIPPAGE_BPS=50                  # optional, per-leg output floor buffer; default 0.50%
BASE_TRIANGLE_TOKENS=0x...,0x... # extra middle-token universe for WETH -> A -> B -> WETH routes
MAX_ROUTE_CANDIDATES=50          # max quoted candidates evaluated per scan cycle
npm run scan                     # pre-funded mode
npm run scan:flash               # Aave V3 flash-loan mode
```

In flash mode, the scanner now reads Aave's live
`FLASHLOAN_PREMIUM_TOTAL()`, subtracts the flash premium from quote P&L,
adds the gas-aware profit floor, applies per-leg slippage floors to the
exact calldata, and runs an `eth_call` simulation before any transaction is
submitted. If the exact calldata cannot clear the contract's
`minProfit` guard, it is skipped.

The scanner generates real 3-hop candidate cycles:
`WETH -> tokenA -> tokenB -> WETH`. `BASE_USDC` is included automatically;
add at least one more verified token address in `BASE_TRIANGLE_TOKENS` for
real triangles. Each hop is quoted against both Uniswap V2 and Aerodrome,
then the best candidates are gas/simulation checked.

Backrun monitoring is dry-run only:

```bash
BASE_WS_RPC_URL=wss://...
npm run backrun:watch
```

It decodes pending swaps against the configured Uniswap V2 and Aerodrome
routers and reports impacted paths. It does not submit transactions. Real
backrunning should be wired to private bundle/post-victim simulation first;
public mempool submission is not a production-safe path.

## The solo-dev edges (Base-specific angle, separate from the core
migration above)

1. New-pool listener — built, discovery-only (see `bot/base-edges/`)
2. Small-trade size sweep — built, quote/math verified, execution still a
   dry-run stub pending real gas estimates from a deployed contract
3. Private submission via a Base builder/relay — plumbing built
   (`bot/execution/privateSubmit.js`: signed-tx-to-relay submission +
   `eth_callBundle` simulation, public-mempool fallback), but NOT wired
   into the default `submit()` broadcast path — see that module's header
   and `bot/scanner.js`'s `submit()` comment for why swapping it in isn't
   a drop-in change. Requires `BASE_PRIVATE_RELAY_URL` set to a relay
   endpoint you've independently verified; unset means disabled.
4. Non-obvious token triangles — not started
5. Backrunning — not started

See `bot/base-edges/README.md` for the honest per-edge status.

## Graph-based scanner (`bot/graph-scanner.js`) — additive, side-by-side, not a replacement

Three pieces, all with standalone verification status noted individually
— this project's own established standard (see "what's verified vs. what
you must verify yourself" above) applies here too:

- **`bot/graph/multicallQuoter.js`** — batches `getAmountsOut` calls (both
  venues) into one `eth_call` via the canonical Multicall3 deployment
  (same address on Base as on every other EVM chain — re-verify on
  BaseScan before trusting it, per this repo's standard). **Not yet run
  against live Base RPC in this sandbox — no network egress here.**
- **`bot/graph/liquidityGraph.js`** — event-driven reserve cache (watches
  each tracked pool's `Sync` events over a WebSocket subscription instead
  of an RPC call per quote), with a documented, configurable
  confirmation-depth window for reorg safety and a staleness fallback if
  events stop arriving. **Not yet run against live Base RPC in this
  sandbox — no network egress here.** The pool-address bootstrap step
  (`bootstrapGraph()` in `graph-scanner.js`) is an explicit, logged TODO:
  it does NOT yet call `UniswapV2Factory.getPair()` /
  Aerodrome `PoolFactory.getPool()` to discover real pool addresses —
  wire that in (and verify the returned addresses) before running this
  for real, rather than assuming it already works.
- **`bot/graph/negativeCycle.js`** — Bellman-Ford negative-cycle
  detection over the graph, generalizing the existing scanner's
  fixed-3-hop cross-product to cycles of any length (capped at 5 hops by
  default, tunable). **Pure-math logic verified standalone** — see
  `bot/graph/negativeCycle.test.js` (`npm run test:graph`), which
  includes a regression test for a real bug this review caught (cycles
  weren't being rotated to start at the required start token before the
  fix). This module only proves a cycle is profitable at marginal
  (near-zero) trade size against a graph snapshot — it is exactly as
  fresh as the graph feeding it, and it does NOT replace the mandatory
  final `eth_call` simulation before submission.

**`bot/graph-scanner.js` wires these three together but stops at an
explicit, logged hand-off point**: it finds candidate cycles and prints
them, but does not yet re-quote them at the real trade size, build
`Leg[]` calldata, or call the existing `gasCostInStartToken` /
`simulateExecution` / `submit` path from `bot/scanner.js`. That wiring is
the next slice — intentionally left as a TODO rather than guessed at, so
nothing here can reach `submit()` in an unfinished state. **No production
deployment has used this path.** Treat it as scaffolding proven correct
in isolation, not as a working end-to-end scanner yet.

> **Note:** the paragraph above and `bootstrapGraph()`'s "explicit, logged
> TODO" description two paragraphs up describe an earlier snapshot of this
> codebase. As of this revision `bootstrapGraph()` is fully implemented
> (real `getPair()`/`getPool()` calls, bytecode verification, reserve
> reads, liquidity floor — see `bootstrapGraph()`'s own comments in
> `bot/graph-scanner.js`), and `graph-scanner.js` DOES call through to the
> shared `evaluateAndMaybeSubmit`/`submit` path. This section is left
> as-is rather than rewritten wholesale here, since bringing the rest of
> this document in line with the current code is a separate documentation
> pass from the Phase 6/7 work below — don't trust this section's
> "not yet"/"TODO" framing without checking the code directly.

## Phase 6 — execution hardening (`bot/execution/`)

- **`circuitBreaker.js`** — daily realized-loss limit, daily gas-spend
  budget, and a consecutive-failure trip, all independent of each other.
  Halts `submit()` (checked at the top of every submission attempt) until
  manually `reset()` with a reason. In-memory only; resets on UTC day
  roll, not on process restart.
- **`nonceManager.js`** — local nonce tracking layered in front of the
  chain's own pending-nonce view, so restart-resilience and controlled
  same-nonce replacement both work without racing a possibly-lagging RPC.
- **`gasPricer.js`** — adaptive EIP-1559 fee suggestion (base fee +
  headroom for a few blocks of increase, floor/ceiling guarded), plus
  escalated fees for replacements that satisfy the mempool's minimum
  replace-by-fee bump.
- **`txSubmitter.js`** — ties the three together: checks the circuit
  breaker, reserves a nonce, prices the transaction, broadcasts, and — if
  it doesn't confirm within a configurable number of blocks — replaces it
  with a fee-bumped resubmission at the same nonce, up to a configurable
  number of attempts, recording every real outcome back to the circuit
  breaker.

`bot/scanner.js`'s `submit()` now uses all of this. External callers
(`evaluateAndMaybeSubmit`, and `bot/graph-scanner.js` through it) see no
interface change — same `submit(legs, amountIn, minProfit)` signature,
same shared `txInFlight` single-flight guard.

Config knobs: `DAILY_LOSS_LIMIT_WEI`, `DAILY_GAS_BUDGET_WEI`,
`MAX_CONSECUTIVE_FAILURES`, `PRIORITY_FEE_FLOOR_WEI`,
`MAX_FEE_CEILING_WEI`, `REPLACEMENT_ESCALATION_BPS`,
`BASE_FEE_HEADROOM_BLOCKS`, `CONFIRMATION_TIMEOUT_BLOCKS`,
`MAX_REPLACEMENT_ATTEMPTS` — see `bot/config.js`'s `execution` block for
defaults and reasoning.

**Not yet run against live Base RPC in this sandbox — no network egress
here.** Reviewed for correctness against viem's documented API and this
codebase's existing patterns, but not integration-tested end-to-end.
Fork-test before trusting this with real funds, same standard as
everything else in this README.

## Phase 7 — private submission (`bot/execution/privateSubmit.js`)

Sends an already-signed raw transaction directly to a configured
relay/builder endpoint (`eth_sendPrivateTransaction`-shaped RPC) instead
of the public mempool, with `eth_callBundle` simulation available
beforehand and an automatic, always-on fallback to the public mempool if
the relay is unset, unreachable, or errors. This protects this bot's own
transactions from being seen and reacted to in the public mempool before
they land — it does not bundle with, target, or interact with any other
party's transactions.

**Not wired into `bot/scanner.js`'s default `submit()` path.** Doing so
means giving up Phase 6's replacement-by-fee handling (a private relay
doesn't extend the same replace-by-fee semantics the public mempool
does), which is a real operational tradeoff — see `submit()`'s own
comment in `bot/scanner.js` and this module's header. Use
`submitPreferPrivate()` directly for a private-relay-only submission path
with no replacement retries, until that tradeoff is deliberately resolved
one way or the other.

Config: `BASE_PRIVATE_RELAY_URL` (no default — must be an endpoint you've
independently verified), `PRIVATE_RELAY_SIMULATE` (default on).

**Not yet run against a live relay in this sandbox — no network egress
here, and no relay endpoint has been provided/verified.** The RPC shapes
used (`eth_sendPrivateTransaction`, `eth_callBundle`) match Flashbots'
own documented interface, which most relay/builder services on
OP-stack chains model theirs after, but this has NOT been confirmed
against a specific Base relay's actual API — verify against whichever
relay you configure before relying on it.
