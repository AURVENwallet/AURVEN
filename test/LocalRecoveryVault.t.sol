pragma solidity 0.8.33;

import {LocalRecoveryVault} from "./rehearsal/LocalRecoveryVault.sol";
import {KeyLabAccount} from "../src/KeyLabAccount.sol";
import {Asserts} from "./Harness.sol";

interface RecoveryVm {
    function store(address target, bytes32 slot, bytes32 value) external;
    function getNonce(address account) external view returns (uint64);
    function computeCreateAddress(address deployer, uint256 nonce) external pure returns (address);
}

contract LocalRecoveryVaultTest is Asserts {
    RecoveryVm constant state = RecoveryVm(address(vm));
    bytes32 constant code = keccak256("local recovery unit test");
    KeyLabAccount original;
    KeyLabAccount standby;
    LocalRecoveryVault holder;

    function setUp() public {
        vm.chainId(31337);
        original = new KeyLabAccount(bytes16(uint128(1)), bytes16(uint128(2)));
        standby = new KeyLabAccount(bytes16(uint128(3)), bytes16(uint128(4)));
        // Initialize the packed epoch/next slot for isolated enrollment tests. The Anvil drill signs both bootstraps.
        state.store(address(original), bytes32(uint256(1)), bytes32(uint256(1) << 32));
        state.store(address(standby), bytes32(uint256(1)), bytes32(uint256(1) << 32));
        address expected = state.computeCreateAddress(address(this), state.getNonce(address(this)));
        bytes32 commitment = keccak256(abi.encode(keccak256("aurven/local/standby-recovery/v1"),
            block.chainid, expected, original, standby, code));
        holder = new LocalRecoveryVault(original, standby, commitment);
        require(address(holder) == expected);
    }

    function testRejectsMainnetAndTestnet() public {
        vm.chainId(97);
        vm.expectRevert(LocalRecoveryVault.LocalOnly.selector);
        new LocalRecoveryVault(original, standby, code);
        vm.chainId(56);
        vm.expectRevert(LocalRecoveryVault.LocalOnly.selector);
        holder.recover(code);
        vm.expectRevert(LocalRecoveryVault.LocalOnly.selector);
        new LocalRecoveryVault(original, standby, code);
    }

    function testEnrollmentRequiresSeparateUnusedSignerAndCommitment() public {
        vm.expectRevert(LocalRecoveryVault.InvalidEnrollment.selector);
        new LocalRecoveryVault(original, standby, 0);
        vm.expectRevert(LocalRecoveryVault.InvalidEnrollment.selector);
        new LocalRecoveryVault(original, original, code);
        vm.expectRevert(LocalRecoveryVault.InvalidEnrollment.selector);
        new LocalRecoveryVault(original, KeyLabAccount(payable(address(1))), code);
        state.store(address(standby), bytes32(uint256(1)), bytes32((uint256(1) << 32) | 1));
        vm.expectRevert(LocalRecoveryVault.InvalidEnrollment.selector);
        new LocalRecoveryVault(original, standby, code);
    }

    function testChangedStandbyLeavesOriginalInControl() public {
        state.store(address(standby), bytes32(uint256(1)), bytes32(uint256(2) << 32));
        vm.expectRevert(LocalRecoveryVault.StandbyChanged.selector);
        holder.recover(code);
        require(holder.activeSigner() == address(original) && holder.commitment() != 0);
    }

    function testRecoveryIsBoundToHolderAndCannotBeReplayedOrRedirected() public {
        LocalRecoveryVault copy = new LocalRecoveryVault(original, standby, holder.commitment());
        vm.expectRevert(LocalRecoveryVault.InvalidCode.selector);
        copy.recover(code);
        vm.expectRevert(LocalRecoveryVault.InvalidCode.selector);
        holder.recover(bytes32(uint256(code) ^ 1));
        holder.recover(code);
        require(holder.activeSigner() == address(standby));
        vm.expectRevert(LocalRecoveryVault.AlreadyRecovered.selector);
        holder.recover(code);
        vm.expectRevert(LocalRecoveryVault.InactiveSigner.selector);
        holder.pay(payable(address(this)), 0);
    }
}
