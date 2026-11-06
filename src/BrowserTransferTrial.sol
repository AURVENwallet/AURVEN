pragma solidity 0.8.33;

import {BscTestAccount} from "./BscTestAccount.sol";
import {KeyLabAccount} from "./KeyLabAccount.sol";

/// Disposable BSC testnet exercise. The entire one-wei transfer succeeds or reverts together.
contract BrowserTransferTrial {
    error InvalidTrial();
    event TrialCompleted(address indexed account, address indexed payer, address indexed recipient);

    constructor(
        address expectedAccount, address recipient, uint64 deadline,
        bytes16 identitySeed, bytes16 identityRoot, bytes16 activeSeed, bytes16 activeRoot,
        uint32 activationSalt, bytes16 activationRnd, bytes memory activationProof,
        uint32 transferSalt, bytes16 transferRnd, bytes memory transferProof
    ) payable {
        if (block.chainid != 97 || msg.value != 1 || recipient == address(0)
            || block.timestamp > deadline || deadline > block.timestamp + 1 hours) revert InvalidTrial();
        BscTestAccount account = new BscTestAccount(identitySeed, identityRoot);
        if (address(account) != expectedAccount || recipient == address(account) || recipient == address(this)) revert InvalidTrial();
        account.rekey(activeSeed, activeRoot, 8, deadline, activationSalt, activationRnd, activationProof);
        (bool funded,) = address(account).call{value: 1}("");
        if (!funded) revert InvalidTrial();
        KeyLabAccount.Call[] memory calls = new KeyLabAccount.Call[](1);
        calls[0] = KeyLabAccount.Call(recipient, 1, "");
        account.execute(calls, 0, deadline, transferSalt, transferRnd, transferProof);
        emit TrialCompleted(address(account), msg.sender, recipient);
    }
}
