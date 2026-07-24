// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

/// @notice Aave V3's flash loan interfaces. Confirmed against Aave's own
/// protocol documentation (aave.com/docs/aave-v3) — this is NOT the ERC-3156
/// standard shape used by SyncSwap's Vault on zkSync Era. Key differences:
///   - Lender-side entry point is `flashLoanSimple(receiverAddress, asset,
///     amount, params, referralCode)` for a single-asset loan (there's also
///     a multi-asset `flashLoan` variant not used here), not ERC-3156's
///     `flashLoan(receiver, token, amount, data)`.
///   - Borrower callback is `executeOperation(asset, amount, premium,
///     initiator, params)` returning a plain `bool`, not `onFlashLoan(...)`
///     returning the ERC-3156 CALLBACK_SUCCESS hash.
///   - Repayment is still by approval (Aave pulls amount + premium via
///     transferFrom after executeOperation returns), same pattern as
///     ERC-3156, just under different names.
/// Do not attempt to reuse TriangleArbFlash.sol's IERC3156FlashBorrower
/// implementation against this lender — the callback signatures are
/// incompatible at the ABI level, not just in naming.
interface IAaveV3Pool {
    function flashLoanSimple(
        address receiverAddress,
        address asset,
        uint256 amount,
        bytes calldata params,
        uint16 referralCode
    ) external;

    /// @notice Current flash loan fee, in basis points of the borrowed
    /// amount (e.g. 5 = 0.05%). Confirmed via Aave's own docs as the
    /// standard V3 flash loan premium mechanism; query live rather than
    /// hardcoding, since Aave governance can change this.
    function FLASHLOAN_PREMIUM_TOTAL() external view returns (uint128);
}

interface IAaveV3FlashLoanReceiver {
    function executeOperation(
        address asset,
        uint256 amount,
        uint256 premium,
        address initiator,
        bytes calldata params
    ) external returns (bool);
}
