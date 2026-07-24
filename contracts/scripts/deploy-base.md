# Deploying to Base

This project ships prepped for Base but does NOT deploy anything itself —
per your own choice, deployment is a manual step you run yourself. This
file is the checklist, not a script that touches mainnet on your behalf.

## Order of deployment

Deploy in this order, since later contracts need earlier ones' addresses:

1. **UniswapV2Adapter** — constructor takes the Uniswap V2 Router address
   (`cfg.dexes.uniswapV2Router` = `0x4752bA5DBc23f44D87826276BF6Fd6b1C372AD24`).
   Unmodified from the original zkSync-era adapter — Base's Uniswap V2
   fork is a genuinely plain UniswapV2Router shape.

2. **AerodromeAdapter** (`contracts/adapters/AerodromeAdapter.sol`) —
   constructor takes the Aerodrome Router address
   (`cfg.dexes.aerodromeRouter` = `0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43`).
   New contract, not a port — see its header comment for why the ABI
   shape required a new adapter rather than reusing UniswapV2Adapter.

3. **TriangleArb.sol** (pre-funded variant) — no constructor args beyond
   what's already there (`owner = msg.sender`). After deploying, call
   `setAdapterAllowed(uniswapV2AdapterAddress, true)` and
   `setAdapterAllowed(aerodromeAdapterAddress, true)` — legs will revert
   with "adapter not allowlisted" otherwise, by design (see
   TriangleArbBase.sol's security model comment).

4. **TriangleArbAaveFlash.sol** (flash-loan-funded variant, optional —
   only needed if you want to run without pre-funding the contract) —
   constructor takes the Aave V3 Pool address
   (`cfg.flashLoan.aavePool` = `0xA238Dd80C259a72e81d7e4664a9801593F98d1c5`).
   Same `setAdapterAllowed` calls needed as step 3 — this is a SEPARATE
   allowlist from TriangleArb's, since it's a different deployed contract
   instance with its own storage.

## Before sending any real transaction

Everything above is confirmed against live, verified BaseScan contracts
and/or the DEX's own official documentation/GitHub as of this writing —
but "confirmed today by research" is not the same as "verified by you,
on-chain, right before you deploy." This project has already been burned
once (see main README's Linea detour) by trusting an address without a
direct on-chain check. Before deploying:

```bash
# Confirm each router/factory/pool address actually has code and responds
# as expected — don't trust this file's addresses blindly.
cast code 0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43 --rpc-url https://mainnet.base.org
cast call 0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43 "defaultFactory()(address)" --rpc-url https://mainnet.base.org
```

## Environment variables to set after deployment

```
BASE_USDC=0x...                        # verify on BaseScan/Circle's docs first
BASE_TRIANGLE_ARB=0x...                # from step 3
BASE_TRIANGLE_ARB_AAVE_FLASH=0x...     # from step 4, if deployed
BASE_UNIV2_ADAPTER=0x...               # from step 1
BASE_AERODROME_ADAPTER=0x...           # from step 2
PRIVATE_KEY=0x...                      # the deployed contracts' owner key — omit to dry-run only
OWNER_ADDRESS=0x...                    # if PRIVATE_KEY is omitted, set this to the owner() address
                                        # so gas estimation still simulates as the real owner
```

## Base fork testing status

`TriangleArbAaveFlash` is now fork-tested against real Base state. The
active fork suite confirms:

- A bare WETH flash loan succeeds against Aave V3 on Base
- A flash-loan-backed leg chain reaches repayment/profit accounting
- A route through real Uniswap V2 and Aerodrome liquidity reaches the
  expected profit guard instead of failing at Aave entry

Run the fork tests with Foundry's configured Cancun EVM setting:

```bash
forge test --fork-url https://mainnet.base.org --match-contract BaseForkAdaptersTest
```

This proves integration shape, not live profitability. Re-run it right
before deployment, because live reserve flags/liquidity can change.
