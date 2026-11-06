pragma solidity 0.8.33;
import {TestnetVaultSetup} from "../src/TestnetVaultSetup.sol";

interface SetupVm {
    function chainId(uint256 id) external;
    function deal(address target, uint256 balance) external;
    function expectRevert(bytes4 error) external;
}

contract TestnetVaultSetupTest {
    SetupVm constant vm = SetupVm(address(uint160(uint256(keccak256("hevm cheat code")))));

    function expectInvalid(uint256 chain, uint256 amount, uint64 deadline) private {
        vm.chainId(chain);
        vm.deal(address(this), 4);
        vm.expectRevert(TestnetVaultSetup.InvalidSetup.selector);
        new TestnetVaultSetup{value: amount}(address(1), 0, 0, 0, 0, deadline, 0, 0, "");
    }

    function testSetupRejectsMainnet() public {
        expectInvalid(56, 3, uint64(block.timestamp + 30));
    }

    function testSetupRejectsExcessDeposit() public {
        expectInvalid(97, 4, uint64(block.timestamp + 30));
    }

    function testSetupRejectsExpiredRequest() public {
        expectInvalid(97, 3, 0);
    }
}
