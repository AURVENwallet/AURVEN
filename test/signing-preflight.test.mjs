import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {verifyNetworkPlanState} from '../ui/signing-preflight.js';
import {readRecoveryAccount} from '../ui/backup-recovery.js';
import {secondaryTestnet} from '../ui/testnet-heads.js';
import {submitNetwork} from '../ui/network-account.js';
import {createdAddress} from '../ui/browser-trial.js';
import {keccak256} from '../ui/lib/keccak.js';

const primary='https://first.test',secondary='https://second.test';
const addr=n=>'0x'+n.repeat(40);
const word=n=>'0x'+BigInt(n).toString(16).padStart(64,'0');
const getter=name=>'0x'+Buffer.from(keccak256(new TextEncoder().encode(name))).toString('hex').slice(0,8);
const bytecode=JSON.parse(readFileSync(new URL('../out/BscTestAccount.sol/BscTestAccount.json',import.meta.url))).deployedBytecode.object;
const plan={id:'preview',walletId:'test',kind:'send',chainId:97,payer:addr('1'),account:addr('2'),recipient:addr('3'),
  nonce:'0x4',value:'0x0',gas:'0xaae60',gasPrice:'0x1',deadline:Math.floor(Date.now()/1000)+600};
const root=getter('root()'),next=getter('next()');
function environment(t,peerOrigin=secondary) {
  const control={mode:'normal'},requests=[];
  const stamp=Math.floor(Date.now()/1000);
  t.mock.method(globalThis,'fetch',async(url,o)=>{
    const peer=url.startsWith(peerOrigin),{id,method,params}=JSON.parse(o.body);
    requests.push({peer,method,params});
    if (peer && control.mode==='down') throw new TypeError('offline');
    let result;
    switch (method) {
      case 'eth_chainId': result=peer&&control.mode==='wrongChain'?'0x38':'0x61';break;
      case 'eth_getBlockByNumber': {
        const number=params[0]==='latest'?(peer?'0xf':'0xe'):params[0];
        result={number,hash:word(peer&&control.mode==='fork'?91:BigInt(number)),
          timestamp:'0x'+(stamp-(number==='0xe'?1:0)-(control.mode==='old'?45:0)).toString(16)};
        break;
      }
      case 'eth_getTransactionCount':
        result=params[0]===plan.payer?(peer && control.mode==='pending' && params[1]==='pending'?'0x5':'0x4'):
          (peer && control.mode==='occupied'?'0x1':'0x0');break;
      case 'eth_getCode': result=params[0]===plan.account?(peer && control.mode==='code'?'0x00':bytecode):'0x';break;
      case 'eth_getBalance':
        result=params[0]===plan.payer?'0x1000000':(peer && control.mode==='balance'?'0x7':'0x8');break;
      case 'eth_call': {
        const selector=params[0].data;
        if (selector===next) result=word(peer && control.mode==='newer' && params[1]==='0xf'?2:1);
        else if (selector===root) result='0x'+(peer && control.mode==='root'?'11':'ee').repeat(16)+'00'.repeat(16);
        else if (selector===getter('pubSeed()')) result='0x'+'33'.repeat(16)+'00'.repeat(16);
        else {assert.equal(selector,getter('epoch()'));result=word(2);}
        break;
      }
      default:assert.fail('Unexpected RPC '+method);
    }
    return Response.json({jsonrpc:'2.0',id,result});
  });
  return {control,requests};
}
const read=p=>verifyNetworkPlanState(p,primary,secondary);
test('backup recovery checks the same block, bytecode, keys and balance on both built-in testnet nodes',async t=>{
  const {control,requests}=environment(t,secondaryTestnet);
  const read=()=>readRecoveryAccount({account:plan.account,signal:new AbortController().signal});
  const result=await read();
  assert.deepEqual([result.blockNumber,result.epoch,result.next,result.balanceWei],['0xe',2,1,'8']);
  for(const peer of [false,true])assert.ok(requests.some(r=>r.peer===peer && r.method==='eth_getCode' && r.params[1]==='0xe'));
  for(const [mode,error] of [['down','RECOVERY_NODES'],['wrongChain','RECOVERY_NODES'],['fork','RECOVERY_CONFLICT'],
    ['code','RECOVERY_ACCOUNT'],['root','RECOVERY_CONFLICT'],['balance','RECOVERY_CONFLICT']]){
    control.mode=mode;await assert.rejects(read(),e=>e.code===error);
  }
  assert.ok(requests.every(r=>['eth_chainId','eth_getBlockByNumber','eth_call','eth_getCode','eth_getBalance'].includes(r.method)));
});
test('signing preview binds both sources to a shared block and checks the faster head for advanced keys',async t=>{
  const {control,requests}=environment(t);
  const result=await read(plan);
  assert.deepEqual(result.reviewBlock,{number:'0xe',hash:word(14)});
  assert.deepEqual([result.snapshot.epoch,result.snapshot.next,result.snapshot.balanceWei],[2,1,'8']);
  for (const peer of [false,true]) assert.ok(requests.some(r=>r.peer===peer && r.method==='eth_call' && r.params[1]==='0xe'));
  assert.ok(requests.some(r=>r.peer && r.method==='eth_call' && r.params[1]==='0xf'));
  control.mode='newer';await assert.rejects(read({...plan,...result}),/DRAFT_STALE/);
  control.mode='normal';await assert.rejects(read({...plan,...result,reviewBlock:{number:'0xc',hash:word(111)}}),/DRAFT_STALE/);
});
test('missing nodes, stale heads, forks, changed keys, bytecode, balance and payer nonces block signing',async t=>{
  const {control}=environment(t);
  for (const [mode,error] of [['down','NET_PREFLIGHT_UNAVAILABLE'],['wrongChain','NET_PREFLIGHT_UNAVAILABLE'],
    ['old','NET_PREFLIGHT_UNAVAILABLE'],['fork','NET_PREFLIGHT_FORK'],['code','NET_PREFLIGHT_UNAVAILABLE'],
    ['root','NET_PREFLIGHT_STATE'],['balance','NET_PREFLIGHT_STATE'],['pending','TRIAL_NONCE']]) {
    control.mode=mode;await assert.rejects(read(plan),new RegExp(error));
  }
  await assert.rejects(verifyNetworkPlanState(plan,primary,primary),/NET_SOURCES/);
});
test('both predicted deployment addresses must still be free and derived from the reviewed payer nonce',async t=>{
  const {control}=environment(t);
  const wrapper=createdAddress(plan.payer,plan.nonce),account=createdAddress(wrapper,1);
  const create={...plan,account,wrapper,kind:'create',gas:'0x249f00',value:'0x3',recipient:plan.payer};
  assert.equal((await read(create)).snapshot,null);
  control.mode='occupied';await assert.rejects(read(create),/NET_SETUP_OCCUPIED/);
  await assert.rejects(read({...create,account:addr('4')}),/NET_PLAN/);
});
test('a conflict before authorization or after proof release cannot open the payer wallet',async t=>{
  const {control}=environment(t);
  const reviewed={...plan,...await read(plan)};
  let saved=null,authorizations=0;
  const store={read:async()=>structuredClone(saved),create:async x=>{saved=structuredClone(x);},
    compareAndSwap:async(before,after)=>{assert.deepEqual(before,saved);saved=structuredClone(after);}};
  const provider={request:async({method})=>{
    if(method==='eth_chainId')return '0x61';
    assert.equal(method,'eth_accounts','A blocked action must never request a payment');return [plan.payer];
  }};
  const submit=()=>submitNetwork({endpoint:primary,secondary,provider,store,plan:reviewed,walletId:()=>plan.walletId,
    authorize:async()=>{authorizations++;control.mode='fork';return {data:'0x01',intent:{}};}});
  control.mode='root';await assert.rejects(submit(),/NET_PREFLIGHT_STATE/);
  assert.equal(authorizations,0);assert.equal(saved,null);
  control.mode='normal';await assert.rejects(submit(),/NET_PREFLIGHT_FORK/);
  assert.equal(authorizations,1);assert.equal(saved.rows[0].status,'stopped');assert.equal(saved.rows[0].leafReserved,true);
});
