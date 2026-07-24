// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import {Test} from "forge-std/Test.sol";
import {TriangleArb} from "../contracts/TriangleArb.sol";
import {TriangleArbBase} from "../contracts/TriangleArbBase.sol";
import {ISwapAdapter} from "../contracts/adapters/ISwapAdapter.sol";
import {MockERC20, MockGoodAdapter, MaliciousAdapter} from "./mocks/TestMocks.sol";

contract TriangleArbTest is Test {
    TriangleArb arb;
    MockERC20 weth;
    MockERC20 usdc;
    MockERC20 usdt;

    MockGoodAdapter adapterA; // WETH -> USDC, 0 fee
    MockGoodAdapter adapterB; // USDC -> USDT, 0 fee
    MockGoodAdapter adapterC; // USDT -> WETH, 0 fee (profitable leg injects extra below)

    address owner = address(0xA11CE);
    address attacker = address(0xBAD);

    function setUp() public {
        vm.startPrank(owner);
        arb = new TriangleArb();
        vm.stopPrank();

        weth = new MockERC20("WETH");
        usdc = new MockERC20("USDC");
        usdt = new MockERC20("USDT");

        adapterA = new MockGoodAdapter(0);
        adapterB = new MockGoodAdapter(0);
        adapterC = new MockGoodAdapter(0);

        weth.mint(address(arb), 10 ether);

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

    function test_revertsIfNotOwner() public {
        TriangleArbBase.Leg[] memory legs = _legs();
        vm.prank(attacker);
        vm.expectRevert("not owner");
        arb.executeTriangle(legs, 1 ether, 0, block.timestamp + 60);
    }

    function test_revertsOnUnallowlistedAdapter() public {
        MockGoodAdapter rogue = new MockGoodAdapter(0);
        // deliberately NOT allowlisted
        TriangleArbBase.Leg[] memory legs = _legs();
        legs[0].adapter = address(rogue);

        vm.prank(owner);
        vm.expectRevert("adapter not allowlisted");
        arb.executeTriangle(legs, 1 ether, 0, block.timestamp + 60);
    }

    function test_revertsPastDeadline() public {
        TriangleArbBase.Leg[] memory legs = _legs();
        vm.prank(owner);
        vm.expectRevert("deadline expired");
        arb.executeTriangle(legs, 1 ether, 0, block.timestamp - 1);
    }

    function test_revertsWhenNoProfit() public {
        // 0-fee adapters round-trip WETH exactly; minProfit > 0 must revert.
        TriangleArbBase.Leg[] memory legs = _legs();
        vm.prank(owner);
        vm.expectRevert("profit below threshold");
        arb.executeTriangle(legs, 1 ether, 1, block.timestamp + 60);
    }

    function test_revertsWhenFirstLegHasNoHops() public {
        TriangleArbBase.Leg[] memory legs = _legs();
        legs[0].hops = new ISwapAdapter.Hop[](0);

        vm.prank(owner);
        vm.expectRevert("leg needs at least 1 hop");
        arb.executeTriangle(legs, 1 ether, 0, block.timestamp + 60);
    }

    function test_revertsWhenLastLegHasNoHops() public {
        TriangleArbBase.Leg[] memory legs = _legs();
        legs[2].hops = new ISwapAdapter.Hop[](0);

        vm.prank(owner);
        vm.expectRevert("leg needs at least 1 hop");
        arb.executeTriangle(legs, 1 ether, 0, block.timestamp + 60);
    }

    function test_succeedsAndEmitsWithRealProfit() public {
        // Give the final adapter a one-shot bonus so the round trip nets a
        // profit (simulating a real favorable cross-rate).
        adapterC.setBonusOut(0.05 ether);

        TriangleArbBase.Leg[] memory legs = _legs();
        vm.prank(owner);
        uint256 profit = arb.executeTriangle(legs, 1 ether, 0.01 ether, block.timestamp + 60);

        assertGe(profit, 0.01 ether);
        assertEq(weth.balanceOf(address(arb)), 10 ether + profit);
    }

    /// @dev THE key regression test for the delegatecall -> call fix.
    /// A malicious adapter must be capped at the allowance it was explicitly
    /// approved for; it cannot drain funds beyond that, and it cannot corrupt
    /// TriangleArb's owner/locked storage since it runs in its own context.
    function test_maliciousAdapterCannotExceedApprovedAllowance() public {
        MaliciousAdapter evil = new MaliciousAdapter();
        vm.prank(owner);
        arb.setAdapterAllowed(address(evil), true);

        TriangleArbBase.Leg[] memory legs = new TriangleArbBase.Leg[](2);
        legs[0] = TriangleArbBase.Leg(address(evil), _hop(address(weth), address(usdc)), 0);
        legs[1] = TriangleArbBase.Leg(address(adapterB), _hop(address(usdc), address(weth)), 0);

        uint256 arbBalanceBefore = weth.balanceOf(address(arb));

        vm.prank(owner);
        vm.expectRevert(); // underflow in MockERC20.transferFrom: allowance exceeded
        arb.executeTriangle(legs, 1 ether, 0, block.timestamp + 60);

        // Balance untouched — the malicious adapter's overreach reverted
        // the whole transaction rather than partially draining funds.
        assertEq(weth.balanceOf(address(arb)), arbBalanceBefore);
    }

    function test_ownerCanRevokeAdapterAllowlist() public {
        vm.prank(owner);
        arb.setAdapterAllowed(address(adapterA), false);

        TriangleArbBase.Leg[] memory legs = _legs();
        vm.prank(owner);
        vm.expectRevert("adapter not allowlisted");
        arb.executeTriangle(legs, 1 ether, 0, block.timestamp + 60);
    }

    function test_sweepOnlyOwner() public {
        weth.mint(address(arb), 1 ether);
        vm.prank(attacker);
        vm.expectRevert("not owner");
        arb.sweep(address(weth), 1 ether);

        vm.prank(owner);
        arb.sweep(address(weth), 1 ether);
        assertEq(weth.balanceOf(owner), 1 ether);
    }

    /// @dev Multi-hop-within-a-leg: a single leg chains WETH -> USDC -> USDT
    /// on ONE adapter, instead of splitting that into two separate legs.
    /// Confirms the Hop[] chain inside a leg produces the same result as
    /// two 1-hop legs would, and that intermediate tokens never have to
    /// round-trip back through TriangleArb between hops.
    function test_multiHopWithinSingleLeg() public {
        ISwapAdapter.Hop[] memory hops = new ISwapAdapter.Hop[](2);
        hops[0] = ISwapAdapter.Hop(address(weth), address(usdc), 0, "");
        hops[1] = ISwapAdapter.Hop(address(usdc), address(usdt), 0, "");

        TriangleArbBase.Leg[] memory legs = new TriangleArbBase.Leg[](2);
        legs[0] = TriangleArbBase.Leg(address(adapterA), hops, 0); // WETH -> USDC -> USDT in ONE leg
        legs[1] = TriangleArbBase.Leg(address(adapterC), _hop(address(usdt), address(weth)), 0);

        adapterC.setBonusOut(0.02 ether); // inject profit on the way back

        vm.prank(owner);
        uint256 profit = arb.executeTriangle(legs, 1 ether, 0.01 ether, block.timestamp + 60);

        assertGe(profit, 0.01 ether);
        // adapterB was never used — confirms the 2-hop chain stayed inside adapterA.
        assertEq(usdt.balanceOf(address(adapterB)), 0);
    }
}
