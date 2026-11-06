pragma solidity 0.8.33;
import {BrowserTransferTrial} from "../src/BrowserTransferTrial.sol";

interface TrialVm {
    function chainId(uint256 id) external;
    function deal(address account, uint256 balance) external;
    function expectRevert(bytes4 selector) external;
}

contract BrowserTransferTrialTest {
    TrialVm constant vm = TrialVm(address(uint160(uint256(keccak256("hevm cheat code")))));

    function invalidTrial(uint256 network, uint256 amount, uint64 deadline) private {
        vm.chainId(network);
        vm.deal(address(this), 2);
        vm.expectRevert(BrowserTransferTrial.InvalidTrial.selector);
        new BrowserTransferTrial{value: amount}(
            address(1), address(2), deadline, 0, 0, 0, 0, 0, 0, "", 0, 0, ""
        );
    }

    function testMainnetRejected() public {
        invalidTrial(56, 1, uint64(block.timestamp + 10));
    }

    function testRejectsTwoWei() public {
        invalidTrial(97, 2, uint64(block.timestamp + 10));
    }

    function testExpiredTrialRejected() public {
        invalidTrial(97, 1, 0);
    }
}
