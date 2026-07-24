// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

/// @notice Every DEX has a different router shape (SyncSwap's pool-based
/// SwapPath/SwapStep vs Mute's UniswapV2-fork-with-stable-flag vs a plain
/// UniswapV2 router). Adapters normalize all of them behind one call so
/// TriangleArb never needs to know which DEX it's talking to.
///
/// EXECUTION MODEL: TriangleArb calls executeMultiHop via a regular `call`,
/// not `delegatecall`. Before calling, TriangleArb approves this adapter for
/// exactly `amountIn` of `hops[0].tokenIn`. Each adapter implementation MUST:
///   1. `transferFrom(msg.sender, address(this), amountIn)` to pull the
///      tokens it was approved for (msg.sender is TriangleArb).
///   2. Execute each hop in `hops` in order, entirely within its own
///      context — intermediate tokens between hops never need to leave the
///      adapter and return to TriangleArb, saving a round-trip transfer per
///      intermediate hop.
///   3. `transfer` the FINAL hop's resulting token back to `msg.sender`.
/// A "leg" from TriangleArb's perspective can therefore represent multiple
/// same-DEX hops (e.g. WETH -> USDC -> USDT, all on SyncSwap, in one leg)
/// while TriangleArb itself only sees a single tokenIn -> tokenOut edge.
interface ISwapAdapter {
    struct Hop {
        address tokenIn;
        address tokenOut;
        uint256 amountOutMin; // per-hop slippage floor (0 to only enforce the leg-level floor)
        bytes extraData;      // adapter-specific routing info for this hop (pool address, stable flag, etc.)
    }

    /// @param hops         ordered chain of same-adapter hops; hops[0].tokenIn is what
    ///                     TriangleArb approved `amountIn` of; hops[i].tokenIn must equal
    ///                     hops[i-1].tokenOut for i > 0
    /// @param amountIn     exact amount of hops[0].tokenIn to sell (already approved to this adapter)
    /// @param amountOutMin minimum acceptable FINAL amountOut (leg-level slippage guard)
    /// @return amountOut   actual amount of the final hop's tokenOut sent back to the caller (TriangleArb)
    /// @param deadline     unix timestamp passed straight through to the underlying router call.
    ///                     MUST be the caller's real submission-time deadline (e.g. TriangleArb's
    ///                     own `deadline` argument), NOT a freshly computed `block.timestamp + N`
    ///                     inside the adapter — recomputing it at execution time makes the router's
    ///                     own deadline check a no-op, since `block.timestamp` there is always "now."
    function executeMultiHop(
        Hop[] calldata hops,
        uint256 amountIn,
        uint256 amountOutMin,
        uint256 deadline
    ) external returns (uint256 amountOut);
}
