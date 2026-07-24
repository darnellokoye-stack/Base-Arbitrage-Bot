// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import {TriangleArbBase} from "./TriangleArbBase.sol";
import {IERC20} from "./interfaces/IERC20.sol";
import {SafeTransfer} from "./libraries/SafeTransfer.sol";
import {IAaveV3Pool, IAaveV3FlashLoanReceiver} from "./interfaces/IAaveV3Flash.sol";

/// @title TriangleArbAaveFlash
/// @notice Same leg-execution model as TriangleArb, but borrows the starting
/// capital via an Aave V3 single-asset flash loan instead of requiring the
/// contract to be pre-funded. Repays principal + premium within the same
/// transaction and reverts the entire chain (loan included) unless what's
/// left over clears minProfit.
///
/// @dev This is the Base-chain replacement for TriangleArbFlash.sol, which
/// was written against SyncSwap's Vault (ERC-3156-shaped, zkSync/Linea/
/// Scroll only — SyncSwap does not exist on Base). Aave V3's flash loan
/// interface is NOT ERC-3156: different function names, different callback
/// signature, different parameter order (see IAaveV3Flash.sol for the
/// specific differences). This is therefore a new contract, not a
/// redeployment of TriangleArbFlash with a different constructor arg.
///
/// Pool address: confirmed live on BaseScan as "Aave: Pool Proxy Base"
/// (0xA238Dd80C259a72e81d7e4664a9801593F98d1c5), 1M+ transactions, active
/// balance at time of writing. Re-verify before deploying with real capital
/// — addresses can be confirmed correct today and still worth a fresh check
/// before you actually deploy, per this project's own established standard.
///
/// SECURITY: executeOperation is guarded so it can only be entered via a
/// loan this contract itself initiated (msg.sender == pool AND initiator ==
/// address(this)), and the pool address is immutable and set at deployment.
///
/// BASE FORK STATUS: fork tests confirm a bare Aave WETH flash loan, a
/// flash-loan-backed leg chain, and a route through real Uniswap V2 +
/// Aerodrome liquidity. Re-run those tests before deployment, because live
/// Aave reserve flags/liquidity can change.
contract TriangleArbAaveFlash is TriangleArbBase, IAaveV3FlashLoanReceiver {
    IAaveV3Pool public immutable pool;

    /// @notice Adapter(s) that route through a protocol considered unsafe to
    /// use while an Aave flash loan from `pool` is in flight. Left as an
    /// empty allowlist by default (unlike TriangleArbFlash, which pre-
    /// documented a SyncSwap-specific conflict) since no equivalent conflict
    /// has been confirmed for Aave V3 on Base yet — populate only after
    /// fork-testing reveals a real one, don't guess entries preemptively.
    mapping(address => bool) public isBlockedDuringFlashLoan;

    event FlashBlockedAdapterSet(address indexed adapter, bool blocked);

    error AdapterBlockedDuringFlashLoan(address adapter, uint256 legIndex);

    constructor(address _pool) {
        require(_pool != address(0), "zero address");
        pool = IAaveV3Pool(_pool);
    }

    function setBlockedDuringFlashLoan(address adapter, bool blocked) external onlyOwner {
        require(adapter != address(0), "zero address");
        isBlockedDuringFlashLoan[adapter] = blocked;
        emit FlashBlockedAdapterSet(adapter, blocked);
    }

    /// @notice Borrows `amountIn` of the start token via an Aave V3
    /// single-asset flash loan, runs the leg chain, repays principal +
    /// premium, and reverts unless what remains clears minProfit.
    /// @param legs        ordered swap legs; legs[0]'s first hop's tokenIn must equal
    ///                    legs[last]'s last hop's tokenOut (the start token, and the
    ///                    token being flash-borrowed)
    /// @param amountIn    amount of the start token to borrow and commit
    /// @param minProfit   minimum acceptable profit AFTER the flash loan premium, in
    ///                    start-token units (should also cover gas + margin)
    /// @param deadline    unix timestamp after which the whole tx reverts, even if profitable
    function executeTriangleFlash(
        Leg[] calldata legs,
        uint256 amountIn,
        uint256 minProfit,
        uint256 deadline
    ) external onlyOwner nonReentrant returns (uint256 profit) {
        require(block.timestamp <= deadline, "deadline expired");
        require(legs.length >= 1, "need at least 1 leg");
        require(legs[0].hops.length >= 1, "leg needs at least 1 hop");
        require(legs[legs.length - 1].hops.length >= 1, "leg needs at least 1 hop");
        address startToken = legs[0].hops[0].tokenIn;
        require(
            legs[legs.length - 1].hops[legs[legs.length - 1].hops.length - 1].tokenOut == startToken,
            "path must return to start token"
        );

        uint256 balBefore = IERC20(startToken).balanceOf(address(this));

        // Encode everything executeOperation needs; Aave passes `params`
        // straight through unmodified, same pattern as ERC-3156's `data`.
        // `deadline` is included so the callback can forward the SAME
        // already-checked deadline into _runLegs / each adapter's router
        // call, rather than the callback recomputing a fresh one.
        bytes memory params = abi.encode(legs, minProfit, startToken, deadline);

        // referralCode: 0 — Aave's referral program is currently inactive
        // per Aave's own documentation; 0 is the documented correct value.
        pool.flashLoanSimple(address(this), startToken, amountIn, params, 0);

        uint256 balAfter = IERC20(startToken).balanceOf(address(this));
        require(balAfter >= balBefore, "unexpected balance decrease");
        profit = balAfter - balBefore;

        // executeOperation already enforced minProfit before repaying, so
        // this is a defense-in-depth re-check rather than the primary guard.
        require(profit >= minProfit, "profit below threshold");
    }

    /// @notice Aave V3 flash loan callback. Called by the pool mid-
    /// flashLoanSimple(), after it has already transferred `amount` of
    /// `asset` to this contract and before it attempts to pull back
    /// `amount + premium`.
    function executeOperation(
        address asset,
        uint256 amount,
        uint256 premium,
        address initiator,
        bytes calldata params
    ) external override returns (bool) {
        require(msg.sender == address(pool), "untrusted lender");
        require(initiator == address(this), "untrusted initiator");

        (Leg[] memory legs, uint256 minProfit, address startToken, uint256 deadline) =
            abi.decode(params, (Leg[], uint256, address, uint256));
        require(asset == startToken, "token mismatch");

        // Fail fast, before spending gas on any swap: no leg may route
        // through an adapter marked unsafe while this loan is in flight.
        for (uint256 i = 0; i < legs.length; i++) {
            if (isBlockedDuringFlashLoan[legs[i].adapter]) {
                revert AdapterBlockedDuringFlashLoan(legs[i].adapter, i);
            }
        }

        (uint256 finalAmount, ) = _runLegs(legs, amount, deadline);

        uint256 totalOwed = amount + premium;
        require(finalAmount >= totalOwed + minProfit, "profit below threshold after premium");

        emit TriangleExecuted(startToken, amount, finalAmount, finalAmount - totalOwed);

        // Repayment is by APPROVAL: Aave's Pool pulls `amount + premium` via
        // transferFrom immediately after this callback returns (confirmed
        // via Aave's own flash loan developer documentation).
        SafeTransfer.safeApprove(startToken, address(pool), totalOwed);

        return true;
    }
}
