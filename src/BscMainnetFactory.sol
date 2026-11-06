pragma solidity 0.8.33;

import {KeyLabAccount} from "./KeyLabAccount.sol";

contract BscMainnetFactory {
    uint32 public constant BOOTSTRAP_LEAF = 9;

    error WrongChain();
    error InvalidWindow();
    error InvalidAddress();
    error AlreadyCreated();

    event Activated(address indexed account, bytes16 identityRoot, bytes16 activeRoot);

    constructor() {
        if (block.chainid != 56) revert WrongChain();
    }

    // Use the client's existing CREATE2 address formula with this factory's own address.
    function _salt(bytes16 seed, bytes16 root) private pure returns (bytes32) {
        return keccak256(abi.encode("keylab/evm/id/v1", seed, root));
    }

    function predict(bytes16 seed, bytes16 root) public view returns (address) {
        bytes32 initHash = keccak256(abi.encodePacked(type(KeyLabAccount).creationCode, abi.encode(seed, root)));
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), _salt(seed, root), initHash)))));
    }

    function createAndActivate(
        address expected, bytes16 seed, bytes16 root, bytes16 activeSeed, bytes16 activeRoot,
        uint64 deadline, uint32 salt, bytes16 randomizer, bytes calldata proof
    ) external returns (address) {
        if (block.chainid != 56) revert WrongChain();
        if (deadline < block.timestamp || deadline > block.timestamp + 1 hours) revert InvalidWindow();
        if (predict(seed, root) != expected) revert InvalidAddress();
        if (expected.code.length != 0) revert AlreadyCreated();

        KeyLabAccount account = new KeyLabAccount{salt: _salt(seed, root)}(seed, root);
        // A failed rekey reverts CREATE2 as part of this same transaction.
        account.rekey(activeSeed, activeRoot, BOOTSTRAP_LEAF, deadline, salt, randomizer, proof);
        emit Activated(address(account), root, activeRoot);
        return address(account);
    }
}
