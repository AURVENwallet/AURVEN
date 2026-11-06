pragma solidity 0.8.33;

import {KeyLabFactory} from "../../src/KeyLabFactory.sol";
import {KeyLabAccount} from "../../src/KeyLabAccount.sol";

// Injected at a disposable fixture address only for eth_call. All state changes expire with the call.
contract MainnetScenario {
    function run(
        address expected, address payable recipient, bytes16 seed, bytes16 root,
        bytes calldata bootstrap, bytes calldata payment, bytes calldata rotation,
        bytes calldata successorPayment, bytes calldata wrongChain, bytes memory factoryInit
    ) external returns (bytes32, bytes32, uint32, uint32, uint256) {
        require(block.chainid == 56 && address(this).balance == 3 wei, "chain or balance");
        address deployed;
        assembly ("memory-safe") { deployed := create(0, add(factoryInit, 32), mload(factoryInit)) }
        require(deployed != address(0), "factory creation");
        KeyLabFactory factory = KeyLabFactory(deployed);
        require(factory.predict(seed, root) == expected && expected.code.length == 0, "factory prediction");
        KeyLabAccount account = KeyLabAccount(payable(factory.create(seed, root)));
        require(address(account) == expected && factory.create(seed, root) == expected, "idempotent create");
        _reject(expected, payment, KeyLabAccount.NeedsRekey.selector);
        _apply(expected, bootstrap);
        require(account.epoch() == 1 && account.next() == 0, "bootstrap state");
        (bool funded,) = expected.call{value: 3 wei}("");
        require(funded, "funding");
        uint256 beforePayment = recipient.balance;
        _reject(expected, wrongChain, KeyLabAccount.BadSignature.selector);
        _apply(expected, payment);
        require(account.next() == 1 && recipient.balance == beforePayment + 1, "first transfer");
        _reject(expected, payment, KeyLabAccount.LeafUsed.selector);
        _apply(expected, rotation);
        require(account.epoch() == 2 && account.next() == 0, "rotation state");
        _reject(expected, payment, KeyLabAccount.BadSignature.selector);
        _apply(expected, successorPayment);
        require(account.next() == 1 && expected.balance == 1 && recipient.balance == beforePayment + 2, "second transfer");
        return (address(factory).codehash, expected.codehash, account.epoch(), account.next(), expected.balance);
    }

    function _apply(address account, bytes calldata action) private {
        (bool ok, bytes memory result) = account.call(action);
        require(ok && result.length == 0, "call result");
    }

    function _reject(address account, bytes calldata action, bytes4 reason) private {
        (bool ok, bytes memory result) = account.call(action);
        require(!ok && result.length == 4 && bytes4(result) == reason, "rejection reason");
    }
}
