import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {prepareTransfer} from '../ui/transfer.js';
import {readAccount, rpcEndpoint} from '../ui/account-state.js';
import {keccak256} from '../ui/lib/keccak.js';

const account = '0x' + '11'.repeat(20);
const params = {account, recipient: '0x' + '22'.repeat(20), amount: '0.000000000000000001',
  chainId: 97, epoch: 1, leaf: 0, deadline: 1800000600, randomizer: new Uint8Array(16)};

test('amount precision and canonical decimal input', () => {
  assert.equal(prepareTransfer(params).valueWei, '1');
  assert.equal(prepareTransfer({...params, amount: '1.23'}).valueWei, '1230000000000000000');
  for (const amount of ['0', '-1', '1e3', '01', '1x2', '1,2', '1.', '0.0000000000000000001']) {
    assert.throws(() => prepareTransfer({...params, amount}));
  }
});

test('digest binds all transaction authorization fields', () => {
  const original = prepareTransfer(params).digest;
  for (const changed of [{chainId: 31337}, {epoch: 2}, {leaf: 1}, {deadline: params.deadline + 1},
    {recipient: '0x' + '33'.repeat(20)}, {account: '0x' + '44'.repeat(20)}, {amount: '2'},
    {randomizer: new Uint8Array(16).fill(1)}]) {
    assert.notEqual(prepareTransfer({...params, ...changed}).digest, original);
  }
});

test('mainnet and reserved leaves cannot prepare transfers', () => {
  for (const changed of [{chainId: 56}, {leaf: 960}, {leaf: -1}, {epoch: 0}]) {
    assert.throws(() => prepareTransfer({...params, ...changed}));
  }
});

test('RPC URL rejects credential and nonlocal HTTP endpoints', () => {
  for (const url of ['http://example.com', 'https://user:password@example.com', 'file:///tmp/a']) {
    assert.throws(() => rpcEndpoint(url));
  }
  assert.equal(rpcEndpoint('http://127.0.0.1:8950'), 'http://127.0.0.1:8950/');
});

const artifact = JSON.parse(readFileSync(new URL('../out/BscTestAccount.sol/BscTestAccount.json', import.meta.url)));
const runtime = artifact.deployedBytecode.object;
const selector = name => '0x' + Buffer.from(keccak256(new TextEncoder().encode(name))).toString('hex').slice(0, 8);
const word = value => '0x' + BigInt(value).toString(16).padStart(64, '0');

function fakeRpc(t, changes = {}) {
  const requests = [];
  let blocks = 0;
  const values = {
    [selector('epoch()')]: word(changes.epoch ?? 1),
    [selector('next()')]: word(changes.next ?? 7),
    [selector('pubSeed()')]: '0x' + '11'.repeat(16) + '00'.repeat(16),
    [selector('root()')]: '0x' + '22'.repeat(16) + '00'.repeat(16)
  };
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    const request = JSON.parse(options.body);
    requests.push(request);
    const block = {number: '0xa', hash: word(changes.reorg && blocks > 0 ? 2 : 1),
      timestamp: '0x' + (Math.floor(Date.now() / 1000) - (changes.age ?? 0)).toString(16)};
    const results = {
      eth_chainId: changes.chain ?? '0x61', eth_getCode: changes.code ?? runtime,
      eth_getBalance: '0x1', eth_getBlockByNumber: block,
      eth_call: values[request.params[0]?.data]
    };
    if (request.method === 'eth_getBlockByNumber') blocks += 1;
    return {ok: true, json: async () => ({jsonrpc: '2.0', id: request.id, result: results[request.method]})};
  });
  return requests;
}
const read = () => readAccount({endpoint: 'http://127.0.0.1:8950', account, chainId: 97});

test('state is pinned to one block and code version', async t => {
  const requests = fakeRpc(t);
  const state = await read();
  assert.equal(state.ready, true);
  assert.equal(state.next, 7);
  for (const request of requests.filter(r => ['eth_getCode', 'eth_getBalance', 'eth_call'].includes(r.method))) {
    assert.equal(request.params[1], '0xa');
  }
});

for (const [name, change, error] of [
  ['wrong chain', {chain: '0x38'}, /链号/],
  ['undeployed address', {code: '0x'}, /尚未部署/],
  ['unexpected runtime', {code: '0x6000'}, /代码/],
  ['stale clock', {age: 300}, /时间/],
  ['reorganized block', {reorg: true}, /区块发生变化/],
  ['invalid leaf counter', {next: 1025}, /状态超出/]
]) {
  test('rejects ' + name, async t => {
    fakeRpc(t, change);
    await assert.rejects(read(), error);
  });
}
for (const [name, change] of [['bootstrap required', {epoch: 0}], ['tree exhausted', {next: 960}]]) {
  test(name + ' is visible but not ready', async t => {
    fakeRpc(t, change);
    assert.equal((await read()).ready, false);
  });
}

