// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import {ISwapAdapter} from "../../contracts/adapters/ISwapAdapter.sol";
import {IAaveV3FlashLoanReceiver} from "../../contracts/interfaces/IAaveV3Flash.sol";
import {IERC20} from "../../contracts/interfaces/IERC20.sol";

/// @dev Minimal mintable ERC20 for test fixtures.
contract MockERC20 is IERC20 {
    string public name;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    constructor(string memory _name) {
        name = _name;
    }

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }
}

/// @dev A well-behaved mock adapter: converts each hop's tokenIn -> tokenOut
/// 1:1 minus a configurable bps fee, chaining hops internally, following the
/// multi-hop pull/push contract exactly (mints the final hop's tokenOut to
/// itself to simulate a real DEX producing output from its own liquidity).
contract MockGoodAdapter is ISwapAdapter {
    uint256 public feeBps;
    uint256 public bonusOut;

    constructor(uint256 _feeBps) {
        feeBps = _feeBps;
    }

    function setBonusOut(uint256 _bonusOut) external {
        bonusOut = _bonusOut;
    }

    function executeMultiHop(
        Hop[] calldata hops,
        uint256 amountIn,
        uint256 amountOutMin,
        uint256 /* deadline */
    ) external override returns (uint256 amountOut) {
        require(hops.length >= 1, "mock: empty hops");
        IERC20(hops[0].tokenIn).transferFrom(msg.sender, address(this), amountIn);

        uint256 currentAmount = amountIn;
        for (uint256 i = 0; i < hops.length; i++) {
            Hop calldata hop = hops[i];
            uint256 hopOut = currentAmount - (currentAmount * feeBps) / 10_000;
            require(hopOut >= hop.amountOutMin, "mock: hop below min");
            MockERC20(hop.tokenOut).mint(address(this), hopOut);
            currentAmount = hopOut;
        }

        amountOut = currentAmount + bonusOut;
        bonusOut = 0;
        require(amountOut >= amountOutMin, "mock: below min");
        if (amountOut > currentAmount) {
            MockERC20(hops[hops.length - 1].tokenOut).mint(address(this), amountOut - currentAmount);
        }
        IERC20(hops[hops.length - 1].tokenOut).transfer(msg.sender, amountOut);
    }
}

/// @dev A malicious adapter: instead of doing a fair swap, it tries to pull
/// far more than it was approved for from an arbitrary victim. Used to prove
/// the call-based model contains the blast radius of a bad adapter to its
/// approved allowance only.
contract MaliciousAdapter is ISwapAdapter {
    function executeMultiHop(
        Hop[] calldata hops,
        uint256 amountIn,
        uint256 /* amountOutMin */,
        uint256 /* deadline */
    ) external override returns (uint256) {
        // Try to pull more than approved — must revert, proving the adapter
        // is bounded by the exact allowance the caller granted for this leg.
        IERC20(hops[0].tokenIn).transferFrom(msg.sender, address(this), amountIn * 1000);
        return amountIn * 1000;
    }
}

contract MockAaveV3Pool {
    uint128 public premiumBps;

    constructor(uint128 _premiumBps) {
        premiumBps = _premiumBps;
    }

    function FLASHLOAN_PREMIUM_TOTAL() external view returns (uint128) {
        return premiumBps;
    }

    function flashLoanSimple(
        address receiverAddress,
        address asset,
        uint256 amount,
        bytes calldata params,
        uint16 /* referralCode */
    ) external {
        uint256 premium = (amount * premiumBps) / 10_000;
        IERC20(asset).transfer(receiverAddress, amount);
        bool ok = IAaveV3FlashLoanReceiver(receiverAddress).executeOperation(
            asset,
            amount,
            premium,
            receiverAddress,
            params
        );
        require(ok, "callback failed");
        IERC20(asset).transferFrom(receiverAddress, address(this), amount + premium);
    }
}
