import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {once} from 'node:events';
import {setTimeout as wait} from 'node:timers/promises';
import {Worker} from 'node:worker_threads';
import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {startLocalNode} from './local-wallet-chain.mjs';
import {isolatedVault} from './lost-device-signer.mjs';
import {accountRpc} from '../ui/account-state.js';
import {createdAddress} from '../ui/browser-trial.js';
import {ACCOUNT_INIT} from '../ui/lib/evmcode.js';
import {addressWord,word,leftWord,dynBytes,concat} from '../ui/lib/evmwots.js';
import {keccak256} from '../ui/lib/keccak.js';

const hex=b=>'0x'+Buffer.from(b).toString('hex');
const hash=s=>keccak256(new TextEncoder().encode(s));
const selector=s=>hash(s).slice(0,4);
const randomAddress=()=>hex(randomBytes(20));
const tag=hash('aurven/local/standby-recovery/v1');

function startDevice(options){
  const worker=new Worker(new URL('./lost-device-signer.mjs',import.meta.url),{workerData:options});
  const ready=once(worker,'message').then(([message])=>message);
  const stopped=new Promise(resolve=>worker.once('exit',resolve));
  async function request(deadline,receiptHash){
    const result=once(worker,'message');
    worker.postMessage({deadline,receiptHash});
    const [message]=await result;
    return message;
  }
  return {ready,request,close:()=>worker.terminate(),async signLastPayment(deadline,receiptHash){
    const message=await request(deadline,receiptHash);
    assert.ok(!message.refused,'Device refused payment');
    assert.equal(await stopped,0);
    return message;
  }};
}

