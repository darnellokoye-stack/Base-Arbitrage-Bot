// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

/// @notice Minimal safe-transfer helper. Some tokens (e.g. USDT) don't return
/// a bool from transfer/approve, so we can't rely on IERC20's return value alone.
library SafeTransfer {
    function safeApprove(address token, address spender, uint256 amount) internal {
        // Some tokens (USDT) require allowance to be reset to 0 before changing it.
        (bool ok0, bytes memory data0) = token.call(
            abi.encodeWithSelector(bytes4(keccak256("approve(address,uint256)")), spender, 0)
        );
        require(ok0 && (data0.length == 0 || abi.decode(data0, (bool))), "approve-reset-failed");

        (bool ok1, bytes memory data1) = token.call(
            abi.encodeWithSelector(bytes4(keccak256("approve(address,uint256)")), spender, amount)
        );
        require(ok1 && (data1.length == 0 || abi.decode(data1, (bool))), "approve-failed");
    }

    function safeTransfer(address token, address to, uint256 amount) internal {
        (bool ok, bytes memory data) = token.call(
            abi.encodeWithSelector(bytes4(keccak256("transfer(address,uint256)")), to, amount)
        );
        require(ok && (data.length == 0 || abi.decode(data, (bool))), "transfer-failed");
    }

    function safeTransferFrom(address token, address from, address to, uint256 amount) internal {
        (bool ok, bytes memory data) = token.call(
            abi.encodeWithSelector(bytes4(keccak256("transferFrom(address,address,uint256)")), from, to, amount)
        );
        require(ok && (data.length == 0 || abi.decode(data, (bool))), "transferFrom-failed");
    }
}
