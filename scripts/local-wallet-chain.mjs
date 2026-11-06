import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {readFile} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import {accountRpc,readAccount} from '../ui/account-state.js';
import {accountCodeHash} from '../ui/contract-pin.js';
import {keccak256} from '../ui/lib/keccak.js';

export async function pinnedRuntime() {
  const artifact = JSON.parse(await readFile(new URL('../out/BscTestAccount.sol/BscTestAccount.json',import.meta.url)));
  const runtime = artifact.deployedBytecode.object;
  const hash = '0x'+Buffer.from(keccak256(Buffer.from(runtime.slice(2),'hex'))).toString('hex');
  if (hash !== accountCodeHash) throw new Error('Compiled account code differs from the wallet pin.');
  return runtime;
}

// Never accepts a caller-supplied RPC. The port comes from this child process.
export async function startLocalNode(origin, blockTime=0, chainId=31337) {
  if (![31337,97].includes(chainId)) throw new Error('Expected a local or testnet chain ID.');
  const args = ['--host','127.0.0.1','--port','0','--accounts','0','--chain-id',String(chainId),'--color','never'];
  if (origin) args.push('--allow-origin',origin);
  else args.push('--no-cors');
  if (blockTime) args.push('--block-time',String(blockTime));
  const child = spawn('anvil',args,{windowsHide:true,stdio:['ignore','pipe','ignore']});
  const stopped = new Promise(resolve=>{child.once('exit',resolve);child.once('error',resolve);});
  const stop = ()=>{child.kill();};
  // Also handle interruption while the launcher is still starting up.
  for (const event of ['SIGINT','SIGTERM','exit']) process.once(event,stop);
  stopped.then(()=>{for (const event of ['SIGINT','SIGTERM','exit']) process.off(event,stop);});
  try {
    const endpoint = await new Promise((resolve,reject)=>{
      const timer = setTimeout(()=>reject(new Error('Timed out starting Anvil.')),15000);
      const reader = createInterface({input:child.stdout});
      reader.on('line',line=>{
        const match = /^Listening on (127\.0\.0\.1:\d+)$/.exec(line.trim());
        if (match) {clearTimeout(timer);resolve('http://'+match[1]+'/');}
      });
      stopped.then(()=>{clearTimeout(timer);reject(new Error('Could not start Anvil. Check that Foundry is installed.'));});
    });
    return {endpoint,stopped,setupAccount:runtime=>setupLocalAccount(endpoint,runtime),close:()=>{stop();return stopped;}};
  } catch (error) {child.kill();throw error;}
}

async function setupLocalAccount(endpoint,runtime) {
  const rpc = accountRpc(endpoint);
  const account = '0x'+randomBytes(20).toString('hex'), pubSeed = '0x'+randomBytes(16).toString('hex');
  const zeroRoot = '0x'+'00'.repeat(16), word = value=>'0x'+BigInt(value).toString(16).padStart(64,'0');
  if (await rpc('eth_chainId') !== '0x7a69' || !/^anvil\b/i.test(await rpc('web3_clientVersion'))) throw new Error('Expected a disposable Anvil node.');
  await rpc('anvil_setCode',[account,runtime]);
  await rpc('anvil_setStorageAt',[account,word(0),zeroRoot+pubSeed.slice(2)]);
  await rpc('anvil_setStorageAt',[account,word(1),word(1n<<32n)]);
  await rpc('anvil_setBalance',[account,'0xde0b6b3a7640000']);
  await rpc('evm_mine');
  const read = ()=>readAccount({endpoint,account,chainId:31337});
  const initial = await read();
  if (initial.root!==zeroRoot || initial.pubSeed!==pubSeed || initial.epoch!==1 || initial.next!==0 ||
      initial.balanceWei!=='1000000000000000000') throw new Error('Local test account setup failed.');
  let selectedRoot, pending;
  async function install(root) {
    const state = await read();
    if (state.root===root) return;
    if (state.root!==zeroRoot || state.pubSeed!==pubSeed || state.next!==0 || state.epoch!==1) throw new Error('Local account changed.');
    await rpc('anvil_setStorageAt',[account,word(0),root+pubSeed.slice(2)]);
    await rpc('evm_mine');
    if ((await read()).root!==root) throw new Error('Could not verify the installed root.');
  }
  return {account,endpoint,recipient:'0x'+randomBytes(20).toString('hex'),async pair(root) {
    if (typeof root!=='string' || !/^0x[0-9a-f]{32}$/.test(root) || root===zeroRoot) throw new Error('Invalid root.');
    if (selectedRoot && selectedRoot!==root) throw new Error('Another root was already selected.');
    selectedRoot=root;
    // Retries can finish the same request, including after an ambiguous RPC response.
    pending ??= install(root).finally(()=>{pending=undefined;});
    await pending;
  }};
}
