// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

/// @notice Aerodrome Finance's Router interface on Base. Confirmed directly
/// against the deployed, verified contract's own ABI at
/// 0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43 (BaseScan, "Aerodrome: Router",
/// 3.8M+ transactions, actively used at time of writing) and cross-checked
/// against Aerodrome's own GitHub (github.com/aerodrome-finance/contracts).
///
/// IMPORTANT: this is NOT a plain UniswapV2Router-shaped interface, despite
/// Aerodrome being a UniV2-derived (Solidly-style ve(3,3)) DEX. Its
/// swapExactTokensForTokens takes a `Route[]` struct array (from/to/stable/
/// factory), not a plain `address[]` path — the existing UniswapV2Adapter
/// will NOT work against this router as-is. Use AerodromeAdapter instead.
interface IAerodromeRouter {
    struct Route {
        address from;
        address to;
        bool stable;    // true = stable-pool (correlated assets), false = volatile pool
        address factory; // pool factory this route's pool was created by
    }

    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        Route[] calldata routes,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory amounts);

    function getAmountsOut(uint256 amountIn, Route[] calldata routes)
        external
        view
        returns (uint256[] memory amounts);

    /// @notice The default PoolFactory this router falls back to when a
    /// Route's `factory` field isn't otherwise specified. Confirmed present
    /// on the live contract's ABI (`defaultFactory()` view function).
    function defaultFactory() external view returns (address);
}

/// @notice Aerodrome's PoolFactory. Confirmed address (BaseScan + Aerodrome's
/// own GitHub, both agreeing): 0x420DD381b31aEf6683db6B902084cB0FFECe40Da.
/// Emits PoolCreated(token0, token1, stable, pool, allPoolsLength) — a
/// DIFFERENT event shape than plain UniswapV2Factory's PairCreated (has an
/// extra indexed `stable` bool, and the event name itself differs), so a
/// generic PairCreated listener will NOT pick up new Aerodrome pools.
interface IAerodromePoolFactory {
    event PoolCreated(
        address indexed token0,
        address indexed token1,
        bool indexed stable,
        address pool,
        uint256
    );

    function allPoolsLength() external view returns (uint256);
    function isPool(address pool) external view returns (bool);
    function getPool(address tokenA, address tokenB, bool stable) external view returns (address);
}
