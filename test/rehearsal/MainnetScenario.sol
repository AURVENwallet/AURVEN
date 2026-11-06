pragma solidity 0.8.33;

import {KeyLabFactory} from "../../src/KeyLabFactory.sol";
import {BscMainnetFactory} from "../../src/BscMainnetFactory.sol";
import {KeyLabAccount} from "../../src/KeyLabAccount.sol";

// Injected at a disposable fixture address only for eth_call. All state changes expire with the call.
contract MainnetScenario {
    function run(
        address expected, address payable recipient, bytes16 seed, bytes16 root,
        bytes calldata bootstrap, bytes calldata payment, bytes calldata rotation,
        bytes calldata successorPayment, bytes calldata wrongChain, bytes memory factoryInit
    ) external returns (bytes32, bytes32, uint32, uint32, uint256) {
        require(block.chainid == 56 && address(this).balance == 3 wei, "chain or balance");
        KeyLabFactory factory = KeyLabFactory(_deploy(factoryInit));
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

    function runSetup(bytes memory factoryInit, address expected, address payable recipient, bytes16 seed, bytes16 root,
        bytes calldata activation, bytes calldata payment) external returns (bytes32, bytes32, uint32, uint32) {
        require(block.chainid == 56 && address(this).balance == 1 wei, "setup fixture");
        BscMainnetFactory factory = BscMainnetFactory(_deploy(factoryInit));
        require(expected.code.length == 0 && factory.predict(seed, root) == expected, "setup prediction");

        bytes memory corrupt = activation;
        corrupt[corrupt.length - 1] ^= 0x01;
        _reject(address(factory), corrupt, KeyLabAccount.BadSignature.selector);
        require(expected.code.length == 0, "partial creation persisted");

        (bool created, bytes memory result) = address(factory).call(activation);
        require(created && abi.decode(result, (address)) == expected, "atomic activation");
        KeyLabAccount account = KeyLabAccount(payable(expected));
        require(account.epoch() == 1 && account.next() == 0, "first key state");
        _reject(address(factory), activation, BscMainnetFactory.AlreadyCreated.selector);
        (bool funded,) = expected.call{value: 1 wei}("");
        require(funded, "setup funding");
        uint256 beforePayment = recipient.balance;
        _apply(expected, payment);
        require(account.next() == 1 && expected.balance == 0 && recipient.balance == beforePayment + 1, "setup payment");
        return (address(factory).codehash, expected.codehash, account.epoch(), account.next());
    }

    function _deploy(bytes memory init) private returns (address deployed) {
        assembly ("memory-safe") { deployed := create(0, add(init, 32), mload(init)) }
        require(deployed != address(0), "factory creation");
    }

    function _apply(address account, bytes calldata action) private {
        (bool ok, bytes memory result) = account.call(action);
        require(ok && result.length == 0, "call result");
    }

    function _reject(address account, bytes memory action, bytes4 reason) private {
        (bool ok, bytes memory result) = account.call(action);
        require(!ok && result.length == 4 && bytes4(result) == reason, "rejection reason");
    }
}
