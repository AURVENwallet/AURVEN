import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {accountRpc} from '../ui/account-state.js';
import {accountCodeHash} from '../ui/contract-pin.js';
import {keccak256} from '../ui/lib/keccak.js';
import {encodeExecute, encodeRekey, execHasher, rekeyHasher, EXEC_LIMIT, PROOF_LEN,
  leftWord, rootFromProof, verifyCost, word} from '../ui/lib/evmwots.js';
import {pinnedRuntime} from './local-wallet-chain.mjs';

const hex = bytes => '0x'+Buffer.from(bytes).toString('hex');
const label = name => keccak256(new TextEncoder().encode('AURVEN public gas fixture v1/'+name));
const account = hex(label('account').slice(12));
const recipient = hex(label('recipient').slice(12));
const seed = label('seed').slice(0,16);
const newSeed = label('next seed').slice(0,16);
const newRoot = label('next root').slice(0,16);
const rnd = label('randomizer').slice(0,16);
const proof = Uint8Array.from({length:PROOF_LEN}, (_,i) => 1+(i%255));
const rootSelector = hex(keccak256(new TextEncoder().encode('root()')).slice(0,4));
const quantity = value => typeof value === 'string' && /^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(value);
const defaultEndpoint = 'https://bsc-testnet.bnbchain.org';

// These roots are reconstructed from public fixture bytes and installed only for a single RPC call.
// Each operation starts from its own synthetic storage. No wallet seed or signature is needed.
async function estimateOperation(rpc, block, runtime, leaf, digest, calldata) {
  const root = rootFromProof(seed, leaf, digest, proof);
  const overrides = {[account]: {code:runtime, balance:'0xde0b6b3a7640000', stateDiff:{
    [hex(word(0))]: hex(root)+hex(seed).slice(2),
    [hex(word(1))]: hex(word(1n<<32n))
  }}};
  const readRoot = await rpc('eth_call',[{to:account,data:rootSelector},block,overrides]);
  if (readRoot !== hex(leftWord(root))) throw new Error('RPC did not apply the expected code and storage overrides.');
  const params = [{to:account,data:hex(calldata)},block,overrides];
  const gas = await estimate(rpc,params);
  if (await rpc('eth_call',[{...params[0],gas},block,overrides]) !== '0x') throw new Error('Unexpected account execution result.');
  return {estimateGas:BigInt(gas).toString(), verificationHashSteps:verifyCost(digest)};
}

async function estimate(rpc, params) {
  const gas = await rpc('eth_estimateGas',params);
  if (!quantity(gas) || BigInt(gas)<=21000n) throw new Error('Missing or invalid contract gas estimate.');
  return gas;
}

async function checkEmpty(rpc, address, block) {
  const [code,balance,nonce] = await Promise.all([
    rpc('eth_getCode',[address,block]), rpc('eth_getBalance',[address,block]),
    rpc('eth_getTransactionCount',[address,block])
  ]);
  if (code!=='0x' || balance!=='0x0' || nonce!=='0x0') throw new Error('A public fixture address is in use.');
}

export async function measureTestnetGas(rpc, blockTag='latest') {
  if (await rpc('eth_chainId')!=='0x61') throw new Error('This benchmark requires BSC testnet chain ID 97.');
  if (blockTag!=='latest' && !quantity(blockTag)) throw new Error('Use latest or a hexadecimal block number.');
  const block = await rpc('eth_getBlockByNumber',[blockTag,false]);
  if (!block || !quantity(block.number) || !quantity(block.timestamp) || !/^0x[0-9a-f]{64}$/i.test(block.hash) ||
      (blockTag!=='latest' && BigInt(block.number)!==BigInt(blockTag))) throw new Error('Invalid block snapshot.');
  const runtime = await pinnedRuntime();
  const artifact = JSON.parse(await readFile(new URL('../out/BscTestAccount.sol/BscTestAccount.json',import.meta.url)));
  const init = artifact.bytecode.object+hex(leftWord(seed)).slice(2)+hex(leftWord(newRoot)).slice(2);
  await Promise.all([account,recipient].map(addr=>checkEmpty(rpc,addr,block.number)));
  const create = [{data:init},block.number];
  const deployment = await estimate(rpc,create);
  if (await rpc('eth_call',[{data:init,gas:deployment},block.number])!==runtime) throw new Error('Simulated deployment returned unexpected runtime.');
  const deadline = BigInt(block.timestamp)+600n;
  const calls = [{to:recipient,value:1n,data:new Uint8Array()}];
  const transfer = await estimateOperation(rpc,block.number,runtime,0,execHasher(rnd,97,account,1,0,deadline,calls)(0),
    encodeExecute(calls,0,deadline,0,rnd,proof));
  const rotation = await estimateOperation(rpc,block.number,runtime,EXEC_LIMIT,
    rekeyHasher(rnd,97,account,1,EXEC_LIMIT,deadline,newSeed,newRoot)(0),
    encodeRekey(newSeed,newRoot,EXEC_LIMIT,deadline,0,rnd,proof));
  const confirmed = await rpc('eth_getBlockByNumber',[block.number,false]);
  if (confirmed?.hash!==block.hash || await rpc('eth_chainId')!=='0x61') throw new Error('The chain snapshot changed. Retry.');
  return {chainId:97, blockNumber:block.number, blockHash:block.hash, blockTime:new Date(Number(BigInt(block.timestamp))*1000).toISOString(),
    runtimeHash:accountCodeHash, deployment:{estimateGas:BigInt(deployment).toString()}, transfer, rotation};
}

if (process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  try {
    const report = await measureTestnetGas(accountRpc(process.argv[2] || defaultEndpoint),process.argv[3]);
    console.log(JSON.stringify(report,null,2));
  } catch (error) {
    console.error('Read-only benchmark failed:',error.message);
    process.exitCode=1;
  }
}
