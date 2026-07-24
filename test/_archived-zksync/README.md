# Archived zkSync-era tests

These three files test SyncSwap/ERC-3156-specific behavior that no longer
applies after the full migration to Base (Aave V3 flash loans, Aerodrome +
Uniswap V2 DEXs). Moved here rather than deleted or left silently broken
against the new contracts.

- `TriangleArbFlash.t.sol` — unit tests for the old ERC-3156/SyncSwap flash
  contract (now removed; see `contracts/TriangleArbAaveFlash.sol` for its
  Base replacement).
- `ForkIntegration.t.sol` — zkSync Era mainnet fork tests, including the
  fork-test-confirmed finding (documented in the main README) that a leg
  routed through SyncSwap while mid-flash-loan-from-SyncSwap reverts on
  the Vault's own reentrancy guard.
- `mocks/MockFlashVault.sol` — mock ERC-3156 lender used by the above.

## What's needed to properly test the Base replacement

`contracts/TriangleArbAaveFlash.sol` currently has NO test coverage of its
own — this is a real, open gap, not something quietly papered over. To
close it, adapt the ForkIntegration.t.sol pattern for Base:

1. Fork Base mainnet (not zkSync Era) at a recent block
2. Deploy `TriangleArbAaveFlash` against the real Aave V3 Pool
   (`0xA238Dd80C259a72e81d7e4664a9801593F98d1c5`)
3. Deploy `UniswapV2Adapter` + `AerodromeAdapter` against their real Base
   router addresses (see `contracts/scripts/deploy-base.md`)
4. Confirm a full flash-loan round trip succeeds against live liquidity
5. Specifically test whether routing a leg through Aerodrome mid-flash-loan
   causes any reentrancy conflict — this is flagged as UNCONFIRMED in
   `TriangleArbAaveFlash.sol`'s header comment, not assumed safe. The
   original SyncSwap conflict was only found by writing exactly this kind
   of test, not by inspection — don't skip this step and assume Aave V3 +
   Aerodrome has no equivalent issue.

A mock-based unit test suite (mirroring the removed `MockFlashVault.sol`
pattern, but implementing `IAaveV3Pool`'s actual shape) would also be
useful for fast iteration without a live fork, but a mock alone would NOT
have caught the original SyncSwap reentrancy issue — fork testing against
real deployed contracts is what surfaced that, so treat a mock suite as a
supplement to fork testing, not a replacement for it.
