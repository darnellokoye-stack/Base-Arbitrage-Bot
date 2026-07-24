// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import {Test} from "forge-std/Test.sol";
import {AerodromeAdapter} from "../contracts/adapters/AerodromeAdapter.sol";
import {ISwapAdapter} from "../contracts/adapters/ISwapAdapter.sol";
import {TriangleArb} from "../contracts/TriangleArb.sol";
import {TriangleArbAaveFlash} from "../contracts/TriangleArbAaveFlash.sol";
import {TriangleArbBase} from "../contracts/TriangleArbBase.sol";
import {UniswapV2Adapter} from "../contracts/adapters/UniswapV2Adapter.sol";
import {IERC20} from "../contracts/interfaces/IERC20.sol";
import {SafeTransfer} from "../contracts/libraries/SafeTransfer.sol";

interface IWETH is IERC20 {
    function deposit() external payable;
}

interface IAaveV3PoolPremium {
    function FLASHLOAN_PREMIUM_TOTAL() external view returns (uint128);
}

interface IAaveV3PoolReserveData {
    function getReserveData(address asset) external view;
}

contract FixedOutAdapter is ISwapAdapter {
    uint256 public nextAmountOut;

    function setNextAmountOut(uint256 amountOut) external {
        nextAmountOut = amountOut;
    }

    function executeMultiHop(
        Hop[] calldata hops,
        uint256 amountIn,
        uint256 amountOutMin,
        uint256 /* deadline */
    ) external returns (uint256 amountOut) {
        require(hops.length == 1, "fixed: one hop only");
        SafeTransfer.safeTransferFrom(hops[0].tokenIn, msg.sender, address(this), amountIn);

        amountOut = nextAmountOut;
        nextAmountOut = 0;
        require(amountOut >= amountOutMin, "fixed: below min");
        SafeTransfer.safeTransfer(hops[0].tokenOut, msg.sender, amountOut);
    }
}

contract AaveFlashProbe {
    address public immutable pool;

    constructor(address _pool) {
        pool = _pool;
    }

    function flash(address asset, uint256 amount) external {
        IAaveV3PoolForProbe(pool).flashLoanSimple(address(this), asset, amount, "", 0);
    }

    function executeOperation(
        address asset,
        uint256 amount,
        uint256 premium,
        address,
        bytes calldata
    ) external returns (bool) {
        require(msg.sender == pool, "probe: lender");
        IERC20(asset).approve(pool, amount + premium);
        return true;
    }
}

interface IAaveV3PoolForProbe {
    function flashLoanSimple(
        address receiverAddress,
        address asset,
        uint256 amount,
        bytes calldata params,
        uint16 referralCode
    ) external;
}

