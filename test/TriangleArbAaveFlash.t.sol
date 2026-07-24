// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import {Test} from "forge-std/Test.sol";
import {TriangleArbAaveFlash} from "../contracts/TriangleArbAaveFlash.sol";
import {TriangleArbBase} from "../contracts/TriangleArbBase.sol";
import {ISwapAdapter} from "../contracts/adapters/ISwapAdapter.sol";
import {MockAaveV3Pool, MockERC20, MockGoodAdapter} from "./mocks/TestMocks.sol";

contract TriangleArbAaveFlashTest is Test {
    TriangleArbAaveFlash arb;
    MockAaveV3Pool pool;
    MockERC20 weth;
    MockERC20 usdc;
    MockERC20 usdt;

    MockGoodAdapter adapterA;
    MockGoodAdapter adapterB;
    MockGoodAdapter adapterC;

    address owner = address(0xA11CE);
    address attacker = address(0xBAD);

    function setUp() public {
        weth = new MockERC20("WETH");
        usdc = new MockERC20("USDC");
        usdt = new MockERC20("USDT");
        pool = new MockAaveV3Pool(5); // 0.05%

        vm.prank(owner);
        arb = new TriangleArbAaveFlash(address(pool));

        adapterA = new MockGoodAdapter(0);
        adapterB = new MockGoodAdapter(0);
        adapterC = new MockGoodAdapter(0);

        weth.mint(address(pool), 100 ether);

        vm.startPrank(owner);
        arb.setAdapterAllowed(address(adapterA), true);
        arb.setAdapterAllowed(address(adapterB), true);
        arb.setAdapterAllowed(address(adapterC), true);
        vm.stopPrank();
    }

    function _hop(address tokenIn, address tokenOut) internal pure returns (ISwapAdapter.Hop[] memory hops) {
        hops = new ISwapAdapter.Hop[](1);
        hops[0] = ISwapAdapter.Hop(tokenIn, tokenOut, 0, "");
    }

    function _legs() internal view returns (TriangleArbBase.Leg[] memory legs) {
        legs = new TriangleArbBase.Leg[](3);
        legs[0] = TriangleArbBase.Leg(address(adapterA), _hop(address(weth), address(usdc)), 0);
        legs[1] = TriangleArbBase.Leg(address(adapterB), _hop(address(usdc), address(usdt)), 0);
        legs[2] = TriangleArbBase.Leg(address(adapterC), _hop(address(usdt), address(weth)), 0);
    }

    function test_flashSucceedsAndRepaysPremium() public {
        adapterC.setBonusOut(0.05 ether);
        TriangleArbBase.Leg[] memory legs = _legs();

        vm.prank(owner);
        uint256 profit = arb.executeTriangleFlash(legs, 1 ether, 0.01 ether, block.timestamp + 60);

        assertEq(profit, 0.0495 ether);
        assertEq(weth.balanceOf(address(arb)), profit);
        assertEq(weth.balanceOf(address(pool)), 100 ether + 0.0005 ether);
    }

    function test_flashRevertsWhenProfitDoesNotCoverPremium() public {
        TriangleArbBase.Leg[] memory legs = _legs();

        vm.prank(owner);
        vm.expectRevert("profit below threshold after premium");
        arb.executeTriangleFlash(legs, 1 ether, 0, block.timestamp + 60);
    }

    function test_flashRevertsIfNotOwner() public {
        TriangleArbBase.Leg[] memory legs = _legs();

        vm.prank(attacker);
        vm.expectRevert("not owner");
        arb.executeTriangleFlash(legs, 1 ether, 0, block.timestamp + 60);
    }

    function test_flashRevertsOnBlockedAdapter() public {
        adapterC.setBonusOut(0.05 ether);
        TriangleArbBase.Leg[] memory legs = _legs();

        vm.prank(owner);
        arb.setBlockedDuringFlashLoan(address(adapterB), true);

        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(TriangleArbAaveFlash.AdapterBlockedDuringFlashLoan.selector, address(adapterB), 1)
        );
        arb.executeTriangleFlash(legs, 1 ether, 0, block.timestamp + 60);
    }

    function test_executeOperationRejectsUntrustedLender() public {
        TriangleArbBase.Leg[] memory legs = _legs();
        bytes memory params = abi.encode(legs, uint256(0), address(weth), block.timestamp + 60);

        vm.prank(attacker);
        vm.expectRevert("untrusted lender");
        arb.executeOperation(address(weth), 1 ether, 0, address(arb), params);
    }

    function test_executeOperationRejectsUntrustedInitiator() public {
        TriangleArbBase.Leg[] memory legs = _legs();
        bytes memory params = abi.encode(legs, uint256(0), address(weth), block.timestamp + 60);

        vm.prank(address(pool));
        vm.expectRevert("untrusted initiator");
        arb.executeOperation(address(weth), 1 ether, 0, attacker, params);
    }
}
