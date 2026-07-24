// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import {ISwapAdapter} from "./adapters/ISwapAdapter.sol";
import {IERC20} from "./interfaces/IERC20.sol";
import {SafeTransfer} from "./libraries/SafeTransfer.sol";

/// @title TriangleArbBase
/// @notice Shared owner/allowlist/leg-execution logic used by both the
/// pre-funded (`TriangleArb`) and flash-loan-funded (`TriangleArbAaveFlash`)
/// variants, so the core swap-chain execution exists in exactly one place
/// and can't drift between the two entry points.
///
/// SECURITY MODEL: adapters are called via regular `call`, not `delegatecall`.
/// TriangleArb explicitly approves each adapter for exactly the amount it is
/// allowed to pull for that leg (reset to 0 immediately after use). A buggy
/// or malicious adapter can therefore only ever move the tokenIn amount it
/// was approved for — it cannot touch this contract's storage (owner,
/// locked, or anything else) or drain unrelated token balances, since it
/// never executes in this contract's own execution context. Adapters must
/// pull funds with `transferFrom` and send the final hop's output back to
/// `msg.sender` — see ISwapAdapter.sol.
///
/// MULTI-HOP: each `Leg` now carries a chain of `Hop`s handled by a single
/// adapter in one call (e.g. WETH -> USDC -> USDT, all on SyncSwap, as one
/// leg). This lets a single DEX's own multi-hop pool routing be used inside
/// a leg without bouncing tokens back to this contract between every hop.
abstract contract TriangleArbBase {
    address public owner;
    bool private locked;

    struct Leg {
        address adapter;             // ISwapAdapter implementation for this DEX
        ISwapAdapter.Hop[] hops;     // ordered same-adapter hop chain for this leg
        uint256 amountOutMin;        // leg-level slippage floor (final hop output)
    }

    event TriangleExecuted(
        address indexed startToken,
        uint256 amountIn,
        uint256 amountOut,
        uint256 profit
    );

    event AdapterAllowlisted(address indexed adapter, bool allowed);

    /// @notice Adapters must be explicitly allowlisted before use. Closes off
    /// the risk of a scanner bug or compromised off-chain key pointing
    /// `leg.adapter` at an arbitrary attacker-supplied contract.
    mapping(address => bool) public isAllowedAdapter;

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    modifier nonReentrant() {
        require(!locked, "reentrant");
        locked = true;
        _;
        locked = false;
    }

    constructor() {
        owner = msg.sender;
    }

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "zero address");
        owner = newOwner;
    }

    /// @notice Allowlist (or de-allowlist) an adapter contract for use in leg execution.
    function setAdapterAllowed(address adapter, bool allowed) external onlyOwner {
        require(adapter != address(0), "zero address");
        isAllowedAdapter[adapter] = allowed;
        emit AdapterAllowlisted(adapter, allowed);
    }

    /// @notice Sweep any token back to the owner (profit withdrawal or recovery).
    function sweep(address token, uint256 amount) external onlyOwner {
        SafeTransfer.safeTransfer(token, owner, amount);
    }

    /// @notice Allow the contract to receive ETH (e.g. for WETH-wrapping legs).
    receive() external payable {}

    /// @dev Runs an ordered chain of legs starting with `amountIn` of the
    /// first leg's first hop's tokenIn, returning the final amount received
    /// of the last leg's last hop's tokenOut. Does NOT check profitability —
    /// callers (TriangleArb / TriangleArbAaveFlash) are responsible for that,
    /// since what "profit" means differs when a flash loan fee must also be
    /// covered.
    /// @param deadline the caller's real submission-time deadline (already
    /// checked by the caller against block.timestamp), forwarded unchanged to
    /// every adapter's executeMultiHop call so the underlying DEX router's own
    /// deadline check is a real constraint, not a same-block no-op.
    function _runLegs(Leg[] memory legs, uint256 amountIn, uint256 deadline) internal returns (uint256 finalAmount, address finalToken) {
        require(legs.length >= 1, "need at least 1 leg");
        require(legs[0].hops.length >= 1, "leg needs at least 1 hop");

        uint256 currentAmount = amountIn;
        address currentToken = legs[0].hops[0].tokenIn;

        for (uint256 i = 0; i < legs.length; i++) {
            Leg memory leg = legs[i];
            require(leg.hops.length >= 1, "leg needs at least 1 hop");
            require(isAllowedAdapter[leg.adapter], "adapter not allowlisted");
            require(leg.hops[0].tokenIn == currentToken, "leg token mismatch");

            address legTokenOut = leg.hops[leg.hops.length - 1].tokenOut;

            // Approve only what this leg needs, reset to 0 after the call
            // regardless of outcome, so an adapter can never retain standing
            // allowance to pull tokens later.
            SafeTransfer.safeApprove(currentToken, leg.adapter, currentAmount);

            uint256 outBefore = IERC20(legTokenOut).balanceOf(address(this));

            // Regular call: the adapter runs in its OWN storage/context and
            // can only move tokens it was just approved for, for this leg.
            ISwapAdapter(leg.adapter).executeMultiHop(leg.hops, currentAmount, leg.amountOutMin, deadline);

            // Reset any unused allowance so the adapter can't pull more later.
            SafeTransfer.safeApprove(currentToken, leg.adapter, 0);

            uint256 outAfter = IERC20(legTokenOut).balanceOf(address(this));
            uint256 amountOut = outAfter - outBefore;
            require(amountOut >= leg.amountOutMin, "leg output below minimum");

            currentAmount = amountOut;
            currentToken = legTokenOut;
        }

        finalAmount = currentAmount;
        finalToken = currentToken;
    }
}
