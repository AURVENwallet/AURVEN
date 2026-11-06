pragma solidity 0.8.33;

import {KeyLabAccount} from "../../src/KeyLabAccount.sol";

// Local recovery experiment. Only this holder's native balance follows its signer.
contract LocalRecoveryVault {
    bytes32 public constant RECOVERY_TAG = keccak256("aurven/local/standby-recovery/v1");
    address public activeSigner;
    address public immutable standbySigner;
    bytes16 public immutable standbySeed;
    bytes16 public immutable standbyRoot;
    bytes32 public commitment;

    error LocalOnly();
    error InvalidEnrollment();
    error InvalidCode();
    error AlreadyRecovered();
    error StandbyChanged();
    error InactiveSigner();
    error PaymentFailed();

    event Recovered(address indexed original, address indexed standby);

    constructor(KeyLabAccount original, KeyLabAccount standby, bytes32 codeCommitment) {
        if (block.chainid != 31337) revert LocalOnly();
        bytes32 pin = keccak256(type(KeyLabAccount).runtimeCode);
        if (codeCommitment == 0 || address(original).codehash != pin || address(standby).codehash != pin ||
            original.epoch() == 0 || standby.epoch() != 1 || standby.next() != 0 || original.root() == standby.root())
            revert InvalidEnrollment();

        activeSigner = address(original);
        standbySigner = address(standby);
        standbySeed = standby.pubSeed();
        standbyRoot = standby.root();
        commitment = codeCommitment;
    }

    receive() external payable {}

    function recover(bytes32 code) external {
        if (block.chainid != 31337) revert LocalOnly();
        if (commitment == 0) revert AlreadyRecovered();
        address original = activeSigner;
        if (keccak256(abi.encode(RECOVERY_TAG, block.chainid, address(this), original, standbySigner, code)) != commitment)
            revert InvalidCode();
        KeyLabAccount standby = KeyLabAccount(payable(standbySigner));
        if (standby.epoch() != 1 || standby.next() != 0 || standby.pubSeed() != standbySeed || standby.root() != standbyRoot)
            revert StandbyChanged();

        commitment = 0;
        activeSigner = standbySigner;
        emit Recovered(original, standbySigner);
    }

    function pay(address payable recipient, uint256 amount) external {
        if (block.chainid != 31337) revert LocalOnly();
        if (msg.sender != activeSigner) revert InactiveSigner();
        (bool ok,) = recipient.call{value: amount}("");
        if (!ok) revert PaymentFailed();
    }
}
