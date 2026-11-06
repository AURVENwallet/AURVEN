pragma solidity 0.8.33;
import {BscTestAccount} from "./BscTestAccount.sol";

contract TestnetVaultSetup {
    error InvalidSetup();

    constructor(address expected, bytes16 seed, bytes16 root, bytes16 activeSeed, bytes16 activeRoot,
        uint64 deadline, uint32 salt, bytes16 randomizer, bytes memory proof) payable {
        if (block.chainid != 97 || msg.value != 3 || block.timestamp > deadline ||
            deadline > block.timestamp + 1 hours) revert InvalidSetup();
        BscTestAccount account = new BscTestAccount(seed, root);
        if (address(account) != expected) revert InvalidSetup();
        account.rekey(activeSeed, activeRoot, 8, deadline, salt, randomizer, proof);
        (bool funded,) = address(account).call{value: msg.value}("");
        if (!funded) revert InvalidSetup();
    }
}
