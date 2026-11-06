import {openVaultStore} from './vault-store.js';
import {requireTrial} from './browser-trial.js';

export const openTrialStore=()=>openVaultStore('aurven-browser-trial-v1');
export async function startTrial(store,plan) {
  const current=await store.read(), rows=current?.rows??[];
  requireTrial(rows.length<32,'TRIAL_FULL');
  requireTrial(!rows.some(row=>row.id===plan.id || (row.payer===plan.payer && row.nonce===plan.nonce &&
    ['preparing','requested','waiting'].includes(row.status) && Date.now()/1000<row.deadline)),'TRIAL_IN_USE');
  const next={rows:[...rows,{...plan,status:'preparing',reservations:[]}]};
  if (current) await store.compareAndSwap(current,next);else await store.create(next);
}
export async function updateTrial(store,id,update) {
  const current=await store.read(), index=current?.rows.findIndex(row=>row.id===id)??-1;
  requireTrial(index>=0,'TRIAL_STORAGE');
  const row=update(current.rows[index]);
  const next={rows:current.rows.with(index,row)};
  await store.compareAndSwap(current,next);return row;
}
export function spendTrialLeaf(store,id,reservation) {
  return updateTrial(store,id,row=>{
    requireTrial(row.status==='preparing' && row.reservations.length<2 &&
      reservation.leaf===(row.reservations.length===0?8:0),'TRIAL_STORAGE');
    return {...row,reservations:[...row.reservations,reservation]};
  });
}
