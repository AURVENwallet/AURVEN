import {addressBytes} from './lib/evmwots.js';
import {keccak256} from './lib/keccak.js';
import {accountCodeHash} from './contract-pin.js';

const hex = bytes => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
const selector = name => '0x' + hex(keccak256(new TextEncoder().encode(name))).slice(0, 8);
const wordPattern = /^0x[0-9a-fA-F]{64}$/;

export function rpcEndpoint(value) {
  const url = new URL(value);
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.username || url.password || url.hash ||
      (url.protocol !== 'https:' && !(loopback && url.protocol === 'http:'))) {
    throw new Error('RPC 请使用 HTTPS，或本机 HTTP 地址；地址中不能包含登录凭据');
  }
  return url.href;
}

export async function readAccount({endpoint, account, chainId, signal}) {
  addressBytes(account);
  if (![97, 31337].includes(chainId)) throw new Error('仅支持 BSC 测试网和本地链');
  const url = rpcEndpoint(endpoint);
  let requestId = 0;
  async function rpc(method, params = []) {
    const id = ++requestId;
    const response = await fetch(url, {
      method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({jsonrpc: '2.0', id, method, params}),
      signal: AbortSignal.any([AbortSignal.timeout(12000), ...(signal ? [signal] : [])]),
      credentials: 'omit', redirect: 'error'
    });
    if (!response.ok) throw new Error('RPC 请求失败，请检查地址和跨域设置');
    const payload = await response.json();
    if (payload.id !== id || payload.jsonrpc !== '2.0' || payload.error || payload.result === undefined) {
      throw new Error('RPC 未返回有效结果（' + method + '）');
    }
    return payload.result;
  }
  if (await rpc('eth_chainId') !== '0x' + chainId.toString(16)) {
    throw new Error('RPC 链号与所选网络不同');
  }
  const block = await rpc('eth_getBlockByNumber', ['latest', false]);
  if (!block || !/^0x[0-9a-f]+$/i.test(block.number) || !wordPattern.test(block.hash) ||
      !/^0x[0-9a-f]+$/i.test(block.timestamp)) throw new Error('区块数据格式无效');
  const timestamp = Number(BigInt(block.timestamp));
  if (!Number.isSafeInteger(timestamp) || Math.abs(Date.now() / 1000 - timestamp) > 120) {
    throw new Error('链上时间与本机相差超过两分钟，请检查节点和系统时间');
  }
  const code = await rpc('eth_getCode', [account, block.number]);
  if (!/^0x(?:[0-9a-fA-F]{2})+$/.test(code)) throw new Error('该地址尚未部署智能账户');
  const codeHash = '0x' + hex(keccak256(Uint8Array.from(code.slice(2).match(/../g), b => parseInt(b, 16))));
  if (codeHash !== accountCodeHash) throw new Error('账户代码与本项目测试账户版本不符');
  const [balance, ...values] = await Promise.all([
    rpc('eth_getBalance', [account, block.number]),
    ...['epoch()', 'next()', 'pubSeed()', 'root()'].map(name =>
      rpc('eth_call', [{to: account, data: selector(name)}, block.number]))
  ]);
  if (!values.every(value => wordPattern.test(value)) || !/^0x[0-9a-f]+$/i.test(balance)) {
    throw new Error('账户状态格式无效');
  }
  const [epochWord, nextWord, seedWord, rootWord] = values;
  const epoch = Number(BigInt(epochWord));
  const next = Number(BigInt(nextWord));
  if (!Number.isInteger(epoch) || epoch > 4294967295 || !Number.isInteger(next) || next > 1024 ||
      !/^0x[0-9a-f]{32}0{32}$/i.test(seedWord) || !/^0x[0-9a-f]{32}0{32}$/i.test(rootWord)) {
    throw new Error('账户状态超出支持范围');
  }
  const confirmed = await rpc('eth_getBlockByNumber', [block.number, false]);
  if (confirmed?.hash !== block.hash) throw new Error('读取期间区块发生变化，请重新同步');
  return {
    account, chainId, epoch, next, pubSeed: seedWord.slice(0, 34), root: rootWord.slice(0, 34),
    balanceWei: BigInt(balance).toString(), blockNumber: block.number, blockHash: block.hash,
    timestamp, codeHash, ready: epoch > 0 && next < 960
  };
}