contract BaseForkAdaptersTest is Test {
    address constant WETH = 0x4200000000000000000000000000000000000006;
    address constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;

    address constant UNIV2_ROUTER = 0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24;
    address constant AERODROME_ROUTER = 0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43;
    address constant AERODROME_FACTORY = 0x420DD381b31aEf6683db6B902084cB0FFECe40Da;
    address constant AAVE_V3_POOL = 0xA238Dd80C259a72e81d7e4664a9801593F98d1c5;

    UniswapV2Adapter uniAdapter;
    AerodromeAdapter aeroAdapter;
    FixedOutAdapter fixedOutAdapter;

    function _aaveWethFlashAmount() internal returns (uint256) {
        (bool ok, bytes memory data) = AAVE_V3_POOL.staticcall(
            abi.encodeWithSelector(IAaveV3PoolReserveData.getReserveData.selector, WETH)
        );
        require(ok && data.length >= 288, "reserve data failed");

        uint256 configuration;
        address aTokenAddress;
        assembly {
            configuration := mload(add(data, 0x20))
            aTokenAddress := mload(add(data, 0x120))
        }

        bool active = ((configuration >> 56) & 1) == 1;
        bool frozen = ((configuration >> 57) & 1) == 1;
        bool paused = ((configuration >> 60) & 1) == 1;
        bool flashLoanEnabled = ((configuration >> 63) & 1) == 1;

        if (!active || frozen || paused || !flashLoanEnabled) {
            vm.skip(true);
        }

        uint256 poolBalance = IERC20(WETH).balanceOf(aTokenAddress);
        uint256 targetAmount = 0.00005 ether;
        uint256 minUsefulAmount = 0.00001 ether;

        if (poolBalance < minUsefulAmount * 2) {
            vm.skip(true);
        }

        uint256 halfPoolBalance = poolBalance / 2;
        return halfPoolBalance < targetAmount ? halfPoolBalance : targetAmount;
    }

    function setUp() public {
        if (block.chainid != 8453) {
            vm.skip(true);
        }

        uniAdapter = new UniswapV2Adapter(UNIV2_ROUTER);
        aeroAdapter = new AerodromeAdapter(AERODROME_ROUTER);
        fixedOutAdapter = new FixedOutAdapter();

        vm.deal(address(this), 1 ether);
        IWETH(WETH).deposit{value: 0.02 ether}();
    }

    function test_uniswapV2AdapterSwapsRealWethToUsdcOnBaseFork() public {
        uint256 amountIn = 0.001 ether;
        ISwapAdapter.Hop[] memory hops = new ISwapAdapter.Hop[](1);
        hops[0] = ISwapAdapter.Hop(WETH, USDC, 0, "");

        IERC20(WETH).approve(address(uniAdapter), amountIn);
        uint256 usdcBefore = IERC20(USDC).balanceOf(address(this));

        uint256 amountOut = uniAdapter.executeMultiHop(hops, amountIn, 1, block.timestamp + 300);

        assertGt(amountOut, 0);
        assertEq(IERC20(USDC).balanceOf(address(this)) - usdcBefore, amountOut);
    }

    function test_aerodromeAdapterSwapsRealUsdcToWethOnBaseFork() public {
        uint256 amountIn = 0.001 ether;
        ISwapAdapter.Hop[] memory uniHops = new ISwapAdapter.Hop[](1);
        uniHops[0] = ISwapAdapter.Hop(WETH, USDC, 0, "");

        IERC20(WETH).approve(address(uniAdapter), amountIn);
        uint256 usdcOut = uniAdapter.executeMultiHop(uniHops, amountIn, 1, block.timestamp + 300);
        assertGt(usdcOut, 0);

        ISwapAdapter.Hop[] memory aeroHops = new ISwapAdapter.Hop[](1);
        aeroHops[0] = ISwapAdapter.Hop(
            USDC,
            WETH,
            0,
            abi.encode(false, AERODROME_FACTORY)
        );

        IERC20(USDC).approve(address(aeroAdapter), usdcOut);
        uint256 wethBefore = IERC20(WETH).balanceOf(address(this));

        uint256 wethOut = aeroAdapter.executeMultiHop(aeroHops, usdcOut, 1, block.timestamp + 300);

        assertGt(wethOut, 0);
        assertEq(IERC20(WETH).balanceOf(address(this)) - wethBefore, wethOut);
    }

    function test_triangleArbExecutesFullLegChainWithRealUniswapFirstLegOnBaseFork() public {
        uint256 amountIn = 0.001 ether;
        uint256 minProfit = 0.00001 ether;

        TriangleArb arb = new TriangleArb();
        arb.setAdapterAllowed(address(uniAdapter), true);
        arb.setAdapterAllowed(address(fixedOutAdapter), true);

        IERC20(WETH).transfer(address(arb), amountIn);
        IWETH(WETH).deposit{value: amountIn + minProfit}();
        IERC20(WETH).transfer(address(fixedOutAdapter), amountIn + minProfit);
        fixedOutAdapter.setNextAmountOut(amountIn + minProfit);

        TriangleArbBase.Leg[] memory legs = new TriangleArbBase.Leg[](2);

        ISwapAdapter.Hop[] memory uniHops = new ISwapAdapter.Hop[](1);
        uniHops[0] = ISwapAdapter.Hop(WETH, USDC, 0, "");
        legs[0] = TriangleArbBase.Leg(address(uniAdapter), uniHops, 1);

        ISwapAdapter.Hop[] memory fixedHops = new ISwapAdapter.Hop[](1);
        fixedHops[0] = ISwapAdapter.Hop(USDC, WETH, 0, "");
        legs[1] = TriangleArbBase.Leg(address(fixedOutAdapter), fixedHops, amountIn + minProfit);

        uint256 profit = arb.executeTriangle(legs, amountIn, minProfit, block.timestamp + 60);

        assertEq(profit, minProfit);
        assertEq(IERC20(WETH).balanceOf(address(arb)), amountIn + minProfit);
    }

    function test_aaveBareWethFlashLoanWorksOnBaseFork() public {
        uint256 amountIn = _aaveWethFlashAmount();
        uint256 premium = (amountIn * IAaveV3PoolPremium(AAVE_V3_POOL).FLASHLOAN_PREMIUM_TOTAL()) / 10_000;
        AaveFlashProbe probe = new AaveFlashProbe(AAVE_V3_POOL);

        IERC20(WETH).transfer(address(probe), premium);

        probe.flash(WETH, amountIn);

        assertEq(IERC20(WETH).balanceOf(address(probe)), 0);
    }

    function test_aaveFlashTriangleExecutesOnBaseForkWithLivePool() public {
        uint256 amountIn = _aaveWethFlashAmount();
        uint256 minProfit = 0.00001 ether;
        uint256 premium = (amountIn * IAaveV3PoolPremium(AAVE_V3_POOL).FLASHLOAN_PREMIUM_TOTAL()) / 10_000;

        TriangleArbAaveFlash arb = new TriangleArbAaveFlash(AAVE_V3_POOL);
        arb.setAdapterAllowed(address(uniAdapter), true);
        arb.setAdapterAllowed(address(fixedOutAdapter), true);

        IWETH(WETH).deposit{value: amountIn + premium + minProfit}();
        IERC20(WETH).transfer(address(fixedOutAdapter), amountIn + premium + minProfit);
        fixedOutAdapter.setNextAmountOut(amountIn + premium + minProfit);

        TriangleArbBase.Leg[] memory legs = new TriangleArbBase.Leg[](2);

        ISwapAdapter.Hop[] memory uniHops = new ISwapAdapter.Hop[](1);
        uniHops[0] = ISwapAdapter.Hop(WETH, USDC, 0, "");
        legs[0] = TriangleArbBase.Leg(address(uniAdapter), uniHops, 1);

        ISwapAdapter.Hop[] memory fixedHops = new ISwapAdapter.Hop[](1);
        fixedHops[0] = ISwapAdapter.Hop(USDC, WETH, 0, "");
        legs[1] = TriangleArbBase.Leg(address(fixedOutAdapter), fixedHops, amountIn + premium + minProfit);

        uint256 profit = arb.executeTriangleFlash(legs, amountIn, minProfit, block.timestamp + 60);

        assertEq(profit, minProfit);
        assertEq(IERC20(WETH).balanceOf(address(arb)), minProfit);
        assertEq(IERC20(WETH).balanceOf(address(fixedOutAdapter)), 0);
    }

    function test_aaveFlashCanRouteThroughAerodromeBeforeProfitGuardOnBaseFork() public {
        uint256 amountIn = _aaveWethFlashAmount();

        TriangleArbAaveFlash arb = new TriangleArbAaveFlash(AAVE_V3_POOL);
        arb.setAdapterAllowed(address(uniAdapter), true);
        arb.setAdapterAllowed(address(aeroAdapter), true);

        TriangleArbBase.Leg[] memory legs = new TriangleArbBase.Leg[](2);

        ISwapAdapter.Hop[] memory uniHops = new ISwapAdapter.Hop[](1);
        uniHops[0] = ISwapAdapter.Hop(WETH, USDC, 0, "");
        legs[0] = TriangleArbBase.Leg(address(uniAdapter), uniHops, 1);

        ISwapAdapter.Hop[] memory aeroHops = new ISwapAdapter.Hop[](1);
        aeroHops[0] = ISwapAdapter.Hop(
            USDC,
            WETH,
            0,
            abi.encode(false, AERODROME_FACTORY)
        );
        legs[1] = TriangleArbBase.Leg(address(aeroAdapter), aeroHops, 1);

        vm.expectRevert("profit below threshold after premium");
        arb.executeTriangleFlash(legs, amountIn, 0, block.timestamp + 60);
    }
}
