import {HASH} from './activity-rpc.js';
import {checkBeforeSend,hashBytes,requireTrial} from './browser-trial.js';
import {startTrial,updateTrial} from './browser-trial-store.js';

export async function submitTrial({store,plan,rpc,provider,build}) {
  await checkBeforeSend(rpc,provider,plan);
  await startTrial(store,plan);
  let requested=false;
  try {
    const {data,digest}=await build(plan);
    await checkBeforeSend(rpc,provider,plan);
    await updateTrial(store,plan.id,row=>{
      requireTrial(row.status==='preparing' && row.reservations.length===2 &&
        '0x'+row.reservations[1].digest===digest,'TRIAL_STORAGE');
      return {...row,status:'requested',dataHash:hashBytes(data),digest};
    });
    requested=true;
    const tx={from:plan.payer,chainId:'0x61',nonce:plan.nonce,gas:plan.gas,gasPrice:plan.gasPrice,value:'0x1',data};
    const hash=await provider.request({method:'eth_sendTransaction',params:[tx]});
    requireTrial(typeof hash==='string' && HASH.test(hash),'TRIAL_REPLY');
    return await updateTrial(store,plan.id,row=>({...row,status:'waiting',hash:hash.toLowerCase()}));
  } catch (error) {
    if (!requested || error.code===4001) {
      await updateTrial(store,plan.id,row=>({...row,status:requested?'declined':'stopped'}));
    } else throw new Error('TRIAL_REPLY',{cause:error});
    throw error;
  }
}
