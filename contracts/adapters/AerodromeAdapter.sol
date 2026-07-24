// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import {ISwapAdapter} from "./ISwapAdapter.sol";
import {IAerodromeRouter} from "../interfaces/IAerodromeRouter.sol";
import {SafeTransfer} from "../libraries/SafeTransfer.sol";

/// @notice Adapter for Aerodrome Finance's Router on Base — Base's largest
/// DEX by TVL. Confirmed against the deployed contract's own live ABI (see
/// IAerodromeRouter.sol header comment for verification details).
///
/// Per-hop extraData layout: abi.encode(bool stable, address factory) —
/// whether to route this specific hop through Aerodrome's stable-pool
/// (correlated assets, e.g. stablecoin pairs) or volatile pool, and which
/// PoolFactory to use for it. Pass address(0) for `factory` to use the
/// router's own defaultFactory() instead of specifying one explicitly —
/// this adapter resolves that at execution time via a live call rather than
/// hardcoding the factory address, so it keeps working if Aerodrome ever
/// registers additional approved factories.
///
/// Called via regular `call` from TriangleArb (see ISwapAdapter.sol for the
/// execution model): pulls amountIn via transferFrom, chains all hops
/// internally, sends the final hop's output back to the caller.
///
/// DEADLINE: `deadline` is passed straight through to the router unchanged —
/// see UniswapV2Adapter.sol's header comment for why a self-computed
/// `block.timestamp + N` here would make the router's own deadline check a
/// no-op.
contract AerodromeAdapter is ISwapAdapter {
    IAerodromeRouter public immutable router;

    constructor(address _router) {
        router = IAerodromeRouter(_router);
    }

    function executeMultiHop(
        Hop[] calldata hops,
        uint256 amountIn,
        uint256 amountOutMin,
        uint256 deadline
    ) external override returns (uint256 amountOut) {
        require(hops.length >= 1, "AerodromeAdapter: empty hop chain");

        // Pull the tokens TriangleArb approved for this call.
        SafeTransfer.safeTransferFrom(hops[0].tokenIn, msg.sender, address(this), amountIn);

        SafeTransfer.safeApprove(hops[0].tokenIn, address(router), amountIn);

        // Build the full Route[] chain in one array, validating hop
        // continuity while doing so (hops[i].tokenIn == hops[i-1].tokenOut).
        IAerodromeRouter.Route[] memory routes = new IAerodromeRouter.Route[](hops.length);
        for (uint256 i = 0; i < hops.length; i++) {
            if (i > 0) {
                require(hops[i].tokenIn == hops[i - 1].tokenOut, "AerodromeAdapter: hop token mismatch");
            }
            (bool stable, address factory) = abi.decode(hops[i].extraData, (bool, address));
            routes[i] = IAerodromeRouter.Route({
                from: hops[i].tokenIn,
                to: hops[i].tokenOut,
                stable: stable,
                factory: factory == address(0) ? router.defaultFactory() : factory
            });
        }

        uint256[] memory amounts = router.swapExactTokensForTokens(
            amountIn,
            amountOutMin,
            routes,
            address(this),
            deadline
        );

        amountOut = amounts[amounts.length - 1];
        require(amountOut >= amountOutMin, "AerodromeAdapter: insufficient output");

        // Send the swap result back to TriangleArb.
        SafeTransfer.safeTransfer(hops[hops.length - 1].tokenOut, msg.sender, amountOut);
    }
}
