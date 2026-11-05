pragma solidity 0.8.33;

import {Asserts, MockToken} from "./Harness.sol";
import {Signer} from "./Signer.sol";
import {KeyLabAccount} from "../src/KeyLabAccount.sol";
import {KeyLabFactory} from "../src/KeyLabFactory.sol";
import {KeyLabMultisig} from "../src/KeyLabMultisig.sol";
import {KeyLabMultisigFactory} from "../src/KeyLabMultisigFactory.sol";

contract KeyLabMultisigTest is Asserts {
    KeyLabFactory factory;
    KeyLabMultisigFactory msFactory;
    KeyLabAccount[3] acc;
    Signer[3] keys;
    uint32[3] nextLeaf;
    KeyLabMultisig vault;
    address bob = address(0xB0B);
    bytes16 constant RND = bytes16(keccak256("rnd"));

    function setUp() public {
        vm.warp(1_800_000_000);
        factory = new KeyLabFactory();
        msFactory = new KeyLabMultisigFactory();
        for (uint256 i; i < 3; ++i) {
            Signer id = new Signer(keccak256(abi.encode("words", i)), bytes16(keccak256(abi.encode("seed", i))), 1);
            acc[i] = KeyLabAccount(payable(factory.create(id.pubSeed(), id.root())));
            keys[i] = new Signer(keccak256(abi.encode("chain", i)), bytes16(keccak256(abi.encode("chain seed", i))), 8);
            uint64 deadline = uint64(block.timestamp + 600);
            bytes16 digest = acc[i].rekeyDigest(keys[i].pubSeed(), keys[i].root(), 0, deadline, 0, RND);
            acc[i].rekey(keys[i].pubSeed(), keys[i].root(), 0, deadline, 0, RND, id.sign(0, digest));
            vm.deal(address(acc[i]), 1 ether);
        }
        address[] memory owners = _owners();
        _as(0, address(msFactory), abi.encodeCall(KeyLabMultisigFactory.create, (owners, 2, bytes32(0))), "create 2-of-3 vault");
        vault = KeyLabMultisig(payable(msFactory.predict(owners, 2, bytes32(0))));
        assertTrue(address(vault).code.length > 0, "vault deployed at predicted address");
        vm.deal(address(vault), 5 ether);
    }

    function _owners() internal view returns (address[] memory o) {
        o = new address[](3);
        for (uint256 i; i < 3; ++i) o[i] = address(acc[i]);
    }

    function digestOf(KeyLabAccount a, KeyLabAccount.Call[] calldata calls, uint32 leaf, uint64 deadline)
        external
        view
        returns (bytes16)
    {
        return a.execDigest(calls, leaf, deadline, 0, RND);
    }

    function _as(uint256 who, address to, bytes memory data, string memory label) internal {
        KeyLabAccount.Call[] memory calls = new KeyLabAccount.Call[](1);
        calls[0] = KeyLabAccount.Call({to: to, value: 0, data: data});
        uint32 leaf = nextLeaf[who]++;
        uint64 deadline = uint64(block.timestamp + 600);
        bytes memory proof = keys[who].sign(leaf, this.digestOf(acc[who], calls, leaf, deadline));
        uint256 g = gasleft();
        acc[who].execute(calls, leaf, deadline, 0, RND, proof);
        if (bytes(label).length > 0) emit Gas(label, g - gasleft());
    }

    function _try(uint256 who, address to, bytes memory data) internal returns (bool ok, bytes memory ret) {
        KeyLabAccount.Call[] memory calls = new KeyLabAccount.Call[](1);
        calls[0] = KeyLabAccount.Call({to: to, value: 0, data: data});
        uint32 leaf = nextLeaf[who];
        uint64 deadline = uint64(block.timestamp + 600);
        bytes memory proof = keys[who].sign(leaf, this.digestOf(acc[who], calls, leaf, deadline));
        (ok, ret) = address(acc[who]).call(abi.encodeCall(KeyLabAccount.execute, (calls, leaf, deadline, 0, RND, proof)));
    }

    function _pay(address to, uint256 amount) internal pure returns (KeyLabMultisig.Call[] memory c) {
        c = new KeyLabMultisig.Call[](1);
        c[0] = KeyLabMultisig.Call({to: to, value: amount, data: ""});
    }

    function _propose(uint256 who, KeyLabMultisig.Call[] memory c) internal returns (uint256 id) {
        id = vault.proposalCount();
        _as(who, address(vault), abi.encodeCall(KeyLabMultisig.propose, (c, uint64(block.timestamp + 1 days))), "propose");
    }

    function _hash(uint256 id) internal view returns (bytes32 h) {
        (KeyLabMultisig.Proposal memory p, , , ) = vault.getProposal(id);
        h = p.callsHash;
    }

    function _innerError(bytes memory ret) internal pure returns (bytes4 sel) {
        if (ret.length < 4 + 32 * 3) return bytes4(0);
        bytes memory inner;
        assembly {
            inner := add(ret, 100)
        }
        if (inner.length < 4) return bytes4(0);
        assembly {
            sel := mload(add(inner, 32))
        }
    }

    function testVaultSetup() public view {
        assertEq(vault.threshold(), 2, "threshold");
        assertEq(vault.getOwners().length, 3, "owners");
        for (uint256 i; i < 3; ++i) assertTrue(vault.isOwner(address(acc[i])), "owner registered");
        assertTrue(address(acc[0]).codehash == vault.ACCOUNT_CODEHASH(), "owner code is an Key Lab account");
        assertTrue(keccak256(type(KeyLabAccount).runtimeCode) == vault.ACCOUNT_CODEHASH(), "pinned fingerprint equals the compiled account code");
    }

    function testTwoOfThreePays() public {
        uint256 id = _propose(0, _pay(bob, 1 ether));
        (, , uint256 n, bool live) = vault.getProposal(id);
        assertEq(n, 1, "proposer approval counts");
        assertTrue(live, "live after propose");
        _as(1, address(vault), abi.encodeCall(KeyLabMultisig.approve, (id, _hash(id))), "approve");
        _as(1, address(vault), abi.encodeCall(KeyLabMultisig.execute, (id, _pay(bob, 1 ether))), "execute 1 ETH transfer");
        assertEq(bob.balance, 1 ether, "bob paid");
        assertEq(address(vault).balance, 4 ether, "vault debited");
        (KeyLabMultisig.Proposal memory p, , , bool live2) = vault.getProposal(id);
        assertTrue(p.executed && !live2, "marked executed");
    }

    function testOneApprovalIsNotEnough() public {
        uint256 id = _propose(0, _pay(bob, 1 ether));
        (bool ok, bytes memory ret) = _try(0, address(vault), abi.encodeCall(KeyLabMultisig.execute, (id, _pay(bob, 1 ether))));
        assertTrue(!ok && _innerError(ret) == KeyLabMultisig.NotEnoughApprovals.selector, "needs two approvals");
        assertEq(bob.balance, 0, "nothing paid");
    }

    function testExecuteTwiceFails() public {
        uint256 id = _propose(0, _pay(bob, 1 ether));
        _as(1, address(vault), abi.encodeCall(KeyLabMultisig.approve, (id, _hash(id))), "");
        _as(1, address(vault), abi.encodeCall(KeyLabMultisig.execute, (id, _pay(bob, 1 ether))), "");
        (bool ok, bytes memory ret) = _try(2, address(vault), abi.encodeCall(KeyLabMultisig.execute, (id, _pay(bob, 1 ether))));
        assertTrue(!ok && _innerError(ret) == KeyLabMultisig.NotLive.selector, "replay refused");
        assertEq(bob.balance, 1 ether, "paid once");
    }

    function testCallsMustMatchProposal() public {
        uint256 id = _propose(0, _pay(bob, 1 ether));
        _as(1, address(vault), abi.encodeCall(KeyLabMultisig.approve, (id, _hash(id))), "");
        (bool ok, bytes memory ret) = _try(1, address(vault), abi.encodeCall(KeyLabMultisig.execute, (id, _pay(bob, 5 ether))));
        assertTrue(!ok && _innerError(ret) == KeyLabMultisig.CallsMismatch.selector, "different calls refused");
    }

    function testOutsidersAndEoasAreRefused() public {
        uint256 id = _propose(0, _pay(bob, 1 ether));
        vm.prank(bob);
        vm.expectRevert(KeyLabMultisig.NotOwner.selector);
        vault.approve(id, bytes32(0));
        vm.prank(bob);
        vm.expectRevert(KeyLabMultisig.NotOwner.selector);
        vault.propose(_pay(bob, 1 ether), uint64(block.timestamp + 1 days));
        vm.expectRevert(KeyLabMultisig.NotSelf.selector);
        vault.setThreshold(1);
    }

    function testOwnersMustBeKeyLabAccounts() public {
        address[] memory o = _owners();
        o[2] = bob;
        vm.expectRevert(abi.encodeWithSelector(KeyLabMultisig.NotKeyLabAccount.selector, bob));
        new KeyLabMultisig(o, 2);
        o[2] = address(vault);
        vm.expectRevert(abi.encodeWithSelector(KeyLabMultisig.NotKeyLabAccount.selector, address(vault)));
        new KeyLabMultisig(o, 2);
        o = _owners();
        o[2] = o[0];
        vm.expectRevert(abi.encodeWithSelector(KeyLabMultisig.DuplicateOwner.selector, o[0]));
        new KeyLabMultisig(o, 2);
        vm.expectRevert(KeyLabMultisig.BadThreshold.selector);
        new KeyLabMultisig(_owners(), 4);
        vm.expectRevert(KeyLabMultisig.BadThreshold.selector);
        new KeyLabMultisig(_owners(), 0);
        vm.expectRevert(KeyLabMultisig.BadOwnerCount.selector);
        new KeyLabMultisig(new address[](0), 1);
    }

    function testRevokeDropsApproval() public {
        uint256 id = _propose(0, _pay(bob, 1 ether));
        _as(1, address(vault), abi.encodeCall(KeyLabMultisig.approve, (id, _hash(id))), "");
        _as(1, address(vault), abi.encodeCall(KeyLabMultisig.revoke, (id, _hash(id))), "revoke");
        assertEq(vault.approvalCount(id), 1, "back to one");
        (bool ok, bytes memory ret) = _try(0, address(vault), abi.encodeCall(KeyLabMultisig.execute, (id, _pay(bob, 1 ether))));
        assertTrue(!ok && _innerError(ret) == KeyLabMultisig.NotEnoughApprovals.selector, "revoked approval does not count");
    }

    function testProposerCanCancel() public {
        uint256 id = _propose(0, _pay(bob, 1 ether));
        (bool ok, bytes memory ret) = _try(1, address(vault), abi.encodeCall(KeyLabMultisig.cancel, (id)));
        assertTrue(!ok && _innerError(ret) == KeyLabMultisig.NotProposer.selector, "only the proposer cancels");
        _as(0, address(vault), abi.encodeCall(KeyLabMultisig.cancel, (id)), "cancel");
        (ok, ret) = _try(1, address(vault), abi.encodeCall(KeyLabMultisig.approve, (id, _hash(id))));
        assertTrue(!ok && _innerError(ret) == KeyLabMultisig.NotLive.selector, "cancelled proposal is dead");
    }

    function testExpiredProposalIsDead() public {
        uint256 id = _propose(0, _pay(bob, 1 ether));
        _as(1, address(vault), abi.encodeCall(KeyLabMultisig.approve, (id, _hash(id))), "");
        vm.warp(block.timestamp + 1 days + 1);
        (bool ok, bytes memory ret) = _try(1, address(vault), abi.encodeCall(KeyLabMultisig.execute, (id, _pay(bob, 1 ether))));
        assertTrue(!ok && _innerError(ret) == KeyLabMultisig.NotLive.selector, "expired");
        (ok, ret) = _try(0, address(vault), abi.encodeCall(KeyLabMultisig.propose, (_pay(bob, 1), uint64(block.timestamp + 31 days))));
        assertTrue(!ok && _innerError(ret) == KeyLabMultisig.BadExpiry.selector, "lifetime capped at 30 days");
    }

    function testOwnerChangeKillsPendingProposals() public {
        uint256 pay = _propose(0, _pay(bob, 1 ether));
        _as(1, address(vault), abi.encodeCall(KeyLabMultisig.approve, (pay, _hash(pay))), "");
        address[] memory two = new address[](2);
        two[0] = address(acc[0]);
        two[1] = address(acc[1]);
        KeyLabMultisig.Call[] memory c = new KeyLabMultisig.Call[](1);
        c[0] = KeyLabMultisig.Call({to: address(vault), value: 0, data: abi.encodeCall(KeyLabMultisig.setOwners, (two, 2))});
        uint256 change = _propose(0, c);
        _as(1, address(vault), abi.encodeCall(KeyLabMultisig.approve, (change, _hash(change))), "");
        _as(1, address(vault), abi.encodeCall(KeyLabMultisig.execute, (change, c)), "execute owner change");
        assertTrue(!vault.isOwner(address(acc[2])), "owner removed");
        assertEq(vault.getOwners().length, 2, "two owners left");
        (bool ok, bytes memory ret) = _try(1, address(vault), abi.encodeCall(KeyLabMultisig.execute, (pay, _pay(bob, 1 ether))));
        assertTrue(!ok && _innerError(ret) == KeyLabMultisig.NotLive.selector, "approvals from the old owner set are void");
        (ok, ret) = _try(2, address(vault), abi.encodeCall(KeyLabMultisig.propose, (_pay(bob, 1), uint64(block.timestamp + 1 days))));
        assertTrue(!ok && _innerError(ret) == KeyLabMultisig.NotOwner.selector, "removed owner locked out");
    }

    function testRevertedCallLeavesProposalExecutable() public {
        KeyLabMultisig.Call[] memory c = _pay(bob, 50 ether);
        uint256 id = _propose(0, c);
        _as(1, address(vault), abi.encodeCall(KeyLabMultisig.approve, (id, _hash(id))), "");
        (bool ok, bytes memory ret) = _try(1, address(vault), abi.encodeCall(KeyLabMultisig.execute, (id, c)));
        assertTrue(!ok && _innerError(ret) == KeyLabMultisig.CallFailed.selector, "call fails without funds");
        (KeyLabMultisig.Proposal memory p, , , bool live) = vault.getProposal(id);
        assertTrue(!p.executed && live, "still pending after a failed run");
        vm.deal(address(vault), 60 ether);
        _as(1, address(vault), abi.encodeCall(KeyLabMultisig.execute, (id, c)), "");
        assertEq(bob.balance, 50 ether, "paid once funded");
    }

    function testTokenTransfer() public {
        MockToken t = new MockToken();
        t.mint(address(vault), 1000);
        KeyLabMultisig.Call[] memory c = new KeyLabMultisig.Call[](1);
        c[0] = KeyLabMultisig.Call({to: address(t), value: 0, data: abi.encodeCall(MockToken.transfer, (bob, 400))});
        uint256 id = _propose(2, c);
        _as(0, address(vault), abi.encodeCall(KeyLabMultisig.approve, (id, _hash(id))), "");
        _as(0, address(vault), abi.encodeCall(KeyLabMultisig.execute, (id, c)), "execute token transfer");
        assertEq(t.balanceOf(bob), 400, "token sent");
    }

    function testFrontRunCreateGivesTheSameVault() public {
        address[] memory owners = _owners();
        address want = msFactory.predict(owners, 2, bytes32(uint256(7)));
        vm.prank(bob);
        address got = msFactory.create(owners, 2, bytes32(uint256(7)));
        assertTrue(got == want, "anyone deploying the same config lands on the same address");
        KeyLabMultisig v = KeyLabMultisig(payable(got));
        assertTrue(v.threshold() == 2, "threshold fixed by the address");
        for (uint256 i = 0; i < owners.length; i++) assertTrue(v.isOwner(owners[i]), "owners fixed by the address");
        try msFactory.create(owners, 2, bytes32(uint256(7))) returns (address) {
            assertTrue(false, "a second create of the same config must fail");
        } catch {}
    }

    function testDifferentConfigDifferentAddress() public view {
        address[] memory owners = _owners();
        assertTrue(msFactory.predict(owners, 2, bytes32(uint256(7))) != msFactory.predict(owners, 1, bytes32(uint256(7))), "threshold is part of the address");
        assertTrue(msFactory.predict(owners, 2, bytes32(uint256(7))) != msFactory.predict(owners, 2, bytes32(uint256(8))), "nonce is part of the address");
    }

    function testApprovalIsBoundToContent() public {
        uint256 id = _propose(0, _pay(bob, 1 ether));
        (bool ok, bytes memory ret) = _try(1, address(vault), abi.encodeCall(KeyLabMultisig.approve, (id, keccak256("other"))));
        assertTrue(!ok && _innerError(ret) == KeyLabMultisig.CallsMismatch.selector, "approval for different content refused");
    }

    function testFactoryRecordsItsVaults() public view {
        assertTrue(msFactory.isVault(address(vault)), "factory vault recorded");
        assertTrue(!msFactory.isVault(address(acc[0])), "other addresses are not vaults");
    }

    function testNonCanonicalSetOwnersRefused() public {
        address[] memory honest = new address[](2);
        honest[0] = address(acc[0]);
        honest[1] = address(acc[1]);
        address[] memory evil = new address[](1);
        evil[0] = address(acc[2]);
        bytes memory data = abi.encodePacked(KeyLabMultisig.setOwners.selector, uint256(0xa0), uint256(1), uint256(2), uint256(uint160(honest[0])), uint256(uint160(honest[1])), uint256(1), uint256(uint160(evil[0])));
        KeyLabMultisig.Call[] memory c = new KeyLabMultisig.Call[](1);
        c[0] = KeyLabMultisig.Call({to: address(vault), value: 0, data: data});
        uint256 id = _propose(0, c);
        _as(1, address(vault), abi.encodeCall(KeyLabMultisig.approve, (id, _hash(id))), "");
        (bool ok, bytes memory ret) = _try(1, address(vault), abi.encodeCall(KeyLabMultisig.execute, (id, c)));
        assertTrue(!ok && _innerError(ret) == KeyLabMultisig.CallFailed.selector, "smuggled owner list refused");
        assertTrue(vault.isOwner(address(acc[0])) && vault.isOwner(address(acc[1])) && vault.getOwners().length == 3, "owners unchanged");
    }
}

