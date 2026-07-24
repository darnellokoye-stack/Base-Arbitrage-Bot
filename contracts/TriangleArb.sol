// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import {TriangleArbBase} from "./TriangleArbBase.sol";
import {IERC20} from "./interfaces/IERC20.sol";

/// @title TriangleArb
/// @notice Executes an atomic A -> B -> ... -> A swap across up to N legs,
/// where each leg may itself be a multi-hop chain on a single DEX adapter,
/// on Base. Reverts the whole transaction (including all intermediate
/// swaps) if the final balance doesn't clear amountIn + minProfit, so a
/// failed arb costs only gas, never principal.
/// @dev This variant requires the contract to be pre-funded with the
/// starting token. See TriangleArbAaveFlash for a zero-pre-funded-capital
/// variant that borrows the starting amount via an Aave V3 flash loan instead.
contract TriangleArb is TriangleArbBase {
    /// @notice Runs the leg chain and reverts unless profit clears minProfit.
    /// @param legs        ordered swap legs; legs[0]'s first hop's tokenIn must equal
    ///                    legs[last]'s last hop's tokenOut (the start token)
    /// @param amountIn    amount of the start token to commit
    /// @param minProfit   minimum acceptable profit in start-token units (covers gas + margin)
    /// @param deadline    unix timestamp after which the whole tx reverts, even if profitable
    function executeTriangle(
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
        require(balBefore >= amountIn, "insufficient start balance");

        (uint256 finalAmount, ) = _runLegs(legs, amountIn, deadline);

        uint256 balAfter = IERC20(startToken).balanceOf(address(this));
        require(balAfter >= balBefore, "unexpected balance decrease");
        profit = balAfter - balBefore;

        require(profit >= minProfit, "profit below threshold");

        emit TriangleExecuted(startToken, amountIn, finalAmount, profit);
    }
}