export async function rehearseDeviceLoss(){
  const node=await startLocalNode(),devices=[];
  try{
    const rpc=accountRpc(node.endpoint);
    assert.equal(await rpc('eth_chainId'),'0x7a69');
    assert.match(await rpc('web3_clientVersion'),/^anvil\b/i);
    const artifact=JSON.parse(await readFile(new URL('../out/LocalRecoveryVault.sol/LocalRecoveryVault.json',import.meta.url)));
    const payer=randomAddress(),relayer=randomAddress(),oldRecipient=randomAddress(),newRecipient=randomAddress();
    for(const from of [payer,relayer]){
      await rpc('anvil_impersonateAccount',[from]);
      await rpc('anvil_setBalance',[from,'0xde0b6b3a7640000']);
    }
    const original=createdAddress(payer,0),standby=createdAddress(payer,1),holder=createdAddress(payer,4);
    const send=async(tx,from=payer)=>{
      const id=await rpc('eth_sendTransaction',[{from,gas:'0x7a1200',...tx}]);
      let receipt;
      const end=Date.now()+30000;
      do {
        receipt=await rpc('eth_getTransactionReceipt',[id]);
        if(!receipt)await wait(100);
      } while(!receipt && Date.now()<end);
      assert.equal(receipt?.status,'0x1','Expected a mined successful local transaction');
      return receipt;
    };
    const call=(to,data,at='latest')=>rpc('eth_call',[{to,data,from:relayer},at]);
    const controller=(at='latest')=>call(holder,hex(selector('activeSigner()')),at);
    const rejects=(to,data,error)=>assert.rejects(call(to,data),e=>e.revertData?.toLowerCase()===hex(error));
    const time=async()=>Number(BigInt((await rpc('eth_getBlockByNumber',['latest',false])).timestamp));
    const source=startDevice({account:original,holder,recipient:oldRecipient,role:'original'});
    const receiver=startDevice({account:standby,holder,recipient:newRecipient,role:'standby',original,endpoint:node.endpoint});
    devices.push(source,receiver);
    const [first,second]=await Promise.all([source.ready,receiver.ready]);
    for(const [keys,address] of [[first,original],[second,standby]]){
      const init='0x'+ACCOUNT_INIT+hex(concat(leftWord(Buffer.from(keys.seed,'hex')),leftWord(Buffer.from(keys.root,'hex')))).slice(2);
      assert.equal((await send({data:init})).contractAddress,address);
    }
    await send({to:original,data:first.boot});await send({to:standby,data:second.boot});
    const code=randomBytes(32);
    const commitment=keccak256(tag,word(31337),addressWord(holder),addressWord(original),addressWord(standby),code);
    const args=concat(addressWord(original),addressWord(standby),commitment);
    assert.equal((await send({data:artifact.bytecode.object+hex(args).slice(2)})).contractAddress,holder);
    assert.equal(await controller(),hex(addressWord(original)));
    assert.equal(await call(holder,hex(selector('standbySigner()'))),hex(addressWord(standby)));
    assert.equal(await call(holder,hex(selector('commitment()'))),hex(commitment));
    assert.equal(await call(holder,hex(selector('standbyRoot()'))),hex(leftWord(Buffer.from(second.activeRoot,'hex'))));
    assert.equal(await call(holder,hex(selector('standbySeed()'))),hex(leftWord(Buffer.from(second.activeSeed,'hex'))));
    await send({to:holder,value:'0x3'});
    const deadline=await time()+1800;
    const old=await source.signLastPayment(deadline); // Worker exited; only the earlier encrypted export and signed bytes remain.
    assert.equal(await call(original,old.data),'0x');
    const {vault:restored}=isolatedVault();
    try{
      await restored.restoreBackup(first.backup,first.password);
      assert.equal(restored.details.mode,'recovery-readonly');
      assert.equal(restored.details.reservations,1); // Snapshot predates the second reservation.
      await assert.rejects(restored.reserveLeaf(old.entry),e=>e.code==='RECOVERY');
    }finally{restored.lock();}

    const recover=hex(concat(selector('recover(bytes32)'),code));
    const otherCode=Buffer.from(code);otherCode[0]^=1;
    await rejects(holder,hex(concat(selector('recover(bytes32)'),otherCode)),selector('InvalidCode()'));
    const fork=await rpc('evm_snapshot');
    const orphan=await send({to:holder,data:recover},relayer);
    assert.deepEqual(await receiver.request(deadline,orphan.transactionHash),{refused:true,reservations:1});
    assert.equal(await controller(),hex(addressWord(standby)));
    assert.equal(await rpc('evm_revert',[fork]),true);
    assert.equal(await controller(),hex(addressWord(original)));
    assert.equal(await call(original,old.data),'0x'); // Valid again on the reverted branch. Never submitted.
    assert.deepEqual(await receiver.request(deadline,orphan.transactionHash),{refused:true,reservations:1});
    const takeover=await send({to:holder,data:recover},payer);
    await rpc('anvil_mine',['0x50','0x1']);
    const finalized=await rpc('eth_getBlockByNumber',['finalized',false]);
    assert.ok(BigInt(finalized.number)>=BigInt(takeover.blockNumber));
    const canonical=await rpc('eth_getBlockByNumber',[takeover.blockNumber,false]);
    assert.equal(canonical.hash,takeover.blockHash);
    assert.equal(await controller(finalized.number),hex(addressWord(standby)));
    assert.equal(await call(holder,hex(selector('commitment()')),finalized.number),hex(word(0)));
    await rejects(holder,recover,selector('AlreadyRecovered()'));
    const inner=selector('InactiveSigner()');
    const nested=concat(selector('CallFailed(uint256,bytes)'),word(0),word(64),dynBytes(inner));
    assert.ok(await time()<deadline,'Old authorization must still be unexpired');
    await rejects(original,old.data,nested);
    assert.equal(await call(original,hex(selector('next()'))),hex(word(0)));
    const next=await receiver.signLastPayment(await time()+600,takeover.transactionHash);
    const payment=await send({to:standby,data:next.data});
    const balance=async address=>BigInt(await rpc('eth_getBalance',[address,'latest'])).toString();
    const balances=[await balance(holder),await balance(oldRecipient),await balance(newRecipient)];
    assert.deepEqual(balances,['2','0','1']);
    assert.equal(await call(standby,hex(selector('next()'))),hex(word(1)));
    return {chainId:31337,holder,takeoverBlock:Number(BigInt(takeover.blockNumber)),finalizedCheck:Number(BigInt(finalized.number)),
      recoveryReceipt:takeover.transactionHash,paymentReceipt:payment.transactionHash,originalWorkerExited:true,restoredMode:'recovery-readonly',
      rejectedOldAuthorization:true,standbyBlockedBeforeFinality:true,rollbackRehearsed:true,holderWei:balances[0],oldRecipientWei:balances[1],newRecipientWei:balances[2]};
  }finally{
    try{await Promise.all(devices.map(device=>device.close()));}finally{await node.close();}
  }
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href){
  console.log(JSON.stringify(await rehearseDeviceLoss(),null,2));
}
