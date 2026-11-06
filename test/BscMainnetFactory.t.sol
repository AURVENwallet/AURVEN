pragma solidity 0.8.33;

import {BscMainnetFactory} from "../src/BscMainnetFactory.sol";

interface MainnetVm {
    function chainId(uint256 id) external;
    function expectRevert(bytes4 selector) external;
    function warp(uint256 timestamp) external;
}

contract BscMainnetFactoryTest {
    MainnetVm constant vm = MainnetVm(address(uint160(uint256(keccak256("hevm cheat code")))));

    function testDeploymentRejectsTestnet() public {
        vm.chainId(97);
        vm.expectRevert(BscMainnetFactory.WrongChain.selector);
        new BscMainnetFactory();
    }

    function testSetupRejectsWrongNetworkAddressAndWindow() public {
        vm.chainId(56);
        vm.warp(10_000);
        BscMainnetFactory factory = new BscMainnetFactory();
        address expected = factory.predict(bytes16(uint128(1)), bytes16(uint128(2)));
        vm.expectRevert(BscMainnetFactory.InvalidAddress.selector);
        attempt(factory, address(1), 10_100);
        vm.expectRevert(BscMainnetFactory.InvalidWindow.selector);
        attempt(factory, expected, 9_999);
        vm.expectRevert(BscMainnetFactory.InvalidWindow.selector);
        attempt(factory, expected, 13_601);
        vm.chainId(97);
        vm.expectRevert(BscMainnetFactory.WrongChain.selector);
        attempt(factory, expected, 10_100);
        require(expected.code.length == 0);
    }

    function testFactoryHasNoSeparateCreationEntry() public {
        vm.chainId(56);
        BscMainnetFactory factory = new BscMainnetFactory();
        address expected = factory.predict(0, 0);
        (bool ok,) = address(factory).call(abi.encodeWithSignature("create(bytes16,bytes16)", bytes16(0), bytes16(0)));
        require(!ok && expected.code.length == 0);
    }

    function attempt(BscMainnetFactory factory, address expected, uint64 deadline) private {
        factory.createAndActivate(expected, bytes16(uint128(1)), bytes16(uint128(2)),
            bytes16(uint128(3)), bytes16(uint128(4)), deadline, 0, 0, "");
    }
}
