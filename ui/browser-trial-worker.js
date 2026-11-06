import {buildTrialData} from './browser-trial-sign.js';
import {openTrialStore,spendTrialLeaf} from './browser-trial-store.js';

self.onmessage=async ({data:{id,type,payload:plan}})=>{
  self.onmessage=null;
  let store;
  try {
    if (type!=='trial') throw new Error('TRIAL_DATA');
    store=await openTrialStore();
    const response=await fetch(new URL('./assets/browser-trial-init.json',import.meta.url),{redirect:'error'});
    if (!response.ok) throw new Error('TRIAL_DATA');
    const result=await buildTrialData(plan,await response.json(),row=>spendTrialLeaf(store,plan.id,row),
      progress=>self.postMessage({id,progress}));
    self.postMessage({id,result});
  } catch(error) {self.postMessage({id,error:error.code??error.message});}
  finally {store?.close();self.close();}
};
