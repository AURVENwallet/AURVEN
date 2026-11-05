pragma solidity 0.8.33;
import {KeyLabAccount} from "./KeyLabAccount.sol";

/// Experimental account for local testing and BSC testnet only.
contract BscTestAccount is KeyLabAccount {
    error UnsupportedNetwork(uint256 chainId);

    constructor(bytes16 seed, bytes16 root_) KeyLabAccount(seed, root_) {
        if (block.chainid != 97 && block.chainid != 31337) {
            revert UnsupportedNetwork(block.chainid);
        }
    }
}

