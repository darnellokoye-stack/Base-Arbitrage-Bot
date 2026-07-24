// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

/// @notice Standard UniswapV2-shaped router. Currently used for Base's
/// Uniswap V2 deployment (Router02 at 0x4752bA5DBc23f44D87826276BF6Fd6b1C372AD24,
/// confirmed live via BaseScan — see bot/config.js), via UniswapV2Adapter.
/// Do NOT point this at Aerodrome — despite being a UniV2-derived DEX,
/// Aerodrome's Router takes a Route[] struct (from/to/stable/factory), not
/// a plain address[] path; use AerodromeAdapter + IAerodromeRouter instead
/// (see that file's header comment for the confirmed ABI difference).
///
/// Historical note: this interface was originally written for zkSync Era's
/// SpaceFi "Swap Router" (also plain UniV2-shaped). That deployment is no
/// longer used by this project after the migration to Base — the caveats
/// below about zkSync-specific DEXs (Velocore, PancakeSwap's V3-only
/// deployment there) no longer apply on Base but are left for reference
/// since they illustrate the general lesson: never assume a DEX is
/// UniV2-shaped without confirming its actual deployed ABI first.
interface IUniswapV2Router {
    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory amounts);

    function getAmountsOut(uint256 amountIn, address[] calldata path)
        external
        view
        returns (uint256[] memory amounts);
}
