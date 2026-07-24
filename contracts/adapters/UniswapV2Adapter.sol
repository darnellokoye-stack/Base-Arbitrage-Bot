// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import {ISwapAdapter} from "./ISwapAdapter.sol";
import {IUniswapV2Router} from "../interfaces/IUniswapV2Router.sol";
import {SafeTransfer} from "../libraries/SafeTransfer.sol";

/// @notice extraData is unused per-hop for this adapter (plain UniV2 path
/// has no extra flags). Multi-hop chains are submitted as a SINGLE call to
/// the router's native `swapExactTokensForTokens` with a multi-address path
/// (e.g. [WETH, USDC, USDT]), rather than looping separate swaps — this is
/// both cheaper and matches how UniV2-style routers are designed to be used.
///
/// Called via regular `call` from TriangleArb (see ISwapAdapter.sol for the
/// execution model): pulls amountIn via transferFrom, swaps the whole chain
/// in one router call, sends the final output back to the caller.
///
/// DEADLINE: `deadline` is passed straight through to the router unchanged
/// — it is the caller's real submission-time deadline, not recomputed here.
/// A previous version fabricated `block.timestamp + 300` inside this
/// adapter, which made the router's own deadline check a no-op (it's always
/// "now" at execution time); the real protection now lives at the router
/// level too, not only in TriangleArb's outer `deadline` check.
contract UniswapV2Adapter is ISwapAdapter {
    IUniswapV2Router public immutable router;

    constructor(address _router) {
        router = IUniswapV2Router(_router);
    }

    function executeMultiHop(
        Hop[] calldata hops,
        uint256 amountIn,
        uint256 amountOutMin,
        uint256 deadline
    ) external override returns (uint256 amountOut) {
        require(hops.length >= 1, "UniswapV2Adapter: empty hop chain");

        address tokenIn = hops[0].tokenIn;
        address tokenOut = hops[hops.length - 1].tokenOut;

        // Pull the tokens TriangleArb approved for this call.
        SafeTransfer.safeTransferFrom(tokenIn, msg.sender, address(this), amountIn);

        SafeTransfer.safeApprove(tokenIn, address(router), amountIn);

        // Build the full multi-hop path in one array: [tokenIn, hop1.tokenOut, ..., tokenOut].
        // Validate hop continuity while building it (hops[i].tokenIn == hops[i-1].tokenOut).
        address[] memory path = new address[](hops.length + 1);
        path[0] = tokenIn;
        for (uint256 i = 0; i < hops.length; i++) {
            if (i > 0) {
                require(hops[i].tokenIn == hops[i - 1].tokenOut, "UniswapV2Adapter: hop token mismatch");
            }
            path[i + 1] = hops[i].tokenOut;
        }

        uint256[] memory amounts = router.swapExactTokensForTokens(
            amountIn,
            amountOutMin,
            path,
            address(this),
            deadline
        );

        amountOut = amounts[amounts.length - 1];
        require(amountOut >= amountOutMin, "UniswapV2Adapter: insufficient output");

        // Send the swap result back to TriangleArb.
        SafeTransfer.safeTransfer(tokenOut, msg.sender, amountOut);
    }
}
