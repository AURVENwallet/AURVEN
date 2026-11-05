pragma solidity 0.8.33;
import {BscTestAccount} from "../src/BscTestAccount.sol";

interface ChainVm { function chainId(uint256 id) external; }
contract NetworkTest {
    ChainVm constant vm = ChainVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    function testTestnet() public {
        vm.chainId(97);
        require(address(new BscTestAccount(0, bytes16(uint128(1)))).code.length > 0);
    }
    function testMainnetBlocked() public {
        vm.chainId(56);
        try new BscTestAccount(0, 0) { revert("accepted"); }
        catch (bytes memory reason) {
            require(keccak256(reason) == keccak256(abi.encodeWithSelector(BscTestAccount.UnsupportedNetwork.selector, uint256(56))));
        }
    }
}

