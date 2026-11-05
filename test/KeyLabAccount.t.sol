pragma solidity 0.8.33;

import {Asserts, MockToken} from "./Harness.sol";
import {Signer} from "./Signer.sol";
import {Wots} from "../src/Wots.sol";
import {KeyLabAccount} from "../src/KeyLabAccount.sol";
import {KeyLabFactory} from "../src/KeyLabFactory.sol";

contract KeyLabAccountTest is Asserts {
    KeyLabFactory factory;
    Signer identity;
    Signer signer;
    KeyLabAccount account;
    address payable bob = payable(address(0xB0B));
    bytes16 constant RND = bytes16(keccak256("rnd"));

    function setUp() public {
        vm.warp(1_800_000_000);
        factory = new KeyLabFactory();
        identity = new Signer(keccak256("test words"), bytes16(keccak256("pub seed")), 3);
        account = KeyLabAccount(payable(factory.create(identity.pubSeed(), identity.root())));
        vm.deal(address(account), 10 ether);
        signer = new Signer(keccak256("test words chain epoch 1"), bytes16(keccak256("pub seed 1")), 4);
        _rekey(identity, signer, 2, "bootstrap rekey, slot leaf 2, salt 0");
    }

    function _rekey(Signer from, Signer to, uint32 leaf, string memory label) internal {
        uint64 deadline = uint64(block.timestamp + 600);
        bytes16 digest = account.rekeyDigest(to.pubSeed(), to.root(), leaf, deadline, 0, RND);
        bytes memory proof = from.sign(leaf, digest);
        uint256 g = gasleft();
        account.rekey(to.pubSeed(), to.root(), leaf, deadline, 0, RND, proof);
        emit Gas(label, g - gasleft());
    }

    function _send(uint256 amount) internal pure returns (KeyLabAccount.Call[] memory calls) {
        calls = new KeyLabAccount.Call[](1);
        calls[0] = KeyLabAccount.Call({to: address(0xB0B), value: amount, data: ""});
    }

    function _grind(KeyLabAccount.Call[] memory calls, uint32 leaf, uint64 deadline, uint32 tries)
        internal
        view
        returns (uint32 best)
    {
        uint256 low = type(uint256).max;
        for (uint32 s; s < tries; ++s) {
            uint256 c = Wots.cost(this.digestOf(account, calls, leaf, deadline, s));
            if (c < low) {
                low = c;
                best = s;
            }
        }
    }

    function digestOf(KeyLabAccount acc, KeyLabAccount.Call[] calldata calls, uint32 leaf, uint64 deadline, uint32 salt)
        external
        view
        returns (bytes16)
    {
        return acc.execDigest(calls, leaf, deadline, salt, RND);
    }

    function _exec(KeyLabAccount.Call[] memory calls, uint32 leaf, uint32 salt, string memory label) internal {
        uint64 deadline = uint64(block.timestamp + 600);
        bytes16 digest = this.digestOf(account, calls, leaf, deadline, salt);
        bytes memory proof = signer.sign(leaf, digest);
        uint256 g = gasleft();
        account.execute(calls, leaf, deadline, salt, RND, proof);
        emit Gas(label, g - gasleft());
        emit Gas(string.concat(label, " calldata bytes"), abi.encodeCall(KeyLabAccount.execute, (calls, leaf, deadline, salt, RND, proof)).length);
        emit Gas(string.concat(label, " hash steps"), Wots.cost(digest));
    }

    function testFactoryAddressIsDeterministic() public view {
        assertTrue(factory.predict(identity.pubSeed(), identity.root()) == address(account), "predicted address");
        assertTrue(account.root() == signer.root(), "chain tree root stored after bootstrap");
        assertEq(account.epoch(), 1, "bootstrap moved to epoch 1");
    }

    function testBootstrapHasNoDeadline() public {
        KeyLabFactory f2 = new KeyLabFactory();
        KeyLabAccount fresh = KeyLabAccount(payable(f2.create(identity.pubSeed(), identity.root())));
        bytes16 digest = fresh.rekeyDigest(signer.pubSeed(), signer.root(), 2, 0, 0, RND);
        bytes memory proof = identity.sign(2, digest);
        vm.warp(block.timestamp + 365 days);
        fresh.rekey(signer.pubSeed(), signer.root(), 2, 0, 0, RND, proof);
        assertEq(fresh.epoch(), 1, "late bootstrap still lands");
        (bytes16 ps, bytes16 rt) = (signer.pubSeed(), signer.root());
        vm.expectRevert(KeyLabAccount.Expired.selector);
        fresh.rekey(ps, rt, 2, 0, 0, RND, proof);
    }

    function testLaterRekeyStillExpires() public {
        Signer next = new Signer(keccak256("test words chain epoch 2"), bytes16(keccak256("pub seed 2")), 1);
        uint64 deadline = uint64(block.timestamp + 600);
        bytes memory proof = signer.sign(0, account.rekeyDigest(next.pubSeed(), next.root(), 0, deadline, 0, RND));
        (bytes16 ps, bytes16 rt) = (next.pubSeed(), next.root());
        vm.warp(block.timestamp + 601);
        vm.expectRevert(KeyLabAccount.Expired.selector);
        account.rekey(ps, rt, 0, deadline, 0, RND, proof);
    }

    function testReceivesNftsSafely() public view {
        assertTrue(account.onERC721Received(address(1), address(2), 3, "") == bytes4(0x150b7a02), "erc721 hook");
        assertTrue(account.onERC1155Received(address(1), address(2), 3, 4, "") == bytes4(0xf23a6e61), "erc1155 hook");
        assertTrue(account.onERC1155BatchReceived(address(1), address(2), new uint256[](0), new uint256[](0), "") == bytes4(0xbc197c81), "erc1155 batch hook");
        assertTrue(account.supportsInterface(0x150b7a02) && account.supportsInterface(0x4e2312e0) && account.supportsInterface(0x01ffc9a7), "erc165");
        assertTrue(!account.supportsInterface(0xffffffff), "erc165 rejects 0xffffffff");
    }

    function testExecuteFromIdentityTreeIsRejected() public {
        KeyLabFactory f2 = new KeyLabFactory();
        KeyLabAccount fresh = KeyLabAccount(payable(f2.create(identity.pubSeed(), identity.root())));
        KeyLabAccount.Call[] memory calls = _send(1 ether);
        uint64 deadline = uint64(block.timestamp + 600);
        bytes memory proof = identity.sign(0, this.digestOf(fresh, calls, 0, deadline, 0));
        vm.expectRevert(KeyLabAccount.NeedsRekey.selector);
        fresh.execute(calls, 0, deadline, 0, RND, proof);
    }

    function testSendEthWithoutGrinding() public {
        _exec(_send(1 ether), 0, 0, "execute, salt 0");
        assertEq(bob.balance, 1 ether, "bob got 1 ether");
        assertEq(account.next(), 1, "counter moved");
    }

    function testSendEthGround() public {
        KeyLabAccount.Call[] memory calls = _send(1 ether);
        uint64 deadline = uint64(block.timestamp + 600);
        uint32 salt = _grind(calls, 0, deadline, 4096);
        _exec(calls, 0, salt, "execute, ground over 4096 salts");
        assertEq(bob.balance, 1 ether, "bob got 1 ether");
    }

    function testLeafCannotBeReused() public {
        KeyLabAccount.Call[] memory calls = _send(1 ether);
        uint64 deadline = uint64(block.timestamp + 600);
        bytes16 digest = this.digestOf(account, calls, 0, deadline, 0);
        bytes memory proof = signer.sign(0, digest);
        account.execute(calls, 0, deadline, 0, RND, proof);
        vm.expectRevert(KeyLabAccount.LeafUsed.selector);
        account.execute(calls, 0, deadline, 0, RND, proof);
    }

    function testTamperedCallIsRejected() public {
        KeyLabAccount.Call[] memory calls = _send(1 ether);
        uint64 deadline = uint64(block.timestamp + 600);
        bytes memory proof = signer.sign(0, this.digestOf(account, calls, 0, deadline, 0));
        calls[0].value = 5 ether;
        vm.expectRevert(KeyLabAccount.BadSignature.selector);
        account.execute(calls, 0, deadline, 0, RND, proof);
    }

    function testOtherChainIsRejected() public {
        KeyLabAccount.Call[] memory calls = _send(1 ether);
        uint64 deadline = uint64(block.timestamp + 600);
        bytes memory proof = signer.sign(0, this.digestOf(account, calls, 0, deadline, 0));
        vm.chainId(8453);
        vm.expectRevert(KeyLabAccount.BadSignature.selector);
        account.execute(calls, 0, deadline, 0, RND, proof);
    }

    function testExpiredIsRejected() public {
        KeyLabAccount.Call[] memory calls = _send(1 ether);
        uint64 deadline = uint64(block.timestamp + 600);
        bytes memory proof = signer.sign(0, this.digestOf(account, calls, 0, deadline, 0));
        vm.warp(block.timestamp + 601);
        vm.expectRevert(KeyLabAccount.Expired.selector);
        account.execute(calls, 0, deadline, 0, RND, proof);
    }

    function testDeadlineTooFarAheadIsRejected() public {
        KeyLabAccount.Call[] memory calls = _send(1 ether);
        uint64 deadline = uint64(block.timestamp + 2 hours);
        bytes memory proof = signer.sign(0, this.digestOf(account, calls, 0, deadline, 0));
        vm.expectRevert(KeyLabAccount.TooFarAhead.selector);
        account.execute(calls, 0, deadline, 0, RND, proof);
    }

    function testWrongLeafProofIsRejected() public {
        KeyLabAccount.Call[] memory calls = _send(1 ether);
        uint64 deadline = uint64(block.timestamp + 600);
        bytes memory proof = signer.sign(1, this.digestOf(account, calls, 0, deadline, 0));
        vm.expectRevert(KeyLabAccount.BadSignature.selector);
        account.execute(calls, 0, deadline, 0, RND, proof);
    }

    function testTokenTransfer() public {
        MockToken token = new MockToken();
        token.mint(address(account), 1000);
        KeyLabAccount.Call[] memory calls = new KeyLabAccount.Call[](1);
        calls[0] = KeyLabAccount.Call({to: address(token), value: 0, data: abi.encodeCall(MockToken.transfer, (bob, 250))});
        _exec(calls, 0, 0, "token transfer, salt 0");
        assertEq(token.balanceOf(bob), 250, "bob got tokens");
    }

    function testSkipsAheadAndOldLeafDies() public {
        _exec(_send(1 ether), 2, 0, "execute leaf 2");
        KeyLabAccount.Call[] memory calls = _send(1 ether);
        uint64 deadline = uint64(block.timestamp + 600);
        bytes memory proof = signer.sign(1, this.digestOf(account, calls, 1, deadline, 0));
        vm.expectRevert(KeyLabAccount.LeafUsed.selector);
        account.execute(calls, 1, deadline, 0, RND, proof);
    }

    function testRekeyMovesToNewTreeAndKeepsAddress() public {
        Signer next = new Signer(keccak256("test words chain epoch 2"), bytes16(keccak256("pub seed 2")), 2);
        _rekey(signer, next, 0, "rekey, salt 0");
        assertEq(account.epoch(), 2, "epoch moved");
        assertEq(account.next(), 0, "counter reset");
        signer = next;
        _exec(_send(1 ether), 0, 0, "execute after rekey");
        assertEq(bob.balance, 1 ether, "paid from the new tree");
    }
}

