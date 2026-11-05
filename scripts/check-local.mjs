import assert from 'node:assert/strict';
import {readAccount} from '../ui/account-state.js';
import {prepareTransfer} from '../ui/transfer.js';
import {keccak256} from '../ui/lib/keccak.js';
import {concat, word, leftWord, encodeCalls} from '../ui/lib/evmwots.js';

// Read-only integration check against an already deployed local test account.
const account = process.argv[2];
const endpoint = 'http://127.0.0.1:8950';
const state = await readAccount({endpoint, account, chainId: 31337});
assert.equal(state.epoch, 0);
assert.equal(state.ready, false);
const recipient = '0x' + '22'.repeat(20);
const randomizer = new Uint8Array(16);
const deadline = state.timestamp + 600;
// execDigest is public and can be checked before bootstrap, at epoch zero.
const encoded = concat(
  keccak256(new TextEncoder().encode('execDigest((address,uint256,bytes)[],uint32,uint64,uint32,bytes16)')).slice(0, 4),
  word(160), word(0), word(deadline), word(0), leftWord(randomizer),
  encodeCalls([{to: recipient, value: 1n, data: new Uint8Array()}])
);
const response = await fetch(endpoint, {method: 'POST', headers: {'Content-Type': 'application/json'},
  body: JSON.stringify({jsonrpc: '2.0', id: 1, method: 'eth_call',
    params: [{to: account, data: '0x' + Buffer.from(encoded).toString('hex')}, state.blockNumber]})});
const result = await response.json();
assert.equal(result.error, undefined);
const {execHasher} = await import('../ui/lib/evmwots.js');
const expected = execHasher(randomizer, 31337, account, 0, 0, deadline,
  [{to: recipient, value: 1n, data: new Uint8Array()}])(0);
assert.equal(result.result.slice(2, 34), Buffer.from(expected).toString('hex'));
assert.throws(() => prepareTransfer({account, recipient, amount: '1', chainId: 31337,
  epoch: state.epoch, leaf: state.next, deadline, randomizer}));
console.log('PASS: deployed runtime, account snapshot, bootstrap gate, Solidity / JS digest match');

