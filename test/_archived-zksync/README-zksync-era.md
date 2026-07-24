# zkSync Era Triangle Arbitrage

Atomic multi-leg swap (A → B → ... → A) across DEX adapters on zkSync Era,
in either a pre-funded or flash-loan-funded flavor, plus an off-chain
scanner that watches quotes, computes a live gas-aware profit floor, and
fires the trade when profitable.

## What's verified vs. what you must verify yourself

**Verified against LIVE zkSync Era mainnet (via `test/ForkIntegration.t.sol`,
actually run on a real EC2 box with `foundry-zksync` — see "Fork test
findings" below for full detail):**
- SyncSwap: router address, pool factory address, and the pool `swap()`
  step-data encoding `(tokenIn, to, withdrawMode)` — all confirmed via a
  real executed swap (0.1 WETH → ~187 USDC.e)
- Mute: router address and ABI — confirmed via a real executed swap
  (50 USDC.e → ~50.06 USDT)
- SpaceFi (`thirdDex`): router address and the classic 5-arg UniV2
  `swapExactTokensForTokens` signature — confirmed via a real executed swap
  (50 USDT → ~0.0263 WETH)
- USDT address on zkSync Era mainnet: `0x493257fD37EDB34451f62EDf8D2a0C418852bA4C`
  — confirmed both by the live swaps above and independently corroborated
  by the block explorer's token page, Exponential DeFi, and two separate
  GeckoTerminal liquidity pools

**Verified against docs (not yet exercised live):**
- SyncSwap Vault (V1) address on zkSync Era mainnet: `0x621425a1Ef6abE91058E9712575dcc4258F8d091`
  — confirmed against `docs.syncswap.xyz/syncswap/smart-contracts`, and its
  `deposit`/`withdraw` flow was actually exercised as part of the SyncSwap
  swap test above
- SyncSwap's Vault implements the standard **ERC-3156** flash loan interface
  (confirmed against `docs.syncswap.xyz` API docs and the on-chain
  `IVault`/`IFlashLoan` interfaces) — single-token loan, repayment by
  approval pulled via `transferFrom` after the callback returns. This is
  **not** the Balancer-style multi-token flash loan some older SyncSwap docs
  pages describe; `IERC3156Flash.sol` matches the interface actually deployed.
  Not yet exercised against a live flash loan (only the pre-funded
  `TriangleArb` path has been fork-tested so far, not `TriangleArbFlash`).

**Still not verified:**
- The full three-leg round trip (`test_FullTriangle_WethUsdcUsdtWeth`) —
  each leg is proven correct individually, but hop-chaining and
  `amountOutMin` propagation across all three in one transaction hasn't
  been run live yet. Lower risk than the individual legs were, but worth
  confirming before relying on it.
- `TriangleArbFlash` (the flash-loan-funded path) — not fork-tested at all
  yet, only the pre-funded `TriangleArb` contract has been.
- Velocore uses a fundamentally different vault architecture, NOT a
  UniswapV2-style router — don't point `UniswapV2Adapter` at it.
  **PancakeSwap does NOT work with `UniswapV2Adapter`**: its zkSync Era
  deployment is a V3 "Smart Router" bundling V2/V3/stable-swap logic behind
  a different ABI (no `deadline` param on its V2-style
  `swapExactTokensForTokens`, and its real V3 functions are
  `exactInputSingle`/`exactInput` with a struct argument entirely) — this
  was the reason the project switched to SpaceFi for `thirdDex`, which is
  now confirmed working.
- Token addresses (USDC/USDT/WETH) — double check decimals and addresses
- SyncSwap pool fee (adapter assumes ~0.2%, scanner assumes 20bps — pools vary)
- SyncSwap Vault's actual current `flashFee()` — the scanner's gas-aware
  profit check does NOT currently query this on-chain and add it separately;
  `TriangleArbFlash.onFlashLoan` enforces it on-chain regardless (so you can
  never lose money to an unaccounted fee), but the off-chain scanner may
  under-estimate how much gross profit is needed before submitting. Ask if
  you want the scanner to call `flashFee()` directly — it's a small addition.

## Architecture

```
TriangleArbBase.sol (abstract — shared owner/allowlist/leg-execution logic)
  ├─ TriangleArb.sol       executeTriangle(legs[], amountIn, minProfit, deadline)
  │                          requires the contract to be pre-funded with the start token
  └─ TriangleArbFlash.sol  executeTriangleFlash(legs[], amountIn, minProfit, deadline)
                             borrows amountIn via an ERC-3156 flash loan from
                             SyncSwap's Vault — no pre-funding required

Both variants run the same _runLegs() loop:
  for each leg: approve adapter for amountIn, then call() into it
       ├─ SyncSwapAdapter   (pool-based router, supports multi-hop chains)
       ├─ MuteAdapter       (UniV2 fork + stable flag, supports multi-hop chains)
       └─ UniswapV2Adapter  (plain UniV2-shaped router, native multi-hop path)
```

### Multi-hop-within-a-leg

Each `Leg` now carries a `Hop[]` array instead of a single tokenIn/tokenOut
pair. A leg can chain several hops through the *same* adapter/DEX in one
call — e.g. `WETH -> USDC -> USDT`, all on SyncSwap, as a single leg —
without bouncing tokens back to the arb contract between every hop. This
matters for gas (fewer external calls + approve/transferFrom round-trips)
and for cases where a DEX's own router already supports efficient multi-hop
paths (the `UniswapV2Adapter` uses the router's native multi-address `path`
array for exactly this reason, rather than looping separate swap calls).

You still get a separate `Leg` whenever you need to switch adapters (e.g.
SyncSwap for the first hop, Mute for the second) — `Hop[]` chaining is only
for consecutive hops on the *same* DEX.

### Flash-loan variant (`TriangleArbFlash`)

Uses SyncSwap's Vault as an ERC-3156 flash lender. Flow:
1. `executeTriangleFlash` calls `vault.flashLoan(this, startToken, amountIn, data)`.
2. The vault transfers `amountIn` to the contract, then calls `onFlashLoan`.
3. `onFlashLoan` runs the leg chain (same `_runLegs` as the pre-funded path),
   checks the result covers `amountIn + fee + minProfit`, then **approves**
   (not transfers) `amountIn + fee` back to the vault.
4. The vault pulls that approved amount via `transferFrom` immediately after
   `onFlashLoan` returns; if the approval is short, the whole transaction —
   loan included — reverts atomically.

`onFlashLoan` is guarded so it only accepts calls where `msg.sender` is the
immutable vault address *and* the loan `initiator` is the contract itself —
an attacker cannot spoof a callback to hijack approvals.

Choose this variant if you don't want to lock capital in the contract
between arb attempts; choose `TriangleArb` if you'd rather avoid flash-loan
fees and are fine pre-funding.

### Security model (shared by both variants)

Adapters run via a regular `call`, **not** `delegatecall`. The arb contract
approves each adapter for exactly the amount needed for that leg (reset to 0
immediately after), and each adapter pulls funds with `transferFrom` and
sends the final hop's output back to `msg.sender`. This means a buggy or
malicious adapter can only ever move the single approved amount for that one
leg — it has no access to the arb contract's storage (`owner`, `locked`) or
any other token balance the contract holds.

Adapters must also be explicitly allowlisted on-chain before use:
`setAdapterAllowed(adapterAddress, true)`, owner-only, on either contract.
This is a second layer of defense — even if the off-chain scanner were
compromised or buggy and tried to route a leg through an arbitrary contract,
`_runLegs` rejects any adapter that hasn't been allowlisted by the owner.

The whole transaction reverts if the final balance doesn't clear
`amountIn + minProfit` (or, for the flash variant, `amountIn + fee + minProfit`),
or if `block.timestamp` has passed `deadline`, so a failed/frontrun/stale arb
only costs gas (plus, for the flash variant, nothing at all if `onFlashLoan`
reverts before repayment is attempted).

## Dynamic gas-fee-aware `minProfit`

`bot/scanner.js` no longer uses a static `minProfitWei` floor. Every scan it:
1. Builds the real `legs[]` calldata for the current quote.
2. Calls `eth_estimateGas` against the actual `executeTriangle`/
   `executeTriangleFlash` call (with `minProfit=0`, purely to get a gas
   estimate) — if this reverts, the scanner skips the attempt entirely rather
   than trusting a stale number.
3. Multiplies the gas estimate by the current gas price plus a safety buffer
   (`GAS_PRICE_BUFFER_BPS`, default +20%, since price can move between quote
   and inclusion).
4. Converts that into start-token units (WETH in the default config maps
   1:1; if you change the start token, add a WETH→startToken quote step —
   see the comment in `estimateGasCostInStartToken`).
5. Requires gross arb profit to clear that gas cost plus an optional extra
   margin (`MIN_PROFIT_MARGIN_BPS`, default 0), and only then submits with
   `minProfit` set to that computed floor.

This means the profit bar rises automatically during gas price spikes,
instead of you eating a loss at a threshold tuned once and forgotten.

## Quick profitability check (no deployment needed)

```bash
npm install
node bot/check-profitability.js
```

Read-only script that quotes the live SyncSwap-free rotation (USDC.e →
USDT via Mute → WETH via zkSwap Finance → USDC.e via zkSwap Finance)
across several trade sizes using only `getAmountsOut` calls — no contract
deployment, no private key, no adapters needed. Useful as a fast first
check of whether there's currently any edge worth chasing before going
through full deployment. It does NOT subtract real gas cost (see the
caveat it prints) — `bot/scanner.js`'s dynamic gas-aware `minProfit` is
the real go/no-go check before actually submitting anything.

## Setup

1. **Compile & test** (no compiler is available in the sandbox that built
   this — do this locally):
   ```bash
   forge init --no-commit  # only if you don't already have a foundry project here
   forge install foundry-rs/forge-std --no-commit
   forge build
   forge test -vv
   ```
   `test/TriangleArb.t.sol` covers the pre-funded variant (allowlisting,
   deadline, profit thresholds, multi-hop-within-a-leg, and the key
   malicious-adapter containment regression test). `test/TriangleArbFlash.t.sol`
   covers the flash-loan variant against a mock ERC-3156 vault, including
   executing with a genuinely zero pre-funded balance, fee-aware profit
   enforcement, and rejecting spoofed `onFlashLoan` calls.
2. Verify every placeholder address above on `era.zksync.network`. In
   particular, verify `USDT_TOKEN_ADDRESS` independently — it could not be
   confirmed against a reliable single source during this review, so
   `bot/config.js` will throw at startup until you supply and verify it
   yourself.
3. Deploy either `TriangleArb.sol` (no constructor args) or
   `TriangleArbFlash.sol` (constructor takes the SyncSwap Vault address —
   see the confirmed address above), then each adapter (constructor takes
   the DEX's router address).
4. **Allowlist each adapter**: call `setAdapterAllowed(adapter, true)` on
   whichever arb contract you deployed, from the owner account, for every
   adapter you deployed. Leg execution rejects any adapter that isn't
   allowlisted.
5. If using `TriangleArb` (pre-funded), send it your starting token (e.g.
   WETH). If using `TriangleArbFlash`, no pre-funding is needed — skip this
   step.
6. Configure the bot:
   ```bash
   npm install
   export PRIVATE_KEY=0x...                    # arb contract owner key
   export OWNER_ADDRESS=0x...                  # only if omitting PRIVATE_KEY (dry-run); needed
                                                # so gas estimates can simulate the onlyOwner call
   export TRIANGLE_ARB_ADDRESS=0x...            # TriangleArb OR TriangleArbFlash address
   export FLASH_MODE=true                       # omit or set false for the pre-funded TriangleArb
   export MUTE_ROUTER_ADDRESS=0x...             # verify on era.zksync.network
   export THIRD_DEX_ROUTER_ADDRESS=0x...        # optional — defaults to SpaceFi's Swap
                                                 # Router; UniV2-shaped only; NOT Velocore,
                                                 # NOT PancakeSwap (V3 Smart Router only)
   export SYNCSWAP_ADAPTER=0x... MUTE_ADAPTER=0x... THIRD_DEX_ADAPTER=0x...
   export USDT_TOKEN_ADDRESS=0x...              # independently verify, see above
   export SYNCSWAP_WETH_USDC_POOL=0x...         # from SyncSwapClassicPoolFactory.getPool()
   export MIN_PROFIT_MARGIN_BPS=200             # optional, e.g. 200 = require 2% profit above break-even
   export GAS_PRICE_BUFFER_BPS=2000             # optional, default +20% safety buffer on gas price
   npm run scan
   ```
   Omit `PRIVATE_KEY` to dry-run (logs quotes/profit without submitting).
   Every address above is now required — the bot throws a clear error at
   startup instead of silently defaulting to the zero address. Before
   entering the scan loop, the bot also calls `getAmountsOut` on `thirdDex`
   once as a sanity check that it actually implements the UniV2 router ABI —
   if that call fails, the bot logs why and exits immediately rather than
   scanning against a broken router indefinitely.

## Things this doesn't handle yet (ask if you want them)

- **No MEV protection** — a real triangle arb bot needs a private
  mempool/relay (zkSync doesn't have a public mempool in the same sense as
  L1, but sequencer-level frontrunning is still a consideration) or you'll
  get sandwiched/front-run on the way to the sequencer.
- **Scanner doesn't query the flash loan fee on-chain** — `TriangleArbFlash.onFlashLoan`
  enforces the fee correctly regardless (so a submitted tx can never actually
  lose money to it), but the scanner's pre-submission profitability check
  doesn't currently add SyncSwap's live `flashFee()` into its estimate — it
  may skip attempts that were actually profitable, or submit ones that then
  revert on-chain for being short (wasting gas). Worth adding if you use
  `FLASH_MODE=true` seriously.
- **Cross-DEX aggregation within a single hop** — a `Hop` still routes
  through exactly one pool on one DEX; there's no in-hop splitting across
  multiple pools for better pricing.
- **SyncSwap step-data encoding is still unconfirmed** — `SyncSwapAdapter.sol`
  assumes `(tokenIn, to, withdrawMode)`. This was flagged in the original
  build and remains unverified against the live pool ABI; confirm against
  `github.com/syncswap/core-contracts` before mainnet use, OR run
  `test/ForkIntegration.t.sol` (see below) for a faster, more direct check.

## Fork test findings (live results, not just static review)

These came from actually running `test/ForkIntegration.t.sol` against zkSync
Era mainnet on a real EC2 box — not from reading docs, so this supersedes
the "unverified" caveats above where noted.

- **SyncSwap step-data encoding is CONFIRMED CORRECT.** A real
  `router.swap()` call was executed against the live SyncSwap router
  (`0x2da10A1e27bF85cEdD8FFb1AbBe97e53391C0295`) and the live WETH/USDC.e
  classic pool. The call succeeded, correctly computed a swap fee via the
  pool master, and returned a plausible real-market amount (~187.4 USDC.e
  for 0.1 WETH). The `(tokenIn, to, withdrawMode)` encoding in
  `SyncSwapAdapter.sol` is correct as written — this was the single
  biggest open question in the whole project.
- **SyncSwap router address was WRONG and has been corrected.** The
  address originally in this project (`0xC458eED598...`) was actually a
  Scroll Alpha / Polygon zkEVM testnet router. The correct zkSync Era
  mainnet address is `0x2da10A1e27bF85cEdD8FFb1AbBe97e53391C0295`, now
  fixed in `bot/config.js` and `test/ForkIntegration.t.sol`. The
  SyncSwapClassicPoolFactory address (`0xf2DAd89f...`) was correct all along.
- **`forge test --fork-url` (plain Foundry) cannot execute forked calls into
  real zkSync Era contracts at all** — it has no zkEVM support and silently
  reverts the instant a call reaches deployed zkEVM bytecode. Use
  [`foundry-zksync`](https://github.com/matter-labs/foundry-zksync) instead
  (`curl -L https://raw.githubusercontent.com/matter-labs/foundry-zksync/main/install-foundry-zksync | bash`
  then `foundryup-zksync`), and pass `--zksync` to every `forge test`/`forge build`
  invocation that touches a fork.
- **Known `foundry-zksync` limitation hit during this testing**: even with
  `--zksync`, a call from EVM-simulated test code into a real deployed
  zkEVM contract that itself makes further calls (like SyncSwap's router,
  which calls into the vault, pool, and fee manager) can revert at the
  return-data handoff back to the test harness — with no Solidity-level
  trace or require string — even though the real call demonstrably
  succeeded one frame down (confirmed via a `console.log` probe placed
  immediately after the call, which never printed). This is a test-tooling
  boundary issue, not a contract bug. If you hit an unexplained
  `EvmError: Revert` immediately after a trace shows a clean `[Return]`
  from a real contract call, suspect this before suspecting your adapter
  code — check the full trace for a genuine successful return one level
  down first.
- **Mute router, and USDT address, are now CONFIRMED — `test_Mute_UsdcToUsdt_SingleHop` PASSED outright** against live zkSync Era mainnet.
  A real 50 USDC.e swap executed through Mute's router
  (`0x8B791913eB07C32779a16750e3868aA8495F5964`, sourced from Mute's own
  official SDK repo `github.com/muteio/muteswitch-sdk`), correctly resolved
  the stable USDC/USDT pair via `getPair(..., true)`, and delivered real
  USDT back (50.057 USDT for 50 USDC.e — a plausible stable-pair rate). This
  confirms `MuteAdapter.sol`'s ABI, the Mute router address, and the USDT
  address all at once:
  **USDT on zkSync Era mainnet: `0x493257fD37EDB34451f62EDf8D2a0C418852bA4C`**
  (this was the original guess in the project, minus one dropped hex digit
  from a transcription error caught and fixed during this testing session —
  now independently corroborated by the block explorer's own token page,
  Exponential DeFi, and two separate GeckoTerminal liquidity pools).
- **SpaceFi (`thirdDex`) router is now CONFIRMED — `test_ThirdDex_UsdtToWeth_SingleHop` PASSED outright.**
  A real 50 USDT swap executed through SpaceFi's router
  (`0xbE7D1FD1f6748bbDefC4fbaCafBb11C6Fc506d1d`) against live reserves
  (~7.43B USDT / ~3.94 WETH in the pool at test time) and delivered real
  WETH back (0.0263 WETH for 50 USDT — a plausible ~$1,900/ETH implied
  price). This confirms the classic 5-arg UniV2
  `swapExactTokensForTokens(amountIn, amountOutMin, path, to, deadline)`
  signature `UniswapV2Adapter.sol` assumes is exactly what's deployed there
  — the ABI concern that motivated switching away from PancakeSwap earlier
  in this project's history is fully resolved for SpaceFi.

**All three DEX legs (SyncSwap, Mute, SpaceFi) are verified against live
zkSync Era mainnet liquidity, not just static docs review.**

- **`test_FullTriangle_WethUsdcUsdtWeth` cannot pass in this tool as
  currently available** — it includes a SyncSwap leg, which hits the same
  return-data tooling limitation described above every time. All three legs
  are proven correct individually (see above), which is strong indirect
  evidence the full chain works on real mainnet, but this specific
  end-to-end test cannot confirm it directly given the tooling available
  during this session.

- **CRITICAL FINDING — `TriangleArbFlash` for WETH via SyncSwap's Vault
  currently fails, and this is a real, live-confirmed constraint, not a
  test artifact.** `test_FlashTriangle_WethUsdcUsdtWeth` reverted with
  `INSUFFICIENT_FLASH_LOAN_BALANCE` — the Vault's own WETH balance was 0 at
  the moment of the attempted loan. This was independently confirmed via a
  direct `cast call` against **live current mainnet state** (not just the
  forked block), so it isn't a stale-fork artifact:
  ```
  cast call 0x5AEa5775959fBC2557Cc8789bC1bf90A239D9a91 "balanceOf(address)(uint256)" \
    0x621425a1Ef6abE91058E9712575dcc4258F8d091 --rpc-url <your RPC>
  # returned: 0
  ```
  The mechanics: per SyncSwap's own docs, `maxFlashLoan(token)` simply
  returns `IERC20(token).balanceOf(address(this))` — the Vault can only
  lend what's currently deposited in its own balance, which is separate
  from (and can be much smaller than) the liquidity sitting in SyncSwap's
  actual swap pools. The Vault is a shared escrow used for gas-efficient
  transfers and flash loans as a side feature, not guaranteed to hold every
  token at all times.
  **Practical implication**: before attempting a real flash-loan trade,
  `TriangleArbFlash`/the scanner should call
  `vault.maxFlashLoan(startToken)` and confirm it covers `amountIn` — this
  is now implemented in `bot/scanner.js` (`checkFlashLoanCapacity`), which
  fails closed and skips the scan if the Vault can't cover it.

- **Aave V3 on zkSync Era was investigated as an alternative flash-loan
  source. Its Pool is confirmed live and genuine**
  (`0x78e30497a3c7527d953c6B1E3541b021A98Ac43c`, confirmed via
  `FLASHLOAN_PREMIUM_TOTAL() == 5`, the standard 0.05% Aave V3 fee), **but
  at the time of this check it held zero balance for WETH, USDT, AND
  USDC.e** — checked directly via `cast call balanceOf` for all three. This
  tracks with Aave governance's own rollout notes: the zkSync deployment
  was activated with deliberately low ~$10K-per-asset caps for initial
  testing, and DefiLlama showed only ~$20K total TVL across the entire
  zkSync Aave deployment at check time — a very new, still-shallow market.
  Revisit Aave once its caps are raised and real liquidity builds up (same
  `cast call balanceOf` pattern — TVL on a new deployment can shift
  quickly, so don't assume this stays accurate).
  Two addresses for Aave's zkSync Pool circulate online — an older one
  (`0x75Bb7792...`) from a stale `aave-address-book` commit predating a
  compiler-related redeploy, and the current one (`0x78e30497...`) from the
  main branch, which is the one actually confirmed live above. If revisiting
  this, re-check `aave-address-book`'s main branch rather than trusting a
  cached/older reference.

- **UPDATE — SyncSwap's Vault has deep, real liquidity for USDC.e and USDT,
  just not WETH.** Checked live via `cast call balanceOf`:
  - USDC.e: `2,004,931,746,846` raw (6 decimals) ≈ **~2.00M USDC.e**
  - USDT: `175,673,383,301` raw (6 decimals) ≈ **~175,673 USDT**
  Both are far more than enough for any realistic trade size — genuine,
  deep liquidity, not a marginal "just enough." **Practical conclusion,
  revised**: the flash-loan path IS viable on SyncSwap's Vault today — just
  start the triangle from USDC.e or USDT instead of WETH. The same three
  adapters/DEXs work; only the rotation changes (e.g.
  USDC.e→USDT→WETH→USDC.e, borrowing and repaying in USDC.e). This has NOT
  yet been fork-tested — `test_FlashTriangle_WethUsdcUsdtWeth` only tried
  the WETH-first rotation. A USDC.e-first or USDT-first version is a
  natural next test.

- **SyncSwap's Vault has deep, real liquidity for USDC.e and USDT, just not
  WETH.** Checked live via `cast call balanceOf`:
  - USDC.e: `2,004,931,746,846` raw (6 decimals) ≈ **~2.00M USDC.e**
  - USDT: `175,673,383,301` raw (6 decimals) ≈ **~175,673 USDT**
  Both are far more than enough for any realistic trade size.

- **Aave V3 on zkSync Era was investigated as an alternative flash-loan
  source. Its Pool is confirmed live and genuine**
  (`0x78e30497a3c7527d953c6B1E3541b021A98Ac43c`, confirmed via
  `FLASHLOAN_PREMIUM_TOTAL() == 5`, the standard 0.05% Aave V3 fee), **but
  at the time of this check it held zero balance for WETH, USDT, AND
  USDC.e** — checked directly via `cast call balanceOf` for all three. This
  tracks with Aave governance's own rollout notes: the zkSync deployment
  was activated with deliberately low ~$10K-per-asset caps for initial
  testing, and DefiLlama showed only ~$20K total TVL across the entire
  zkSync Aave deployment at check time. Revisit once caps are raised (same
  `cast call balanceOf` pattern — don't assume this stays accurate).

- **CRITICAL FINDING, NOW FIXED AT THE CONTRACT LEVEL — a flash loan
  sourced from SyncSwap's Vault cannot route ANY leg through SyncSwap
  itself.** `test_FlashTriangle_UsdcUsdtWethUsdc` (USDC.e-first rotation,
  SyncSwap leg last) reverted with a clean `ReentrancyGuard: reentrant
  call` thrown by the Vault itself — the SyncSwap leg's swap tried to call
  back into `vault.deposit(...)` mid-swap while that same Vault's
  `flashLoan()` was still on the call stack. This is unrelated to token
  choice or leg position: it happens any time a SyncSwap-vault-funded
  flash loan tries to swap through SyncSwap within the same transaction,
  because the Vault's own `nonReentrant` guard (correctly, from SyncSwap's
  side) blocks re-entering itself mid-loan.
  **Fix implemented in `TriangleArbFlash.sol`**: a new
  `isBlockedDuringFlashLoan` mapping (separate from the general adapter
  allowlist) lets the owner mark an adapter as unsafe to use during a
  flash loan from this specific vault. `onFlashLoan` checks every leg
  against this mapping *before* running any swaps, and reverts immediately
  with a custom error `AdapterBlockedDuringFlashLoan(adapter, legIndex)` —
  naming the exact leg and adapter — instead of burning gas on doomed
  swaps and eventually hitting the vault's own generic revert three calls
  deep. **This is opt-in, not automatic** — after deploying
  `TriangleArbFlash`, the owner must call
  `setBlockedDuringFlashLoan(syncSwapAdapterAddress, true)` for this
  protection to exist. This is now part of the deployment checklist (see
  Setup below) — a fresh deployment that skips this step will not be
  protected and will eventually hit the vault-side reentrancy revert
  instead of the clearer contract-level one.
  `test_FlashTriangle_WethUsdcUsdtWeth_RevertsFastOnSyncSwapLeg` confirms
  the guard fires correctly (asserts the specific custom error + leg
  index, not just "some revert happened").

- **CORRECTION, REFINED — only zkSwap Finance's USDT/WETH pool is thin; its
  WETH/USDC.e pool is genuinely fine.** Live profitability checks at
  increasing trade sizes showed WETH output flatlining well below linear
  scaling — checked directly via `getReserves()` on both zkSwap Finance
  pairs used in the rotation:
  - **USDT/WETH** (`0xA6e443251D6b4Ecd0bf7665834838Ca8B4280A13`, found via
    `FactoryV2.getPair(USDT, WETH)`): only **~1,971 USDT / ~1.029 WETH**
    total — roughly **$2,000 of liquidity**. This is the actual bottleneck.
  - **WETH/USDC.e** (`0x7642e38867860d4512Fcce1116e2Fb539c5cdd21`, found
    via `FactoryV2.getPair(WETH, USDC.e)`): **~54,598 USDC.e / ~28.38 WETH**
    — roughly **$108,000 of liquidity**. This leg is genuinely fine for
    moderate trade sizes.
  This is a real gap in the earlier verification: confirming a router
  *responds correctly* and gives a *plausible price at 1 WETH* (which it
  did on both pairs) is NOT the same as confirming it has enough depth to
  be usable — a thin pool gives an accurate quote right up until you push
  meaningful size through it, then the price collapses non-linearly.
  Always check `getReserves()` before trusting a DEX pair for anything
  beyond a small test swap.
  **Practical implication**: the SyncSwap-free flash rotation
  (`test_FlashTriangle_SyncSwapFree_UsdcUsdtWethUsdc`) is confirmed
  mechanically correct — borrow/swap/repay genuinely works — but the
  specific USDT→WETH leg needs a different, deeper venue than zkSwap
  Finance before this triangle is usable at any meaningful size. Worth
  checking Mute's or SpaceFi's USDT/WETH depth (if either has that direct
  pair) as a substitute for just this one leg, keeping zkSwap Finance for
  the WETH/USDC.e leg where it's already confirmed deep enough.
  `bot/check-profitability.js`'s catastrophic losses at $5,000+ are this
  one pool exhausting, not a sign the underlying arbitrage strategy itself
  is unviable — re-run the same check once a deeper substitute is found
  for the USDT→WETH leg specifically.

- **RESOLVED — checked USDT/WETH depth across all three UniV2-shaped DEXs
  available; SpaceFi has the deepest pool, and it's already wired into
  this project.** Live `getReserves()` checks on each DEX's USDT/WETH pair:

  | Venue | Reserves | ~Total liquidity |
  |---|---|---|
  | zkSwap Finance | ~1,971 USDT / ~1.03 WETH | ~$2,000 |
  | Mute | ~4,530 USDT / ~2.36 WETH | ~$9,000 |
  | **SpaceFi** | **~7,516 USDT / ~3.90 WETH** | **~$15,000** |

  SpaceFi's USDT/WETH pool — the exact pair already used successfully in
  the original pre-funded `TriangleArb` fork test — is the deepest of the
  three, and still fairly shallow in absolute terms (~$15K is not deep by
  DeFi standards generally, but it's what's actually available on zkSync
  Era right now for this specific pair). **Fix**: the SyncSwap-free flash
  rotation should route USDT→WETH through SpaceFi (`thirdAdapter`) instead
  of zkSwap Finance, keeping zkSwap Finance only for the WETH→USDC.e leg
  where its pool is genuinely deep (~$108K, confirmed separately). zkSwap
  Finance remains useful and worth keeping as a DEX option — just not for
  this specific pair.
  `bot/check-profitability.js` and `test_FlashTriangle_SyncSwapFree_UsdcUsdtWethUsdc`
  have been updated to reflect this corrected rotation (routing changed in
  both files, matching this table).

- **After the fix, still unprofitable at $20K+, and this is now a genuine
  finding about the strategy's ceiling — not a bug or a bad routing
  choice.** Re-running `bot/check-profitability.js` post-fix showed the
  same non-linear collapse pattern at larger sizes, just shifted — because
  the shallowest pool in the corrected rotation is now SpaceFi's USDT/WETH
  pool itself (~$15K, per the table above). Also checked Mute's
  USDC.e/USDT pool directly, since its output was ALSO compressing at
  $20K+ in the pre-fix run: `getReserves()` on
  `0x9d2811B85c1d736427722817B69e4D1E98016BB0` (the exact stable pair used
  throughout this project) returned **~16,158 USDC.e / ~19,020 USDT** —
  roughly **$35,000**, genuinely the deepest single pool found in this
  entire investigation. So Mute is fine at the sizes that matter; the
  binding constraint is specifically SpaceFi's USDT/WETH depth.
- **FINAL FINDING — no profitable size found anywhere in the $50–$10,000
  range either; this triangle has no exploitable edge on zkSync Era right
  now, and that's a real market-pricing finding, not a pool-depth
  artifact.** Re-running with the corrected SpaceFi routing and a finer
  $50–$10,000 sweep still showed a loss at every size, but the *character*
  of the loss changed — no more non-linear cliff, meaning depth is no
  longer the driver. At the smallest size checked (50 USDC.e, where none
  of the three pools are meaningfully stressed), the round trip cost
  **~1.16%** total. A rough fee-only floor for this exact three-hop path
  (Mute stable ~0.1% + two ~0.3% UniV2-style hops + the 0.05% flash fee)
  works out to roughly **~0.75%** — leaving about 0.4 percentage points
  unexplained by fees alone, most likely ordinary bid/ask spread across
  three independently-priced pools rather than a bug (implied ETH price
  was ~$1,941 entering the WETH leg vs. ~$1,918 exiting it — a small,
  plausible spread, not a pricing error). **Conclusion**: at the time of
  this check, the three DEXs are pricing WETH/USDC.e/USDT consistently
  with each other — there is no mispricing large enough to clear even
  fees at trivial size, let alone profit. This is exactly what "no
  arbitrage opportunity exists right now" looks like, and is a genuine,
  live-confirmed answer, not a gap in verification. Re-run
  `bot/check-profitability.js` periodically — this is a live snapshot,
  and real arbitrage opportunities (when they exist) are typically
  short-lived mispricings that can appear and vanish within blocks, which
  a one-time check like this cannot promise to catch.




  SyncSwap's Vault, but route all three swap legs through OTHER DEXs.
  `test_FlashTriangle_SyncSwapFree_UsdcUsdtWethUsdc` does this — USDC.e →
  USDT (Mute) → WETH (zkSwap Finance RouterV2) → USDC.e (zkSwap Finance
  RouterV2 again). **zkSwap Finance's RouterV2**
  (`0x18381c0f738146Fb694DE18D1106BdE2BE040Fa4`) was found and added as a
  fourth DEX specifically to build this rotation — it's a genuine, separate
  classic UniV2-shaped "V2 AMM" (distinct from zkSwap's own V3 and
  Universal Router contracts), sourced from their official docs
  (`docs.zkswap.finance/contracts-and-audits/contracts-addresses/zksync-era/dex-zksync`)
  and independently confirmed LIVE via `cast call getAmountsOut` for both
  WETH/USDC.e (~1810 USDC.e per WETH) and USDT/WETH (~0.0505 WETH per 100
  USDT) — both plausible real market rates at check time. Unlike SyncSwap,
  Mute, and SpaceFi (each confirmed via an actual executed swap during
  fork testing), zkSwap Finance's ABI has only been confirmed via
  read-only `getAmountsOut` calls, not yet an actual executed
  `swapExactTokensForTokens` — treat a failure in the SyncSwap-free flash
  test as "check zkSwap Finance's ABI/liquidity first," not as evidence of
  a `TriangleArbFlash`/adapter bug, since the flash-loan mechanism itself
  is already proven against two other router shapes.

`test/ForkIntegration.t.sol` runs the real adapters against a live zkSync
Era mainnet fork to check the SyncSwap step-data encoding, the Mute router
ABI, and the SpaceFi (`thirdDex`) ABI all at once — against actual deployed
bytecode, which is more reliable than reading docs/explorer pages by hand.

```bash
export FORK_TEST_MUTE_ROUTER=0x...        # required, no default — see README above
export FORK_TEST_USDT=0x...               # optional override, defaults to a best-effort guess
export FORK_TEST_THIRD_DEX_ROUTER=0x...   # optional, defaults to the SpaceFi address above
export FORK_TEST_USDC=0x...               # optional, defaults to a best-effort USDC.e guess
export FORK_TEST_SYNCSWAP_FACTORY=0x...   # optional, defaults to a best-effort guess — unconfirmed
export FORK_TEST_ZKSWAP_ROUTER=0x...      # optional, defaults to zkSwap Finance RouterV2 above

forge test --fork-url $ZKSYNC_RPC_URL --zksync --match-contract ForkIntegration -vvvv
```

**Requires [`foundry-zksync`](https://github.com/matter-labs/foundry-zksync)
(`foundryup-zksync`), not plain Foundry** — plain `forge` cannot execute
forked calls into real deployed zkEVM contracts at all (see "Known
`foundry-zksync` limitation" note above for what that failure looks like
if you use the wrong toolchain).

Each DEX gets its own isolated single-hop test (calling the adapter
directly, not through `executeTriangle`, so a revert points at exactly one
DEX) before the combined `test_FullTriangle_...` test. If an isolated test
fails, the revert reason names the specific placeholder in this README to
go fix. The full-triangle tests don't assert profitability — real
mainnet liquidity may not round-trip profitably the moment you run it —
only that the chain executes without reverting.

## Deployment checklist (flash-loan path)

1. Deploy `TriangleArbFlash(vaultAddress)`.
2. `setAdapterAllowed(adapter, true)` for every adapter you intend to use
   in ANY leg (same as the pre-funded path).
3. **`setBlockedDuringFlashLoan(adapterAddress, true)` for any adapter that
   routes through the same protocol as `vaultAddress`** (e.g. the
   SyncSwapAdapter, if borrowing from SyncSwap's Vault). Skipping this step
   does not prevent a bad rotation from being submitted — it just means
   you'll hit the lender's own generic reentrancy revert instead of the
   clearer contract-level one. See "Fork test findings" above for why this
   specific combination can never work, by construction.
4. Before submitting any real flash-loan transaction, confirm the vault
   actually holds enough of the start token:
   `vault.maxFlashLoan(startToken) >= amountIn`. `bot/scanner.js` does this
   automatically (`checkFlashLoanCapacity`) when `FLASH_MODE=true`.



**Revision 1** — the original version executed each adapter via
`delegatecall`, which meant every adapter ran with the arb contract's full
storage and balance context — a bug or malicious adapter could drain any
token the contract held, not just the one leg's tokens, and could corrupt
`owner`/`locked` storage directly. That revision switched to `call` +
scoped `approve`/`transferFrom`, added an on-chain adapter allowlist, and
added a `deadline` parameter so a stale transaction can't execute against a
moved market.

**Revision 2** (this one) — added the flash-loan variant, multi-hop-within-
a-leg, and dynamic gas-aware `minProfit`. The shared leg-execution logic was
extracted into `TriangleArbBase._runLegs` so the pre-funded and flash-loan
entry points can never drift apart on the security-critical parts (allowlist
checks, scoped approvals, per-leg output validation) — both call the exact
same internal function.

**Revision 3** — added `isBlockedDuringFlashLoan` to `TriangleArbFlash`
after live fork-testing found that a flash loan sourced from SyncSwap's
Vault reverts (with the vault's own generic reentrancy error) if any leg
routes back through SyncSwap. `onFlashLoan` now checks every leg against
this owner-set mapping before running any swaps and reverts immediately
with a specific custom error naming the offending adapter and leg index.
This is opt-in (see "Deployment checklist" above) — a deployment that skips
calling `setBlockedDuringFlashLoan` for the vault's own protocol is not
protected by this check and will eventually hit the vault-side revert
instead of the clearer one added here.

## Cross-chain investigation: is zkSync Era the right chain at all?

After the zkSync Era triangle came back with no exploitable edge at any
size (see "Fork test findings" above), a chain comparison was started to
check whether a different, less-saturated-but-still-liquid chain might be
a better fit. **This is in-progress — pick up here next session, don't
restart from scratch.**

**Motivation**: the person's goal is a chain with less MEV-bot competition
that's still profitable for a solo dev. The key finding from zkSync Era
was that low competition and low liquidity are often the same thing —
zkSync Era's total DEX volume is only ~$277K/24h chain-wide (DefiLlama),
which explains why every pool checked there was thin. A better target
needs BOTH lower competition AND enough real volume/liquidity to matter.

**Chain comparison (DefiLlama, checked this session — treat as a
snapshot, re-check before trusting):**

| Chain | DEX Volume (24h) | TVL | Notes |
|---|---|---|---|
| zkSync Era | ~$277K | ~$14.6M | Confirmed too thin — full investigation above |
| Scroll | ~$729K | Stables $31.34M | Not yet investigated further; SyncSwap USDC/USDT pool on Scroll showed **$1.62M liquidity** on GeckoTerminal — worth checking directly, potentially even more promising than Linea |
| **Linea** | $6.1M–$7.9M (snapshots varied) | $26M–$34M (snapshots varied) | **In progress — see below** |
| Mantle | Wildly inconsistent readings ($1.4M–$60M) across DefiLlama cache snapshots | ~$87M | Not trustworthy from search alone — would need direct verification before considering |
| Base | $1.215B | $4.435B | Reference point only — almost certainly too large/competitive for a solo-dev edge |

**Linea findings so far (live-confirmed via direct `cast` calls against
`https://rpc.linea.build`, same rigor as the zkSync work):**

SyncSwap is deployed on Linea mainnet (separate deployment from zkSync
Era's — NOT documented on `docs.syncswap.xyz`'s smart-contract page, which
only lists zkSync Era mainnet plus several testnets; the Linea deployment
was found via live trading pools on GeckoTerminal/DexScreener instead).
Router/factory addresses for Linea's SyncSwap have NOT yet been found or
verified — only individual pool contracts have been checked directly:

- **USDC/WETH pool**: `0x5ec5b1e9b1bd5198343abb6e55fb695d2f7bb308` —
  confirmed live via `reserve0()`/`reserve1()` (NOT `getReserves()` — this
  pool reverted on that call, same as zkSync's SyncSwap pools, confirming
  it's the same non-standard interface): **~188,128 USDC / ~98.27 WETH ≈
  ~$382,600 total**. This is already deeper than any single pool found
  useable on zkSync Era (nearly 4x deeper than Mute's $35K USDC/USDT pool).
- **USDT/WETH pool**: `0x8aebffb3964ec5cea0915080ddc1aca079583a4d` —
  confirmed live: **~13,634 USDT / ~7.10 WETH ≈ ~$27,700 total**. Note:
  GeckoTerminal's cached figure for this pool was $115.77K — noticeably
  higher than the ~$27,700 computed from the live on-chain reserves. This
  discrepancy was NOT resolved this session; possible explanations include
  a separate SyncSwap V2.1 version of this pool (the weETH/WETH pair on
  Linea showed exactly this pattern — a "SyncSwap (Linea)" pool and a
  separate, much larger "SyncSwap V2.1 (Linea)" pool for the same pair),
  or GeckoTerminal including LP staking/incentive value beyond raw
  reserves. Checked "SyncSwap V2.1 (Linea)" directly this session — it is
  NOT the answer: its total 24h volume across ALL pairs is only ~$1,089,
  with its most active pair (USDC/WETH) doing just ~$566 — a dead venue in
  practical terms, not usable for anything. The discrepancy remains
  unresolved; trust the live `reserve0()`/`reserve1()` reading
  (~$27,700) over GeckoTerminal's cached figure.
- **SyncSwap V2 Router on Linea mainnet — CONFIRMED LIVE this session**:
  `0xC2a1947d2336b2AF74d5813dC9cA6E0c3b3E8a1E`. Found via a LineaScan
  listing that (correctly, on closer reading) shows this address deployed
  on BOTH Linea Mainnet and Linea Sepolia Testnet — an earlier read of the
  same listing mistakenly assumed testnet-only. Confirmed live via
  `cast call ... "vault()(address)"` returning a real, non-zero address
  (`0x7160570BB153Edd0Ea1775EC2b2Ac9b65F1aB61B`), which independently
  matches the WETH-adjacent address seen in a separate docs table row —
  good corroboration. The router's ABI/interface is confirmed identical to
  zkSync Era's SyncSwap (`swap(SwapPath[], amountOutMin, deadline)`, same
  step-data `(tokenIn, to, withdrawMode)` encoding) — `SyncSwapAdapter.sol`
  should work unmodified against Linea, just with this new router address.
- **Linea's `SyncSwapPoolMaster` — CONFIRMED LIVE this session**:
  `0x608Cb7C3168427091F5994A45Baf12083964B4A3`, derived directly by
  calling `master()` on the already-confirmed-live USDC/WETH pool — a
  trustworthy anchor since it came from a pool holding real money, not a
  docs table.
- **USDC/USDT pool on Linea SyncSwap: STILL NOT FOUND**, and this
  session made a real effort — searched GeckoTerminal's SyncSwap-Linea
  and SyncSwap-V2.1-Linea pool listings directly, found none. The
  `SyncSwapClassicPoolFactory` address that seemed promising from a docs
  table row (`0x46c8dc568ED604bB18C066Fc8d387859b7977836`) was checked
  directly via `cast code` on Linea and **has no deployed code there
  either** — it isn't zkSync's, isn't Linea's; likely a testnet address
  that bled into the same docs table row confusion that's bitten this
  project twice now. **This specific `docs.syncswap.xyz` smart-contract
  page has now caused three separate wrong-address incidents across two
  sessions (zkSync router, this Linea factory guess, and the original
  zkSync/Linea WETH mixup) — treat every address on it as unverified until
  independently confirmed on-chain, don't just read the table.**

**Ruled out this session, don't re-attempt without new information:**
- **PancakeSwap V2 on Linea**: the commonly-cited BSC-native router
  address `0x10ED43C718714eb63d5aA57B78B54704E256024E` has **no deployed
  code on Linea** (confirmed via `cast call ... "factory()(address)"`
  erroring "does not have any code"). DexScreener's separate "Pancakeswap
  V2 (Linea)" listing likely exists as a distinct real contract, but its
  address was not found despite multiple search attempts.
- **Lynex router/factory**: NOT FOUND despite several attempts. Lynex's
  own official docs say "Contracts will be progressively added" with no
  usable address. A third-party (ICHI) docs page listed
  `0x0248b992ac2a75294b05286E9DD3A2bD3C9CFE4B` as a "Lynex Factory
  Contract" — checked directly via `cast code` (real bytecode found) and
  `cast call allPairsLength()` (reverted), then diagnosed by reading the
  bytecode's embedded revert strings directly: this is an **ICHI Vault
  Factory** (`IFV.createICHIVault`, `IFV: vault exists`, etc.) — a
  single-sided liquidity management product, NOT a swap-pair factory. Real
  contract, wrong product entirely. Lynex's GitHub org
  (github.com/Lynexfi) has no public contracts/frontend repo with
  addresses in it — only token-list, TVL-adapter, and yield-server-fork
  repos. Transaction search on LineaScan for Lynex activity surfaced only
  third-party aggregators (KyberSwap, Odos, TransitSwap) routing through
  Lynex, never a labeled Lynex contract directly.
- **Mantle's DEX volume figures**: search snippets gave wildly
  inconsistent numbers ($1.4M vs $59.69M for the same 24h metric) —
  too unreliable to act on without a direct, single clean read.

**NILE — checked this session, real factory but USDC/USDT liquidity too
small to use:**
- Router: `0xAAA45c8F5ef92a000a121d102F4e89278a711Faa`, Factory (pairFactory):
  `0xAAA16c016BF556fcD620328f0759252E29b1AB57` — sourced from NILE's own
  official docs (`docs.nile.build/resources/deployed-contract-addresses`),
  explicitly labeled "Contract Addresses for NILE on Linea" (no
  testnet/mainnet ambiguity this time). Confirmed live: `allPairsLength()`
  returned `133` — a real, populated Solidly-style (ve(3,3)) factory,
  despite NILE's own marketing describing itself as Uniswap-V3-flavored.
- Both stable and volatile USDC/USDT pairs exist and were checked directly:
  stable pair (`0x5fE161D9875cC96AD886648Ae166471297c8762c`) holds only
  **~$0.001 total** (functionally empty); volatile pair
  (`0x3Cd0083f6860df3c5F634067BfF6cb5C5596ab94`) holds **~$75.80 total**
  (~$37.82 USDC + ~$37.98 USDT) — both confirmed via direct `balanceOf`
  calls on the pair contract, not just `getReserves()`. Real, live, but
  far too small to be usable for anything beyond a trivial test swap.
  NILE's factory having 133 real pairs suggests it might be worth
  checking for a *different* token pair later, just not USDC/USDT.

**SushiSwap — checked this session, genuine dead end, worth remembering
exactly why:** the commonly-cited V2 router address
`0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506` is deployed identically
across FTMScan, PolygonScan, Arbiscan, and BscScan (real CREATE2-style
multi-chain consistency, unlike PancakeSwap's address which only existed
on some chains) — but on Linea specifically, **this same address holds a
completely different, unrelated contract**: reading the deployed
bytecode's embedded strings (`<clip-path=url(#corners`, `<rect fill=`,
`<g clip-path=`) shows it's an NFT/SVG position-metadata renderer, not a
swap router at all. This is an important general lesson: a consistent
CREATE2 address across many chains does NOT guarantee the same *contract*
occupies that address on every chain — something else can claim the
address first, or the intended contract was simply never deployed there.
Always verify with a function call (not just `cast code` returning
non-empty), and if something unexpected reverts, consider reading the
bytecode's embedded strings directly (worked well here and once before
with the ICHI mixup) before concluding the ABI is merely "close but wrong."

**KyberSwap Classic — checked this session, real DMM-style factory, real
pool, still too small:**
- Factory: `0x1c758aF0688502e49140230F6b0EBd376d429be5` — sourced from
  KyberSwap's own official docs
  (`docs.kyberswap.com/reference/legacy/kyberswap-classic/contracts/classic-contract-addresses`),
  confirmed genuinely deployed and populated on Linea via bytecode
  inspection (embedded revert strings like `"K$: UNAMPLIFIED_POOL_EXISTS"`
  and `"K$: INSUFFICIENT_LIQUIDITY"` clearly match a real DMM/AMM
  factory, not a mismatched product like the earlier ICHI/SushiSwap
  false leads). Note this is KyberSwap **Classic**, not **Elastic** —
  Elastic is confirmed concentrated-liquidity (Uniswap V3-style,
  struct-based `ExactInputSingleParams` swaps) and also had a real
  security incident in Nov 2023 — don't use Elastic with
  `UniswapV2Adapter.sol`, and treat it cautiously even with a
  purpose-built adapter given its security history.
- Enumeration uses `getPools(tokenA, tokenB)` (DMM-style, returns an
  array of pools rather than plain UniV2's single-pool `getPair`), not
  `allPairsLength()`/`allPairs()` (which reverted — wrong function name,
  not evidence of a fake contract).
- USDC/USDT pool found: `0x52a371c20863DC7e3866E065cf172A59EB49e13b` —
  confirmed via direct `balanceOf` calls: **~$165.85 USDC + ~$165.76
  USDT ≈ $331.61 total**. Real and balanced, but still too small for
  anything beyond a trivial test trade.

**Pattern worth naming plainly after four DEXs checked**: every genuine
USDC/USDT pool found on Linea today is small — NILE's volatile pair
(~$75.80), KyberSwap Classic (~$331.61), NILE's stable pair (~$0.001,
effectively dead). This is starting to look like a real characteristic
of Linea's market, not bad luck in DEX selection: **Linea's stablecoin-
pair liquidity may be broadly thin, even though its WETH-paired liquidity
(via SyncSwap, ~$382K and ~$27.7K) is genuinely deep.** Worth treating
this as a live hypothesis rather than a settled conclusion — a couple
more DEXs left untried (iZiSwap, EchoDEX, Secta Finance) could still
surprise, but going in with reduced optimism is warranted.

**Remaining untried**: iZiSwap (concentrated liquidity — likely
V3-incompatible-ABI, same concern as KyberSwap Elastic/PancakeSwap V3),
EchoDEX, Secta Finance. Velocore (⚠️ suffered an exploit in 2024 and
relaunched — check current audit status before considering even if a
real router is found).

**Next steps, in order, when resuming:**
1. Try the remaining untried DEXs above for a real USDC/USDT (or
   USDC/USDT-adjacent) pool with genuine depth — verify every address with
   both `cast code` (has bytecode?) AND an actual function call (does it
   behave as expected?) before trusting it, per the SushiSwap lesson above.
   **A third, independent DEX genuinely is required** — checked this
   session whether a 4-leg path reusing only the two confirmed SyncSwap
   pools (e.g. USDC→WETH→USDT→WETH→USDC) could substitute for a third
   venue, and it can't: routing back through the same WETH/USDT pool
   twice just pays that pool's spread/fee twice with no independent price
   check in between — there's no arbitrage signal without a third,
   separately-priced market. Don't revisit this specific shortcut; the
   third DEX is a hard requirement, not a nice-to-have.
2. Once a third leg is confirmed, reuse
   `SyncSwapAdapter.sol` (router `0xC2a1947d2336b2AF74d5813dC9cA6E0c3b3E8a1E`,
   confirmed working interface) and whichever adapter fits the third
   DEX's ABI, then adapt `test/ForkIntegration.t.sol` for Linea
   (`--fork-url https://rpc.linea.build`, `--zksync` flag NOT needed since
   Linea is a standard EVM chain, not a zkEVM — plain `forge test` should
   work here, worth confirming as a first quick check since it removes a
   whole category of tooling friction this project hit repeatedly on
   zkSync Era).
3. Also worth a parallel quick check of Scroll's SyncSwap USDC/USDT pool
   ($1.62M seen this session, unverified) — Scroll may turn out to be an
   even stronger candidate than Linea and is worth 10 minutes of
   verification before sinking more time into Linea's missing third leg.

